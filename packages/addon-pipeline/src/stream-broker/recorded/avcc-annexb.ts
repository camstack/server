/**
 * avcc-annexb — pure byte helpers to turn an ISO-BMFF (mp4) length-prefixed
 * video sample plus its `avcC`/`hvcC` decoder config into an Annex-B access
 * unit with the parameter sets prepended (SPS/PPS for H.264, VPS/SPS/PPS for
 * H.265).
 *
 * mp4 stores VCL NALs length-prefixed (AVCC/HVCC: a 1–4 byte big-endian length
 * field, `lengthSizeMinusOne+1`, before each NAL) and keeps the parameter sets
 * OUT of the samples, inside the `avcC`/`hvcC` box. A raw decoder / RTP
 * packetizer needs Annex-B start codes (`00 00 00 01`) AND the parameter sets
 * fused onto every IDR. These helpers do exactly that in JS — no ffmpeg, no
 * decode, byte copies only — so the feeder-scrub keyframe path can skip the
 * per-fragment ffmpeg spawn.
 *
 * All functions are pure and total for well-formed input; malformed config /
 * sample bytes throw a `RangeError` (the caller treats a throw as "fall back to
 * ffmpeg"). The `description` bytes are the box payload WITH the 8-byte box
 * header already stripped (i.e. starting at `configurationVersion`), matching
 * `mp4box`'s `avcC`/`hvcC` DataStream output minus header — see
 * `recorder/scrub/fmp4-keyframes.ts` `extractDescription`.
 */

/** Annex-B 4-byte start code prepended before every emitted NAL. */
const START_CODE = Uint8Array.of(0, 0, 0, 1)

/** Big-endian unsigned read of `size` (1..4) bytes at `off`. */
function readUint(bytes: Uint8Array, off: number, size: number): number {
  if (off + size > bytes.length) {
    throw new RangeError(`readUint out of range: off=${off} size=${size} len=${bytes.length}`)
  }
  let v = 0
  for (let i = 0; i < size; i++) v = v * 256 + bytes[off + i]!
  return v
}

/**
 * NAL length-prefix size in bytes (`lengthSizeMinusOne + 1`, 1..4) read from the
 * decoder config. `avcC` carries it at byte 4 (low 2 bits); `hvcC` at byte 21
 * (low 2 bits).
 */
export function parseNalLengthSize(description: Uint8Array, isHevc: boolean): number {
  const idx = isHevc ? 21 : 4
  if (description.length <= idx) {
    throw new RangeError(`config too short for lengthSizeMinusOne (len=${description.length})`)
  }
  return (description[idx]! & 0x03) + 1
}

/** Concatenate byte chunks into one Uint8Array. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** Push one Annex-B NAL (start code + payload) onto `chunks`. */
function pushNal(chunks: Uint8Array[], payload: Uint8Array): void {
  chunks.push(START_CODE, payload)
}

/**
 * Parse the `avcC` parameter sets (SPS then PPS), emitting each as an Annex-B
 * NAL. Layout after the 4-byte profile/level prefix: byte 4 low-2 = length
 * size; byte 5 low-5 = numSPS; then `[u16 len][SPS]…`; then `[u8 numPPS]`; then
 * `[u16 len][PPS]…`.
 */
function extractAvcParameterSets(desc: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = []
  const numSps = desc[5]! & 0x1f
  let p = 6
  for (let i = 0; i < numSps; i++) {
    const len = readUint(desc, p, 2)
    p += 2
    if (p + len > desc.length) throw new RangeError('avcC SPS length overruns config')
    pushNal(chunks, desc.subarray(p, p + len))
    p += len
  }
  const numPps = readUint(desc, p, 1)
  p += 1
  for (let i = 0; i < numPps; i++) {
    const len = readUint(desc, p, 2)
    p += 2
    if (p + len > desc.length) throw new RangeError('avcC PPS length overruns config')
    pushNal(chunks, desc.subarray(p, p + len))
    p += len
  }
  return chunks
}

/**
 * Parse the `hvcC` parameter-set arrays (typically VPS, SPS, PPS in order),
 * emitting each contained NAL as Annex-B. Layout: byte 22 = numOfArrays; then
 * per array `[u8 flags+NALtype][u16 numNalus]` followed by `numNalus` ×
 * `[u16 len][NAL]`.
 */
function extractHevcParameterSets(desc: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = []
  const numArrays = readUint(desc, 22, 1)
  let p = 23
  for (let a = 0; a < numArrays; a++) {
    p += 1 // array_completeness(1)+reserved(1)+NAL_unit_type(6) — type not needed
    const numNalus = readUint(desc, p, 2)
    p += 2
    for (let n = 0; n < numNalus; n++) {
      const len = readUint(desc, p, 2)
      p += 2
      if (p + len > desc.length) throw new RangeError('hvcC NAL length overruns config')
      pushNal(chunks, desc.subarray(p, p + len))
      p += len
    }
  }
  return chunks
}

/**
 * Parameter sets from the decoder config as one Annex-B blob (each NAL led by a
 * `00 00 00 01` start code): SPS+PPS for H.264, VPS+SPS+PPS (+ any hvcC arrays)
 * for H.265. Throws on a malformed config.
 */
export function extractParameterSetsAnnexB(description: Uint8Array, isHevc: boolean): Uint8Array {
  const chunks = isHevc
    ? extractHevcParameterSets(description)
    : extractAvcParameterSets(description)
  return concat(chunks)
}

/**
 * Convert one length-prefixed (AVCC/HVCC) sample into Annex-B: walk each
 * `nalLengthSize`-byte length field, replacing it with a `00 00 00 01` start
 * code. Handles multi-NAL samples (multiple slices / SEI + VCL). Throws if a
 * length field overruns the sample.
 */
export function avccSampleToAnnexB(sample: Uint8Array, nalLengthSize: number): Uint8Array {
  const chunks: Uint8Array[] = []
  let p = 0
  while (p + nalLengthSize <= sample.length) {
    const len = readUint(sample, p, nalLengthSize)
    p += nalLengthSize
    if (len === 0) continue
    if (p + len > sample.length) throw new RangeError('AVCC NAL length overruns sample')
    pushNal(chunks, sample.subarray(p, p + len))
    p += len
  }
  if (chunks.length === 0) throw new RangeError('AVCC sample yielded no NALs')
  return concat(chunks)
}

/**
 * Build a standalone-decodable Annex-B keyframe access unit: the config's
 * parameter sets, then the sample's NALs, all Annex-B framed. Throws on
 * malformed input (caller falls back to the ffmpeg demux).
 */
export function buildKeyframeAnnexB(
  sample: Uint8Array,
  description: Uint8Array,
  isHevc: boolean,
): Uint8Array {
  const nalLengthSize = parseNalLengthSize(description, isHevc)
  const params = extractParameterSetsAnnexB(description, isHevc)
  const frame = avccSampleToAnnexB(sample, nalLengthSize)
  return concat([params, frame])
}
