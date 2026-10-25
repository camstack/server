/**
 * NAL unit parsing utilities.
 * Protocol-agnostic functions for working with Annex-B NAL units.
 */

import type { VideoCodec } from './types.js'

const NAL_START_CODE_4B = Buffer.from([0x00, 0x00, 0x00, 0x01])
const NAL_START_CODE_3B = Buffer.from([0x00, 0x00, 0x01])

/**
 * Returns true if the buffer starts with an Annex-B start code (0x00000001 or 0x000001).
 */
export function hasStartCodes(data: Buffer): boolean {
  if (data.length < 4) return false
  if (data.subarray(0, 4).equals(NAL_START_CODE_4B)) return true
  if (data.subarray(0, 3).equals(NAL_START_CODE_3B)) return true
  return false
}

/**
 * Split Annex-B data into individual NAL unit payloads (without start codes).
 * Works for both H.264 and H.265.
 */
export function splitAnnexBToNals(annexB: Buffer): Buffer[] {
  const nals: Buffer[] = []
  const len = annexB.length

  const isStartCodeAt = (i: number): number => {
    if (i + 3 <= len && annexB[i] === 0x00 && annexB[i + 1] === 0x00) {
      if (annexB[i + 2] === 0x01) return 3
      if (i + 4 <= len && annexB[i + 2] === 0x00 && annexB[i + 3] === 0x01) return 4
    }
    return 0
  }

  let i = 0
  // Find first start code
  while (i < len) {
    const sc = isStartCodeAt(i)
    if (sc) break
    i++
  }

  while (i < len) {
    const sc = isStartCodeAt(i)
    if (!sc) {
      i++
      continue
    }
    const nalStart = i + sc
    let j = nalStart
    while (j < len) {
      const sc2 = isStartCodeAt(j)
      if (sc2) break
      j++
    }
    if (nalStart < j) {
      const nal = annexB.subarray(nalStart, j)
      if (nal.length > 0) nals.push(nal)
    }
    i = j
  }

  return nals
}

/**
 * Prepend a 4-byte Annex-B start code to a NAL payload.
 */
export function prependStartCode(nal: Buffer): Buffer {
  return Buffer.concat([NAL_START_CODE_4B, nal])
}

/**
 * Join multiple NAL payloads (without start codes) into an Annex-B access unit.
 */
export function joinNalsToAnnexB(...nals: Array<Buffer | null | undefined>): Buffer | undefined {
  const present = nals.filter((n): n is Buffer => !!n && n.length > 0)
  if (!present.length) return
  const parts: Buffer[] = []
  for (const nal of present) {
    parts.push(NAL_START_CODE_4B, nal)
  }
  return Buffer.concat(parts)
}

/**
 * Detect the actual video codec from raw NAL data.
 * Some cameras report wrong codec (e.g. "H264" but send H.265 data).
 * Analyzes the NAL header to determine the real codec.
 *
 * @param data - Raw video data (either Annex-B or length-prefixed)
 * @returns Detected codec type or null if detection fails
 */
export function detectVideoCodecFromNal(data: Buffer): VideoCodec | null {
  if (!data || data.length < 5) return null

  // Find start code (00 00 00 01 or 00 00 01)
  let nalStart = -1
  for (let i = 0; i < Math.min(data.length - 4, 100); i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 0 && data[i + 3] === 1) {
        nalStart = i + 4
        break
      }
      if (data[i + 2] === 1) {
        nalStart = i + 3
        break
      }
    }
  }

  // If no start code, try length-prefixed (AVCC/HVCC)
  if (nalStart < 0 && data.length >= 5) {
    const len = data.readUInt32BE(0)
    if (len > 0 && len <= data.length - 4) {
      nalStart = 4
    }
  }

  if (nalStart < 0 || nalStart >= data.length) return null

  const nalByte = data[nalStart]
  if (nalByte === undefined) return null

  // Check H.264 FIRST because H.264 NAL bytes can be misinterpreted as H.265.
  const forbiddenBit264 = (nalByte >> 7) & 1
  const h264Type = nalByte & 0x1f

  if (forbiddenBit264 === 0 && h264Type > 0 && h264Type <= 12) {
    if (h264Type === 7 || h264Type === 8) return 'H264' // SPS, PPS
    if (h264Type === 5) return 'H264' // IDR
    if (h264Type === 1) {
      const nalRefIdc = (nalByte >> 5) & 0x03
      if (nalRefIdc >= 1) return 'H264'
    }
  }

  // H.265/HEVC detection
  if (nalStart + 1 < data.length) {
    const nalByte2 = data[nalStart + 1]
    if (nalByte2 !== undefined) {
      const forbiddenBit = (nalByte >> 7) & 1
      const hevcType = (nalByte >> 1) & 0x3f
      const temporalId = nalByte2 & 0x07

      if (forbiddenBit === 0 && temporalId > 0 && hevcType <= 40) {
        if (hevcType === 32 || hevcType === 33 || hevcType === 34) return 'H265' // VPS, SPS, PPS
        if (hevcType === 19 || hevcType === 20 || hevcType === 21) return 'H265' // IDR, CRA
        if (hevcType <= 1 && nalByte <= 0x03) return 'H265' // TRAIL
      }
    }
  }

  return null
}

export { NAL_START_CODE_4B, NAL_START_CODE_3B }
