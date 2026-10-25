import { describe, expect, it } from 'vitest'
import { decodeVectorBase64, encodeVectorBase64, vectorDimFromBase64 } from '../vector-codec.js'

describe('vector codec', () => {
  it('round-trips a Float32Array exactly', () => {
    const original = Float32Array.from([1, -1, 0.5, 0, 1e-8, 12345.75])
    const decoded = decodeVectorBase64(encodeVectorBase64(original))
    expect(Array.from(decoded)).toEqual(Array.from(original))
  })

  it('accepts a plain number array and returns Float32 precision', () => {
    // 0.1 is not representable in binary32, so the round-trip is Float32(0.1),
    // not the float64 literal. Asserting the exact float64 would be wrong.
    const decoded = decodeVectorBase64(encodeVectorBase64([0.1, 0.2]))
    expect(decoded[0]).toBeCloseTo(0.1, 6)
    expect(decoded).toBeInstanceOf(Float32Array)
  })

  it('is materially smaller than the JSON encoding it replaces', () => {
    const vector = new Float32Array(512).fill(0.123456)
    const base64 = encodeVectorBase64(vector)
    const json = JSON.stringify(Array.from(vector))
    // 512 dims: 2,048 bytes raw, 2,732 as base64, against 10,241 as JSON text
    // for this fill value — a 3.75x reduction. The live object-embedding rows
    // measured ~11.7 KB each, which is this plus the other columns.
    expect(base64.length).toBeLessThan(3000)
    expect(json.length / base64.length).toBeGreaterThan(3.5)
  })

  it('reads the dimension without decoding', () => {
    expect(vectorDimFromBase64(encodeVectorBase64(new Float32Array(512)))).toBe(512)
    expect(vectorDimFromBase64(encodeVectorBase64(new Float32Array(0)))).toBe(0)
  })

  it('handles an empty vector', () => {
    expect(decodeVectorBase64(encodeVectorBase64(new Float32Array(0))).length).toBe(0)
  })

  it('THROWS on a truncated payload rather than ranking a short vector', () => {
    // A silently-shortened vector would still produce a plausible cosine score.
    const truncated = Buffer.from(new Uint8Array([1, 2, 3])).toString('base64')
    expect(() => decodeVectorBase64(truncated)).toThrow(/whole number of Float32/)
  })

  it('pins little-endian so a vector written on one node decodes on another', () => {
    // 1.0 as Float32 LE is 00 00 80 3F.
    expect(encodeVectorBase64(Float32Array.from([1]))).toBe(
      Buffer.from(new Uint8Array([0x00, 0x00, 0x80, 0x3f])).toString('base64'),
    )
  })
})
