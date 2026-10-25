/**
 * H.264/AVC utilities.
 * AVCC to Annex-B conversion, SPS/PPS extraction, keyframe detection, RTP depacketization.
 */

import { NAL_START_CODE_4B, hasStartCodes, splitAnnexBToNals } from './nal-utils.js'

// --- AVCC to Annex-B conversion helpers ---

function tryConvertWithLengthReader(
  data: Buffer,
  readLen: (buf: Buffer, offset: number) => number,
): Buffer | null {
  const result: Buffer[] = []
  let offset = 0
  let nalCount = 0
  while (offset < data.length) {
    if (offset + 4 > data.length) return null
    const nalLength = readLen(data, offset)
    offset += 4
    if (nalLength <= 0) return null
    if (nalLength > data.length - offset) return null
    result.push(NAL_START_CODE_4B)
    result.push(data.subarray(offset, offset + nalLength))
    offset += nalLength
    nalCount++
  }
  if (nalCount === 0) return null
  return Buffer.concat(result)
}

function tryConvertWithLengthReader16(
  data: Buffer,
  readLen: (buf: Buffer, offset: number) => number,
): Buffer | null {
  const result: Buffer[] = []
  let offset = 0
  let nalCount = 0
  while (offset < data.length) {
    if (offset + 2 > data.length) return null
    const nalLength = readLen(data, offset)
    offset += 2
    if (nalLength <= 0) return null
    if (nalLength > data.length - offset) return null
    result.push(NAL_START_CODE_4B)
    result.push(data.subarray(offset, offset + nalLength))
    offset += nalLength
    nalCount++
  }
  if (nalCount === 0) return null
  return Buffer.concat(result)
}

function tryConvertWithLengthReader24(data: Buffer, endian: 'be' | 'le'): Buffer | null {
  const result: Buffer[] = []
  let offset = 0
  let nalCount = 0
  const readLen24 = (buf: Buffer, at: number): number => {
    if (at + 3 > buf.length) return 0
    const b0 = buf[at]!
    const b1 = buf[at + 1]!
    const b2 = buf[at + 2]!
    return endian === 'be'
      ? ((b0 << 16) | (b1 << 8) | b2) >>> 0
      : ((b2 << 16) | (b1 << 8) | b0) >>> 0
  }
  while (offset < data.length) {
    if (offset + 3 > data.length) return null
    const nalLength = readLen24(data, offset)
    offset += 3
    if (nalLength <= 0) return null
    if (nalLength > data.length - offset) return null
    result.push(NAL_START_CODE_4B)
    result.push(data.subarray(offset, offset + nalLength))
    offset += nalLength
    nalCount++
  }
  if (nalCount === 0) return null
  return Buffer.concat(result)
}

function looksLikeSingleH264Nal(nalPayload: Buffer): boolean {
  if (nalPayload.length < 1) return false
  const b0 = nalPayload[0]
  if (b0 === undefined) return false
  if ((b0 & 0x80) !== 0) return false
  const nalType = b0 & 0x1f
  return nalType >= 1 && nalType <= 23
}

function depacketizeRtpAggregationToAnnexB(payload: Buffer): Buffer | null {
  if (payload.length < 1) return null
  const nalHeader = payload[0]!
  const nalType = nalHeader & 0x1f
  const out: Buffer[] = []
  const pushNal = (nal: Buffer) => {
    if (nal.length === 0) return
    out.push(NAL_START_CODE_4B, nal)
  }

  // STAP-A (24)
  if (nalType === 24) {
    let off = 1
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off)
      off += 2
      if (size <= 0 || off + size > payload.length) return null
      pushNal(payload.subarray(off, off + size))
      off += size
    }
    return out.length ? Buffer.concat(out) : null
  }

  // STAP-B (25)
  if (nalType === 25) {
    let off = 1 + 2
    if (off > payload.length) return null
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off)
      off += 2
      if (size <= 0 || off + size > payload.length) return null
      pushNal(payload.subarray(off, off + size))
      off += size
    }
    return out.length ? Buffer.concat(out) : null
  }

  // MTAP16 (26)
  if (nalType === 26) {
    let off = 1 + 2
    if (off > payload.length) return null
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off)
      off += 2
      if (off + 1 + 2 > payload.length) return null
      off += 1 + 2
      if (size <= 0 || off + size > payload.length) return null
      pushNal(payload.subarray(off, off + size))
      off += size
    }
    return out.length ? Buffer.concat(out) : null
  }

  // MTAP24 (27)
  if (nalType === 27) {
    let off = 1 + 2
    if (off > payload.length) return null
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off)
      off += 2
      if (off + 1 + 3 > payload.length) return null
      off += 1 + 3
      if (size <= 0 || off + size > payload.length) return null
      pushNal(payload.subarray(off, off + size))
      off += size
    }
    return out.length ? Buffer.concat(out) : null
  }

  return null
}

// --- Public API ---

/**
 * Convert H.264 data from length-prefixed (AVCC) to Annex-B (start codes).
 * If already Annex-B, returns as-is.
 */
export function convertH264ToAnnexB(data: Buffer): Buffer {
  if (hasStartCodes(data)) return data

  // Some models prepend a small header before an Annex-B access unit.
  const sc4 = Buffer.from([0x00, 0x00, 0x00, 0x01])
  const sc3 = Buffer.from([0x00, 0x00, 0x01])
  const maxScan = Math.min(64, data.length)
  const idx4 = data.subarray(0, maxScan).indexOf(sc4)
  if (idx4 > 0) return data.subarray(idx4)
  const idx3 = data.subarray(0, maxScan).indexOf(sc3)
  if (idx3 > 0) return data.subarray(idx3)

  // Try AVCC → AnnexB conversion (BE then LE)
  const be = tryConvertWithLengthReader(data, (b, o) => b.readUInt32BE(o))
  if (be) return be
  const le = tryConvertWithLengthReader(data, (b, o) => b.readUInt32LE(o))
  if (le) return le

  // 3-byte lengths
  const be24 = tryConvertWithLengthReader24(data, 'be')
  if (be24) return be24
  const le24 = tryConvertWithLengthReader24(data, 'le')
  if (le24) return le24

  // 2-byte lengths
  const be16 = tryConvertWithLengthReader16(data, (b, o) => b.readUInt16BE(o))
  if (be16) return be16
  const le16 = tryConvertWithLengthReader16(data, (b, o) => b.readUInt16LE(o))
  if (le16) return le16

  // RTP aggregation payload
  const agg = depacketizeRtpAggregationToAnnexB(data)
  if (agg) return agg

  // Single NAL without start code
  if (looksLikeSingleH264Nal(data)) {
    return Buffer.concat([NAL_START_CODE_4B, data])
  }

  return data
}

/**
 * Check if an H.264 Annex-B access unit is a keyframe (IDR + SPS + PPS).
 */
export function isH264KeyframeAnnexB(annexB: Buffer): boolean {
  const nals = splitAnnexBToNals(annexB)
  let hasSps = false
  let hasPps = false
  let hasIdr = false
  for (const nal of nals) {
    const t = (nal[0] ?? 0) & 0x1f
    if (t === 7) hasSps = true
    if (t === 8) hasPps = true
    if (t === 5) hasIdr = true
  }
  return hasIdr && hasSps && hasPps
}

/**
 * Check if an H.264 Annex-B access unit contains an IDR slice.
 */
/**
 * Detect H.264 keyframe (IDR or I-frame with SPS).
 *
 * Some cameras emit non-IDR I-frames (NAL type 1 with slice_type=I)
 * instead of IDR frames (NAL type 5). Both are intra-coded and valid
 * as decoder entry points, but only IDR carries NAL type 5.
 *
 * We detect keyframes by:
 *   1. NAL type 5 (IDR) — canonical
 *   2. SPS (type 7) present — parameter sets are always sent with keyframes
 */
export function isH264IdrAccessUnit(annexB: Buffer): boolean {
  const nals = splitAnnexBToNals(annexB)
  let hasSps = false
  for (const nal of nals) {
    if (nal.length < 1) continue
    const t = (nal[0] ?? 0) & 0x1f
    if (t === 5) return true // IDR slice
    if (t === 7) hasSps = true // SPS — indicates keyframe boundary
  }
  return hasSps
}

/**
 * Extract SPS and PPS from an H.264 Annex-B access unit.
 */
export function extractH264ParamSets(annexB: Buffer): {
  sps?: Buffer
  pps?: Buffer
  profileLevelId?: string
} {
  const nals = splitAnnexBToNals(annexB)
  let sps: Buffer | undefined
  let pps: Buffer | undefined
  let profileLevelId: string | undefined

  for (const nal of nals) {
    if (nal.length < 1) continue
    const nalType = nal[0]! & 0x1f
    if (nalType === 7) {
      sps = nal
      if (nal.length >= 4) {
        profileLevelId = Buffer.from([nal[1]!, nal[2]!, nal[3]!]).toString('hex')
      }
    } else if (nalType === 8) {
      pps = nal
    }
  }

  const out: { sps?: Buffer; pps?: Buffer; profileLevelId?: string } = {}
  if (sps) out.sps = sps
  if (pps) out.pps = pps
  if (profileLevelId) out.profileLevelId = profileLevelId
  return out
}

/**
 * True when an H.264 `profile-level-id` (6 hex chars: profile_idc +
 * constraint-set flags + level_idc) is Baseline / Constrained Baseline,
 * i.e. profile_idc 0x42 (66). iOS Safari/WebKit WebRTC decodes ONLY this
 * profile for H.264 RECEIVE — Main (0x4d) and High (0x64) negotiate but
 * never decode (endless PLI storm, black view). The test is on
 * profile_idc (the first byte) alone: the constraint flags and level
 * don't change Baseline decodability on iOS.
 */
export function isBaselineProfileLevelId(profileLevelId: string): boolean {
  return profileLevelId.length >= 2 && profileLevelId.slice(0, 2).toLowerCase() === '42'
}

/**
 * Group a flat list of H.264 NAL units into access units (one decoded
 * picture each), per the boundary rules of H.264 §7.4.1.2.4. A new access
 * unit starts at:
 *   - an Access Unit Delimiter (type 9), or
 *   - a VCL slice (types 1–5) whose `first_mb_in_slice == 0` (a new
 *     primary coded picture — detected by the high bit of the byte after
 *     the NAL header), or
 *   - an SPS (7) / PPS (8) / SEI (6) that follows a completed picture.
 * AUD NALs are dropped from the output (they're delimiters only).
 *
 * This restores correct frame delimiting for the transcode feed: each
 * returned access unit is sent with exactly ONE RTP timestamp and a
 * single trailing marker bit, so the receiver can assemble and decode
 * each picture. (ffmpeg's raw-H.264 stdout is a bytestream with no frame
 * boundaries, so we recover them here.)
 */
export function groupNalsIntoAccessUnits(nals: readonly Buffer[]): Buffer[][] {
  const accessUnits: Buffer[][] = []
  let current: Buffer[] = []
  let currentHasVcl = false

  const isVcl = (type: number): boolean => type >= 1 && type <= 5
  const startsNewAccessUnit = (type: number, nal: Buffer): boolean => {
    // A VCL NAL begins a new picture when first_mb_in_slice == 0, which
    // encodes as a leading '1' bit → high bit of the first slice-header byte.
    if (isVcl(type)) return nal.length >= 2 && (nal[1]! & 0x80) === 0x80
    // AUD / SPS / PPS / SEI before the next picture belong to that picture.
    return type === 9 || type === 7 || type === 8 || type === 6
  }

  for (const nal of nals) {
    if (nal.length < 1) continue
    const type = nal[0]! & 0x1f
    if (currentHasVcl && startsNewAccessUnit(type, nal)) {
      accessUnits.push(current)
      current = []
      currentHasVcl = false
    }
    if (type === 9) continue // drop the Access Unit Delimiter
    current.push(nal)
    if (isVcl(type)) currentHasVcl = true
  }
  if (current.length > 0) accessUnits.push(current)
  return accessUnits
}

/**
 * H.264 RTP depacketizer (RFC 6184).
 * Handles single NAL units, STAP-A aggregation, and FU-A/FU-B fragmentation.
 * Returns complete NAL units in Annex-B format (with start codes).
 */
export class H264RtpDepacketizer {
  private fuNalHeader: number | null = null
  private fuParts: Buffer[] = []

  private static parseRtpPayload(packet: Buffer): Buffer | null {
    if (!packet || packet.length < 12) return null
    const version = (packet[0]! >> 6) & 0x03
    if (version !== 2) return null
    const padding = (packet[0]! & 0x20) !== 0
    const extension = (packet[0]! & 0x10) !== 0
    const csrcCount = packet[0]! & 0x0f
    let offset = 12 + csrcCount * 4
    if (offset > packet.length) return null
    if (extension) {
      if (offset + 4 > packet.length) return null
      const extLenWords = packet.readUInt16BE(offset + 2)
      offset += 4 + extLenWords * 4
      if (offset > packet.length) return null
    }
    let end = packet.length
    if (padding) {
      const padLen = packet[packet.length - 1]!
      if (padLen <= 0 || padLen > packet.length) return null
      end = packet.length - padLen
      if (end < offset) return null
    }
    if (end <= offset) return null
    return packet.subarray(offset, end)
  }

  reset(): void {
    this.fuNalHeader = null
    this.fuParts = []
  }

  push(payload: Buffer): Buffer[] {
    if (payload.length === 0) return []

    const rtpPayload = H264RtpDepacketizer.parseRtpPayload(payload)
    if (rtpPayload) payload = rtpPayload

    if (hasStartCodes(payload)) return [payload]

    const b0 = payload[0]!
    if ((b0 & 0x80) !== 0) return []
    const nalType = b0 & 0x1f

    // Single NAL unit
    if (nalType >= 1 && nalType <= 23) {
      return [Buffer.concat([NAL_START_CODE_4B, payload])]
    }

    // STAP-A (24)
    if (nalType === 24) {
      if (payload.length < 1 + 2) return []
      let off = 1
      const out: Buffer[] = []
      while (off + 2 <= payload.length) {
        const size = payload.readUInt16BE(off)
        off += 2
        if (size <= 0 || off + size > payload.length) return []
        const nal = payload.subarray(off, off + size)
        off += size
        if (nal.length < 1) return []
        if ((nal[0]! & 0x80) !== 0) return []
        const t = nal[0]! & 0x1f
        if (t === 0 || t >= 24) return []
        out.push(Buffer.concat([NAL_START_CODE_4B, nal]))
      }
      return out
    }

    // FU-A (28) / FU-B (29)
    if (nalType === 28 || nalType === 29) {
      if (payload.length < 2) return []
      const fuIndicator = payload[0]!
      const fuHeader = payload[1]!
      const start = (fuHeader & 0x80) !== 0
      const end = (fuHeader & 0x40) !== 0
      const origType = fuHeader & 0x1f
      const reconstructedHeader = (fuIndicator & 0xe0) | origType

      let off = 2
      if (nalType === 29) {
        if (payload.length < off + 2) return []
        off += 2
      }
      const frag = payload.subarray(off)

      if (start) {
        this.fuNalHeader = reconstructedHeader
        this.fuParts = [frag]
      } else if (this.fuNalHeader != null) {
        this.fuParts.push(frag)
      } else {
        return []
      }

      if (end && this.fuNalHeader != null) {
        const nal = Buffer.concat([Buffer.from([this.fuNalHeader]), ...this.fuParts])
        this.reset()
        return [Buffer.concat([NAL_START_CODE_4B, nal])]
      }
      return []
    }

    return []
  }
}
