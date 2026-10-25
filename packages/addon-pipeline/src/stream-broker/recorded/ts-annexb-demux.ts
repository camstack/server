/**
 * ts-annexb-demux — pure MPEG-TS → ordered Annex-B access units.
 *
 * Companion to {@link demuxSegmentToAnnexB}: `segment-demux` runs one `.m4s`
 * fragment through `ffmpeg -c:v copy -f mpegts` (crash-isolated subprocess,
 * replacing the old in-process `node-av` demux) and hands the resulting
 * transport stream here to be split back into per-frame access units.
 *
 * Why MPEG-TS as the intermediate container:
 *   - it preserves EXACTLY the two things the recorded-playback feeder needs
 *     that a raw Annex-B elementary stream (`-f h264/hevc`) throws away — the
 *     per-frame presentation timestamp (PES `PTS`, 90 kHz) and the frame
 *     boundaries (one video PES per access unit, marked by `payload_unit_start`);
 *   - the ffmpeg mpegts muxer FUSES the parameter sets onto every random-access
 *     point exactly like the `h264/hevc_mp4toannexb` bitstream filter did — the
 *     IDR PES carries `AUD` + `VPS/SPS/PPS` (H.265) or `AUD` + `SPS/PPS`
 *     (H.264) ahead of the IDR slice — so no explicit BSF is needed and the
 *     downstream pusher's "one AU per frame, params on keyframes" contract holds;
 *   - the codec is read straight from the PMT `stream_type` (`0x1B` → H.264,
 *     `0x24` → H.265), so no separate probe pass is required.
 *
 * This module is intentionally pure (a `Uint8Array` in, access units out) so it
 * unit-tests against a committed `.ts` fixture with no ffmpeg/native binding.
 */

/** MPEG-TS transport packet size. */
const TS_PACKET_SIZE = 188
/** Transport packet sync byte. */
const TS_SYNC_BYTE = 0x47
/** The PAT always lives on PID 0. */
const PAT_PID = 0

/** PMT `stream_type` for H.264 (AVC) video. */
const STREAM_TYPE_H264 = 0x1b
/** PMT `stream_type` for H.265 (HEVC) video. */
const STREAM_TYPE_H265 = 0x24

/** A single Annex-B access unit demuxed from the transport stream. */
export interface TsAccessUnit {
  /** Annex-B bytes; parameter sets fused onto keyframes by the mpegts muxer. */
  readonly data: Uint8Array
  /** Source presentation time in milliseconds (from the PES 90 kHz PTS). */
  readonly ptsMs: number
  /** Whether this access unit is a keyframe (contains an IDR/IRAP NAL). */
  readonly keyframe: boolean
}

/** Result of demuxing one transport stream: its codec + ordered access units. */
export interface TsDemuxResult {
  readonly codec: 'H264' | 'H265'
  readonly accessUnits: TsAccessUnit[]
}

/** Map a PMT `stream_type` to the AccessUnit codec tag, or null if not video. */
export function codecForStreamType(streamType: number): 'H264' | 'H265' | null {
  if (streamType === STREAM_TYPE_H264) return 'H264'
  if (streamType === STREAM_TYPE_H265) return 'H265'
  return null
}

/**
 * Detect whether an Annex-B access unit is a keyframe by scanning its NAL units:
 * H.264 IDR (type 5) or H.265 IRAP (types 16–21). Mirrors
 * `AnnexBDeframer.isKeyframeNal`; params/AUD NALs ahead of the slice are ignored.
 */
function isKeyframeAccessUnit(au: Uint8Array, codec: 'H264' | 'H265'): boolean {
  for (const nalStart of iterateNalStarts(au)) {
    const header = au[nalStart]
    if (header === undefined) continue
    if (codec === 'H264') {
      if ((header & 0x1f) === 5) return true
    } else {
      const type = (header >> 1) & 0x3f
      if (type >= 16 && type <= 21) return true
    }
  }
  return false
}

/**
 * Yield the byte offset of the FIRST byte of each NAL unit (i.e. just past its
 * Annex-B start code, `00 00 01` or `00 00 00 01`) in `buf`.
 */
function* iterateNalStarts(buf: Uint8Array): Generator<number> {
  const len = buf.length
  let i = 0
  while (i + 2 < len) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) {
        yield i + 3
        i += 3
        continue
      }
      if (buf[i + 2] === 0 && buf[i + 3] === 1) {
        yield i + 4
        i += 4
        continue
      }
    }
    i++
  }
}

/**
 * Read the 33-bit PES `PTS` (or DTS) from the 5 bytes at `off` and return it in
 * 90 kHz ticks. The layout interleaves marker bits every byte
 * (`0010 PPP1 PPPPPPPP PPPPPPP1 PPPPPPPP PPPPPPP1`).
 */
function readPts33(buf: Uint8Array, off: number): number {
  const b0 = buf[off] ?? 0
  const b1 = buf[off + 1] ?? 0
  const b2 = buf[off + 2] ?? 0
  const b3 = buf[off + 3] ?? 0
  const b4 = buf[off + 4] ?? 0
  // Assemble with plain arithmetic (not `<<`): a 33-bit PTS overflows the 32-bit
  // signed range that `<<` operates in. Multiplication keeps it an exact double.
  const hi = (b0 >> 1) & 0x07
  const mid = (b1 << 7) | (b2 >> 1)
  const lo = (b3 << 7) | (b4 >> 1)
  return hi * 0x40000000 + mid * 0x8000 + lo
}

/** Locate the payload offset within a TS packet, skipping any adaptation field. */
function payloadOffset(pkt: Uint8Array, base: number): number {
  const adaptationFieldControl = (pkt[base + 3]! >> 4) & 0x3
  let off = base + 4
  if (adaptationFieldControl & 0x2) {
    // adaptation_field_length byte + the field itself
    off += 1 + pkt[off]!
  }
  // afc === 0 (reserved) or 2 (adaptation only, no payload) carry no payload;
  // the caller guards on `hasPayload`.
  return off
}

/** Whether a TS packet's adaptation_field_control indicates a payload is present. */
function hasPayload(pkt: Uint8Array, base: number): boolean {
  const afc = (pkt[base + 3]! >> 4) & 0x3
  return afc === 1 || afc === 3
}

interface PmtInfo {
  readonly videoPid: number
  readonly codec: 'H264' | 'H265'
}

/** Parse the PAT payload → the first program's PMT PID. */
function parsePatForPmtPid(payload: Uint8Array): number | null {
  // pointer_field then table: skip pointer + 8-byte section header, read the
  // first program's 4-byte (program_number, PMT PID) entry.
  const pointer = payload[0]!
  const p = 1 + pointer + 8
  if (p + 3 >= payload.length) return null
  return ((payload[p + 2]! & 0x1f) << 8) | payload[p + 3]!
}

/** Parse the PMT payload → the first H.264/H.265 elementary stream's PID + codec. */
function parsePmt(payload: Uint8Array): PmtInfo | null {
  const pointer = payload[0]!
  const p = 1 + pointer
  const sectionLength = ((payload[p + 1]! & 0x0f) << 8) | payload[p + 2]!
  const programInfoLength = ((payload[p + 10]! & 0x0f) << 8) | payload[p + 11]!
  // ES loop starts after the 12-byte PMT header + the program_info descriptors,
  // and runs until the 4-byte CRC at the end of the section.
  let es = p + 12 + programInfoLength
  const sectionEnd = p + 3 + sectionLength - 4 // -4 = CRC_32
  while (es + 4 < sectionEnd && es + 4 < payload.length) {
    const streamType = payload[es]!
    const elementaryPid = ((payload[es + 1]! & 0x1f) << 8) | payload[es + 2]!
    const esInfoLength = ((payload[es + 3]! & 0x0f) << 8) | payload[es + 4]!
    const codec = codecForStreamType(streamType)
    if (codec !== null) return { videoPid: elementaryPid, codec }
    es += 5 + esInfoLength
  }
  return null
}

/** Split one reassembled PES packet into its Annex-B elementary-stream payload
 *  and 90 kHz PTS (null when the PES carries no PTS flag). */
function splitPes(pes: Uint8Array): { es: Uint8Array; pts: number | null } | null {
  // PES: 00 00 01, stream_id, 16-bit length, then (for video) 2 flag bytes,
  // PES_header_data_length, and the optional PTS/DTS block.
  if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return null
  const ptsDtsFlags = (pes[7]! >> 6) & 0x3
  const headerDataLength = pes[8]!
  const es = pes.subarray(9 + headerDataLength)
  // ptsDtsFlags: 0b10 = PTS only, 0b11 = PTS+DTS. The PTS is the first 5 bytes.
  const pts = ptsDtsFlags & 0x2 ? readPts33(pes, 9) : null
  return { es, pts }
}

/**
 * Demux an MPEG-TS byte stream (as produced by `ffmpeg -c:v copy -f mpegts`)
 * into ordered Annex-B access units, one per video PES.
 *
 * @param ts - The full transport stream.
 * @returns The detected codec and its access units in transport (decode) order.
 * @throws If no H.264/H.265 video elementary stream is present.
 */
export function demuxMpegTsToAnnexB(ts: Uint8Array): TsDemuxResult {
  let pmtPid: number | null = null
  let pmt: PmtInfo | null = null

  // Pass 1: resolve the PMT PID from the PAT, then the video PID + codec from
  // the PMT. PSI sections in a short fragment fit in a single TS packet each.
  for (let i = 0; i + TS_PACKET_SIZE <= ts.length; i += TS_PACKET_SIZE) {
    const pkt = ts.subarray(i, i + TS_PACKET_SIZE)
    if (pkt[0] !== TS_SYNC_BYTE) continue
    const pid = ((pkt[1]! & 0x1f) << 8) | pkt[2]!
    const payloadStart = (pkt[1]! & 0x40) !== 0
    if (!payloadStart || !hasPayload(pkt, 0)) continue
    const payload = pkt.subarray(payloadOffset(pkt, 0))
    if (pid === PAT_PID) {
      pmtPid ??= parsePatForPmtPid(payload)
    } else if (pmtPid !== null && pid === pmtPid && pmt === null) {
      pmt = parsePmt(payload)
    }
  }

  if (pmt === null) {
    throw new Error('ts-annexb-demux: no H.264/H.265 video stream found in transport stream')
  }
  const { videoPid, codec } = pmt

  // Pass 2: reassemble video PES packets. A PES starts on a packet with
  // payload_unit_start and ends at the next such packet (or end of stream).
  const accessUnits: TsAccessUnit[] = []
  let current: Uint8Array[] | null = null

  const finalize = (): void => {
    if (current === null) return
    const pes = current.length === 1 ? current[0]! : concat(current)
    current = null
    const split = splitPes(pes)
    if (split === null || split.es.length === 0) return
    const data = new Uint8Array(split.es.length)
    data.set(split.es)
    accessUnits.push({
      data,
      ptsMs: split.pts === null ? 0 : Math.round(split.pts / 90),
      keyframe: isKeyframeAccessUnit(data, codec),
    })
  }

  for (let i = 0; i + TS_PACKET_SIZE <= ts.length; i += TS_PACKET_SIZE) {
    const pkt = ts.subarray(i, i + TS_PACKET_SIZE)
    if (pkt[0] !== TS_SYNC_BYTE) continue
    const pid = ((pkt[1]! & 0x1f) << 8) | pkt[2]!
    if (pid !== videoPid) continue
    if (!hasPayload(pkt, 0)) continue
    const payloadStart = (pkt[1]! & 0x40) !== 0
    const payload = pkt.subarray(payloadOffset(pkt, 0))
    if (payloadStart) {
      finalize()
      current = [Uint8Array.from(payload)]
    } else if (current !== null) {
      current.push(Uint8Array.from(payload))
    }
  }
  finalize()

  return { codec, accessUnits }
}

/** Concatenate TS payload fragments into one contiguous PES buffer. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
