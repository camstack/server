import { describe, it, expect } from 'vitest'
import { annexBHasParameterSets } from '../stream-broker/annexb-param-sets.js'

const SC4 = Buffer.from([0x00, 0x00, 0x00, 0x01])
const SC3 = Buffer.from([0x00, 0x00, 0x01])

/** Build an Annex-B blob from (startCode, nalHeaderByte, ...payload) triples. */
function nal(startCode: Buffer, headerByte: number, payload = [0x00, 0x00]): Buffer {
  return Buffer.concat([startCode, Buffer.from([headerByte, ...payload])])
}

// H.264 NAL header = nal_ref_idc<<5 | type. SPS=7, PPS=8, IDR=5.
const H264_SPS = nal(SC4, 0x67) // type 7
const H264_PPS = nal(SC4, 0x68) // type 8
const H264_IDR = nal(SC4, 0x65) // type 5
// H.265 NAL header (2 bytes): (type<<1) in the first byte. SPS=33→0x42, PPS=34→0x44, IDR=19→0x26.
const H265_SPS = nal(SC4, 0x42, [0x01, 0x00])
const H265_PPS = nal(SC4, 0x44, [0x01, 0x00])
const H265_IDR = nal(SC4, 0x26, [0x01, 0x00])

describe('annexBHasParameterSets', () => {
  it('h264: true when both SPS and PPS are present (before the IDR)', () => {
    expect(annexBHasParameterSets(Buffer.concat([H264_SPS, H264_PPS, H264_IDR]), 'h264')).toBe(true)
  })

  it('h264: false for a bare IDR with no parameter sets (the Reolink high-profile case)', () => {
    expect(annexBHasParameterSets(H264_IDR, 'h264')).toBe(false)
  })

  it('h264: false when only SPS is present (PPS missing)', () => {
    expect(annexBHasParameterSets(Buffer.concat([H264_SPS, H264_IDR]), 'h264')).toBe(false)
  })

  it('handles 3-byte start codes', () => {
    const sps3 = nal(SC3, 0x67)
    const pps3 = nal(SC3, 0x68)
    expect(annexBHasParameterSets(Buffer.concat([sps3, pps3]), 'h264')).toBe(true)
  })

  it('h265: true with SPS+PPS, false for a bare IDR', () => {
    expect(annexBHasParameterSets(Buffer.concat([H265_SPS, H265_PPS, H265_IDR]), 'h265')).toBe(true)
    expect(annexBHasParameterSets(H265_IDR, 'h265')).toBe(false)
    expect(annexBHasParameterSets(H265_IDR, 'hevc')).toBe(false)
  })

  it('does not misread an H.264 stream as H.265 (type bits differ)', () => {
    // H.264 SPS (0x67 → type 7) must NOT count as an H.265 param set.
    expect(annexBHasParameterSets(Buffer.concat([H264_SPS, H264_PPS]), 'h265')).toBe(false)
  })

  it('empty / tiny buffers are safely false', () => {
    expect(annexBHasParameterSets(Buffer.alloc(0), 'h264')).toBe(false)
    expect(annexBHasParameterSets(Buffer.from([0x00, 0x00]), 'h264')).toBe(false)
  })
})
