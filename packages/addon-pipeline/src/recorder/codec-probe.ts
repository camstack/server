/**
 * codec-probe — derive the RFC 6381 codec string (`avc1.PPCCLL` /
 * `hev1.<profile>.<compat>.<tier><level>.<constraints>`) from a recorded fMP4
 * `.m4s` fragment's moov, so the master playlist can advertise `CODECS` and
 * hls.js drops variants the browser cannot decode (the silent-HEVC-VOD fix).
 *
 * Every recorded fragment is self-contained (own ftyp + moov with the
 * avcC/hvcC sample entry — see `segment-demux.ts`), and the moov sits at the
 * front, so probing a bounded file prefix (~64KB) is sufficient. Hand-rolled
 * box walker: addons are self-contained, so no mp4box dependency on the
 * server — the walker only needs the moov→trak→mdia→minf→stbl→stsd path.
 *
 * Pure and defensive: any malformed / truncated / unrecognized input returns
 * `undefined` (the playlist then simply omits `CODECS`, today's behaviour).
 */

/** One parsed box: its type and the payload window inside the buffer. */
interface BoxSlice {
  readonly type: string
  readonly payloadStart: number
  readonly payloadEnd: number
}

/** Iterate the boxes fully contained in `bytes[start, end)`. Stops at the
 *  first malformed or truncated box (the probe only needs the front boxes). */
function* boxes(bytes: Uint8Array, start: number, end: number): Generator<BoxSlice> {
  let off = start
  while (off + 8 <= end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + off)
    let size = view.getUint32(0)
    let headerLen = 8
    if (size === 1) {
      if (off + 16 > end) return
      const large = view.getBigUint64(8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return
      size = Number(large)
      headerLen = 16
    } else if (size === 0) {
      size = end - off // box extends to the end of the buffer
    }
    if (size < headerLen) return
    const boxEnd = off + size
    if (boxEnd > end) return // truncated by the bounded prefix read
    const type = String.fromCharCode(
      bytes[off + 4]!,
      bytes[off + 5]!,
      bytes[off + 6]!,
      bytes[off + 7]!,
    )
    yield { type, payloadStart: off + headerLen, payloadEnd: boxEnd }
    off = boxEnd
  }
}

/** First child box with `type` inside a payload window, or null. */
function findBox(bytes: Uint8Array, start: number, end: number, type: string): BoxSlice | null {
  for (const b of boxes(bytes, start, end)) if (b.type === type) return b
  return null
}

/** Descend a container-box path (`moov/trak/mdia/…`), or null when broken. */
function descend(bytes: Uint8Array, path: readonly string[]): BoxSlice | null {
  let start = 0
  let end = bytes.length
  let cur: BoxSlice | null = null
  for (const type of path) {
    cur = findBox(bytes, start, end, type)
    if (!cur) return null
    start = cur.payloadStart
    end = cur.payloadEnd
  }
  return cur
}

/** VisualSampleEntry fixed fields before its child boxes: 6 reserved + 2
 *  data_reference_index + 70 bytes (pre_defined/width/height/…/depth). */
const VISUAL_SAMPLE_ENTRY_FIXED_BYTES = 78

/** stsd FullBox payload head: version(1) + flags(3) + entry_count(4). */
const STSD_HEAD_BYTES = 8

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

/** `avc1.PPCCLL` from the avcC payload (profile, constraint flags, level). */
function avcCodecString(bytes: Uint8Array, avcC: BoxSlice): string | undefined {
  // avcC: configurationVersion(1), AVCProfileIndication(1),
  // profile_compatibility(1), AVCLevelIndication(1), …
  if (avcC.payloadEnd - avcC.payloadStart < 4) return undefined
  const p = avcC.payloadStart
  return `avc1.${hex2(bytes[p + 1]!)}${hex2(bytes[p + 2]!)}${hex2(bytes[p + 3]!)}`
}

/** Reverse the bit order of a 32-bit value (HEVC general_profile_compatibility
 *  flags are written MSB-first but the codec string wants them reversed). */
function reverseBits32(v: number): number {
  let out = 0
  for (let i = 0; i < 32; i++) {
    out = (out << 1) | ((v >>> i) & 1)
  }
  return out >>> 0
}

/** ISO/IEC 14496-15 Annex E HEVC codec string from the hvcC payload. The
 *  prefix is the SAMPLE ENTRY code (`hvc1` vs `hev1` — they differ in
 *  parameter-set placement, which players honour). */
function hevcCodecString(bytes: Uint8Array, entryType: string, hvcC: BoxSlice): string | undefined {
  // hvcC: configurationVersion(1), profile_space(2b)+tier(1b)+profile_idc(5b),
  // compat flags(4), constraint flags(6), level_idc(1), …
  if (hvcC.payloadEnd - hvcC.payloadStart < 13) return undefined
  const p = hvcC.payloadStart
  const byte1 = bytes[p + 1]!
  const profileSpace = (byte1 >> 6) & 0x03
  const tier = (byte1 >> 5) & 0x01
  const profileIdc = byte1 & 0x1f
  const compat = new DataView(bytes.buffer, bytes.byteOffset + p + 2).getUint32(0)
  const levelIdc = bytes[p + 12]!

  const spacePrefix = profileSpace === 0 ? '' : String.fromCharCode(0x40 + profileSpace) // A/B/C
  const compatHex = reverseBits32(compat).toString(16).toUpperCase()
  // Constraint bytes '.'-separated in order, trailing ZERO bytes omitted.
  let constraints = ''
  for (let i = 5; i >= 0; i--) {
    const b = bytes[p + 6 + i]!
    if (b !== 0 || constraints !== '') {
      constraints = `.${b.toString(16).toUpperCase().padStart(2, '0')}${constraints}`
    }
  }
  return `${entryType}.${spacePrefix}${profileIdc}.${compatHex}.${tier === 0 ? 'L' : 'H'}${levelIdc}${constraints}`
}

/** Sample-entry codes the probe recognizes, mapped to their config-box type. */
const VIDEO_SAMPLE_ENTRIES: Readonly<Record<string, 'avcC' | 'hvcC'>> = {
  avc1: 'avcC',
  avc3: 'avcC',
  hvc1: 'hvcC',
  hev1: 'hvcC',
}

/**
 * Walk an fMP4 fragment's moov for the first recognized video sample entry
 * (avc1/avc3 → avcC, hvc1/hev1 → hvcC) and build its RFC 6381 codec string.
 * Accepts a bounded PREFIX of the fragment (the moov leads the file). Returns
 * `undefined` for anything malformed, truncated, or unrecognized.
 */
export function codecStringFromFragment(bytes: Uint8Array): string | undefined {
  const moov = descend(bytes, ['moov'])
  if (!moov) return undefined
  // Check EVERY trak (audio traks precede video on some muxers).
  for (const trak of boxes(bytes, moov.payloadStart, moov.payloadEnd)) {
    if (trak.type !== 'trak') continue
    let cur: BoxSlice | null = trak
    for (const type of ['mdia', 'minf', 'stbl', 'stsd']) {
      cur = cur ? findBox(bytes, cur.payloadStart, cur.payloadEnd, type) : null
    }
    if (!cur) continue
    const entriesStart = cur.payloadStart + STSD_HEAD_BYTES
    for (const entry of boxes(bytes, entriesStart, cur.payloadEnd)) {
      const configType = VIDEO_SAMPLE_ENTRIES[entry.type]
      if (!configType) continue
      const childStart = entry.payloadStart + VISUAL_SAMPLE_ENTRY_FIXED_BYTES
      const config = findBox(bytes, childStart, entry.payloadEnd, configType)
      if (!config) continue
      const codec =
        configType === 'avcC'
          ? avcCodecString(bytes, config)
          : hevcCodecString(bytes, entry.type, config)
      if (codec) return codec
    }
  }
  return undefined
}
