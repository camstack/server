/**
 * H.265/HEVC utilities.
 * HVCC to Annex-B conversion, VPS/SPS/PPS extraction, keyframe detection, RTP depacketization.
 */

import { NAL_START_CODE_4B, hasStartCodes, splitAnnexBToNals } from './nal-utils.js'

// --- HVCC to Annex-B conversion helpers ---

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

function looksLikeSingleH265Nal(nalPayload: Buffer): boolean {
  if (nalPayload.length < 2) return false
  const b0 = nalPayload[0]
  if (b0 === undefined) return false
  if ((b0 & 0x80) !== 0) return false
  const nalType = (b0 >> 1) & 0x3f
  return nalType <= 40
}

// --- Public API ---

/**
 * Convert H.265 data from length-prefixed (HVCC) to Annex-B (start codes).
 * If already Annex-B, returns as-is.
 */
export function convertH265ToAnnexB(data: Buffer): Buffer {
  if (hasStartCodes(data)) return data

  const sc4 = Buffer.from([0x00, 0x00, 0x00, 0x01])
  const sc3 = Buffer.from([0x00, 0x00, 0x01])
  const maxScan = Math.min(64, data.length)
  const idx4 = data.subarray(0, maxScan).indexOf(sc4)
  if (idx4 > 0) return data.subarray(idx4)
  const idx3 = data.subarray(0, maxScan).indexOf(sc3)
  if (idx3 > 0) return data.subarray(idx3)

  // Try HVCC → AnnexB conversion
  const be = tryConvertWithLengthReader(data, (b, o) => b.readUInt32BE(o))
  if (be) return be
  const le = tryConvertWithLengthReader(data, (b, o) => b.readUInt32LE(o))
  if (le) return le

  const be24 = tryConvertWithLengthReader24(data, 'be')
  if (be24) return be24
  const le24 = tryConvertWithLengthReader24(data, 'le')
  if (le24) return le24

  const be16 = tryConvertWithLengthReader16(data, (b, o) => b.readUInt16BE(o))
  if (be16) return be16
  const le16 = tryConvertWithLengthReader16(data, (b, o) => b.readUInt16LE(o))
  if (le16) return le16

  if (looksLikeSingleH265Nal(data)) {
    return Buffer.concat([NAL_START_CODE_4B, data])
  }
  return data
}

/**
 * Get H.265 NAL unit type from a NAL payload (without start code).
 */
export function getH265NalType(nalPayload: Buffer): number | null {
  if (nalPayload.length < 1) return null
  const b0 = nalPayload[0]
  if (b0 === undefined) return null
  if ((b0 & 0x80) !== 0) return null
  return (b0 >> 1) & 0x3f
}

/**
 * Check if an H.265 NAL unit type is an IRAP (Intra Random Access Point) picture.
 * IRAP types: BLA (16-18), IDR (19-20), CRA (21).
 */
export function isH265Irap(nalType: number): boolean {
  return nalType >= 16 && nalType <= 23
}

/**
 * Check if an H.265 Annex-B access unit is a keyframe (IRAP + VPS + SPS + PPS).
 */
export function isH265KeyframeAnnexB(annexB: Buffer): boolean {
  const nals = splitAnnexBToNals(annexB)
  let hasVps = false
  let hasSps = false
  let hasPps = false
  let hasIrap = false

  for (const nal of nals) {
    const nalType = getH265NalType(nal)
    if (nalType === null) continue
    if (nalType === 32) hasVps = true
    if (nalType === 33) hasSps = true
    if (nalType === 34) hasPps = true
    if (isH265Irap(nalType)) hasIrap = true
  }

  return hasIrap && hasVps && hasSps && hasPps
}

/**
 * Check if an H.265 Annex-B access unit contains an IRAP picture.
 */
export function isH265IrapAccessUnit(annexB: Buffer): boolean {
  const nals = splitAnnexBToNals(annexB)
  for (const nal of nals) {
    if (nal.length < 2) continue
    const b0 = nal[0]
    if (b0 === undefined) continue
    if ((b0 & 0x80) !== 0) continue
    const nalType = (b0 >> 1) & 0x3f
    if (isH265Irap(nalType)) return true
  }
  return false
}

/**
 * Extract VPS, SPS, and PPS from an H.265 Annex-B access unit.
 */
export function extractH265ParamSets(annexB: Buffer): {
  vps?: Buffer
  sps?: Buffer
  pps?: Buffer
} {
  const nals = splitAnnexBToNals(annexB)
  let vps: Buffer | undefined
  let sps: Buffer | undefined
  let pps: Buffer | undefined

  for (const nal of nals) {
    if (nal.length < 2) continue
    const nalType = (nal[0]! >> 1) & 0x3f
    if (nalType === 32) vps = nal
    else if (nalType === 33) sps = nal
    else if (nalType === 34) pps = nal
  }

  const out: { vps?: Buffer; sps?: Buffer; pps?: Buffer } = {}
  if (vps) out.vps = vps
  if (sps) out.sps = sps
  if (pps) out.pps = pps
  return out
}

/**
 * H.265 RTP depacketizer (RFC 7798).
 * Handles single NAL units, AP aggregation, and FU fragmentation.
 * Returns complete NAL units in Annex-B format (with start codes).
 */
export class H265RtpDepacketizer {
  private fuParts: Buffer[] | null = null

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
    this.fuParts = null
  }

  push(payload: Buffer): Buffer[] {
    if (!payload || payload.length < 2) return []

    const rtpPayload = H265RtpDepacketizer.parseRtpPayload(payload)
    if (rtpPayload) payload = rtpPayload

    const h0 = payload[0]!
    const h1 = payload[1]!
    if ((h0 & 0x80) !== 0) return []
    const nalType = (h0 >> 1) & 0x3f

    // AP (48): aggregation packet
    if (nalType === 48) {
      let off = 2
      const out: Buffer[] = []
      while (off + 2 <= payload.length) {
        const size = payload.readUInt16BE(off)
        off += 2
        if (size <= 0 || off + size > payload.length) return []
        const nal = payload.subarray(off, off + size)
        off += size
        if (nal.length) out.push(NAL_START_CODE_4B, nal)
      }
      return out.length ? [Buffer.concat(out)] : []
    }

    // FU (49): fragmentation unit
    if (nalType === 49) {
      if (payload.length < 3) return []
      const fuHeader = payload[2]!
      const start = (fuHeader & 0x80) !== 0
      const end = (fuHeader & 0x40) !== 0
      const origType = fuHeader & 0x3f
      const orig0 = (h0 & 0x81) | ((origType & 0x3f) << 1)
      const orig1 = h1
      const frag = payload.subarray(3)

      if (start) {
        this.fuParts = [NAL_START_CODE_4B, Buffer.from([orig0, orig1]), frag]
      } else {
        if (!this.fuParts) return []
        this.fuParts.push(frag)
      }

      if (end) {
        if (!this.fuParts) return []
        const out = Buffer.concat(this.fuParts)
        this.fuParts = null
        return [out]
      }

      return []
    }

    // Single NAL unit
    return [Buffer.concat([NAL_START_CODE_4B, payload])]
  }
}
