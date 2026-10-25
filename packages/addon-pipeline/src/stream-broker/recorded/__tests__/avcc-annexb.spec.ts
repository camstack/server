import { describe, it, expect } from 'vitest'
import {
  parseNalLengthSize,
  extractParameterSetsAnnexB,
  avccSampleToAnnexB,
  buildKeyframeAnnexB,
} from '../avcc-annexb'

const START = [0, 0, 0, 1]
const u8 = (...b: number[]): Uint8Array => Uint8Array.from(b)

/** Split an Annex-B blob (4-byte start codes) into its NAL payloads. */
function splitAnnexB(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let start = -1
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      if (start >= 0) out.push(buf.subarray(start, i))
      start = i + 4
      i += 3
    }
  }
  if (start >= 0) out.push(buf.subarray(start))
  return out
}

// Minimal avcC (header stripped): version, profile, compat, level, lenSize,
// numSPS, [len SPS], numPPS, [len PPS].
function makeAvcC(nalLengthSize: number, sps: number[], pps: number[]): Uint8Array {
  const lenMinus1 = nalLengthSize - 1
  return u8(
    1,
    0x64,
    0x00,
    0x1f, // version, profile, compat, level
    0xfc | lenMinus1, // 6 reserved bits + lengthSizeMinusOne
    0xe0 | 1, // 3 reserved bits + numSPS=1
    (sps.length >> 8) & 0xff,
    sps.length & 0xff,
    ...sps,
    1, // numPPS=1
    (pps.length >> 8) & 0xff,
    pps.length & 0xff,
    ...pps,
  )
}

// Minimal hvcC (header stripped) to byte 22 = numOfArrays, then 3 arrays
// (VPS/SPS/PPS), each with one NAL.
function makeHvcC(nalLengthSize: number, vps: number[], sps: number[], pps: number[]): Uint8Array {
  const lenMinus1 = nalLengthSize - 1
  const head = new Array<number>(22).fill(0)
  head[0] = 1 // configurationVersion
  head[21] = 0xfc | lenMinus1 // constantFrameRate… + lengthSizeMinusOne
  const arr = (nalType: number, nal: number[]): number[] => [
    nalType & 0x3f, // array flags(2) + NAL_unit_type(6)
    0x00,
    0x01, // numNalus = 1
    (nal.length >> 8) & 0xff,
    nal.length & 0xff,
    ...nal,
  ]
  return u8(
    ...head,
    3, // numOfArrays
    ...arr(32, vps),
    ...arr(33, sps),
    ...arr(34, pps),
  )
}

describe('parseNalLengthSize', () => {
  it('reads avcC lengthSizeMinusOne (byte 4, low 2 bits)', () => {
    expect(parseNalLengthSize(makeAvcC(4, [0x67, 1], [0x68, 2]), false)).toBe(4)
    expect(parseNalLengthSize(makeAvcC(2, [0x67, 1], [0x68, 2]), false)).toBe(2)
    expect(parseNalLengthSize(makeAvcC(1, [0x67, 1], [0x68, 2]), false)).toBe(1)
  })
  it('reads hvcC lengthSizeMinusOne (byte 21, low 2 bits)', () => {
    expect(parseNalLengthSize(makeHvcC(4, [0x40], [0x42], [0x44]), true)).toBe(4)
    expect(parseNalLengthSize(makeHvcC(3, [0x40], [0x42], [0x44]), true)).toBe(3)
  })
  it('throws on a config too short to carry the field', () => {
    expect(() => parseNalLengthSize(u8(1, 2), false)).toThrow(RangeError)
    expect(() => parseNalLengthSize(u8(1, 2), true)).toThrow(RangeError)
  })
})

describe('avccSampleToAnnexB', () => {
  it('converts a single length-prefixed NAL (4-byte size)', () => {
    const sample = u8(0, 0, 0, 3, 0xaa, 0xbb, 0xcc)
    expect([...avccSampleToAnnexB(sample, 4)]).toEqual([...START, 0xaa, 0xbb, 0xcc])
  })
  it('converts a MULTI-NAL sample into two start-code-framed NALs', () => {
    const sample = u8(
      0,
      0,
      0,
      2,
      0x11,
      0x22, // NAL 1 (len 2)
      0,
      0,
      0,
      3,
      0x33,
      0x44,
      0x55, // NAL 2 (len 3)
    )
    const nals = splitAnnexB(avccSampleToAnnexB(sample, 4))
    expect(nals.map((n) => [...n])).toEqual([
      [0x11, 0x22],
      [0x33, 0x44, 0x55],
    ])
  })
  it('honours a 2-byte length size', () => {
    const sample = u8(0, 2, 0x11, 0x22, 0, 1, 0x33)
    const nals = splitAnnexB(avccSampleToAnnexB(sample, 2))
    expect(nals.map((n) => [...n])).toEqual([[0x11, 0x22], [0x33]])
  })
  it('skips zero-length NALs', () => {
    const sample = u8(0, 0, 0, 0, 0, 0, 0, 1, 0x99)
    const nals = splitAnnexB(avccSampleToAnnexB(sample, 4))
    expect(nals.map((n) => [...n])).toEqual([[0x99]])
  })
  it('throws when a length field overruns the sample', () => {
    const sample = u8(0, 0, 0, 9, 0xaa, 0xbb)
    expect(() => avccSampleToAnnexB(sample, 4)).toThrow(RangeError)
  })
})

describe('extractParameterSetsAnnexB — H.264 (avcC)', () => {
  it('emits SPS then PPS as start-code-framed NALs', () => {
    const sps = [0x67, 0x42, 0x00]
    const pps = [0x68, 0xce]
    const nals = splitAnnexB(extractParameterSetsAnnexB(makeAvcC(4, sps, pps), false))
    expect(nals.map((n) => [...n])).toEqual([sps, pps])
  })
})

describe('extractParameterSetsAnnexB — H.265 (hvcC)', () => {
  it('emits VPS, SPS, PPS from the hvcC arrays', () => {
    const vps = [0x40, 0x01, 0x0c]
    const sps = [0x42, 0x01, 0x01]
    const pps = [0x44, 0x01, 0xc0]
    const nals = splitAnnexB(extractParameterSetsAnnexB(makeHvcC(4, vps, sps, pps), true))
    expect(nals.map((n) => [...n])).toEqual([vps, sps, pps])
    // NAL types (HEVC: (byte>>1)&0x3f): 32=VPS, 33=SPS, 34=PPS
    expect(nals.map((n) => (n[0]! >> 1) & 0x3f)).toEqual([32, 33, 34])
  })
})

describe('buildKeyframeAnnexB', () => {
  it('prepends H.264 SPS/PPS before the sample NALs', () => {
    const sps = [0x67, 0x42, 0x00]
    const pps = [0x68, 0xce]
    const desc = makeAvcC(4, sps, pps)
    const sample = u8(0, 0, 0, 4, 0x65, 0x88, 0x84, 0x00) // one IDR slice (type 5)
    const nals = splitAnnexB(buildKeyframeAnnexB(sample, desc, false))
    expect(nals.map((n) => n[0]! & 0x1f)).toEqual([7, 8, 5]) // SPS=7, PPS=8, IDR=5
  })
  it('prepends H.265 VPS/SPS/PPS before the sample NALs', () => {
    const vps = [0x40, 0x01]
    const sps = [0x42, 0x01]
    const pps = [0x44, 0x01]
    const desc = makeHvcC(4, vps, sps, pps)
    const sample = u8(0, 0, 0, 3, 0x26, 0x01, 0xaf) // IDR_W_RADL (type 19)
    const nals = splitAnnexB(buildKeyframeAnnexB(sample, desc, true))
    expect(nals.map((n) => (n[0]! >> 1) & 0x3f)).toEqual([32, 33, 34, 19])
  })
  it('propagates a RangeError from a malformed sample', () => {
    const desc = makeAvcC(4, [0x67, 1], [0x68, 2])
    expect(() => buildKeyframeAnnexB(u8(0, 0, 0, 50, 1, 2), desc, false)).toThrow(RangeError)
  })
})
