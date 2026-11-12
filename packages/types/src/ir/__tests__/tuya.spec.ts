import { describe, expect, it } from 'vitest'
import { decodeTuya, encodeTuya } from '../tuya.js'
import { fastlzCompress, fastlzDecompress } from '../fastlz.js'
import { IrCodecError } from '../ir-error.js'
import { IrPayloadSchema, toTimings } from '../ir-payload.js'

// NOTE: no published device capture with known timings was reachable offline;
// the vector below is a hand-built level-1 stream (literal run + back-reference)
// whose decoding follows the FastLZ level-1 spec, so the decoder is pinned to
// the format rather than to our own encoder.
// bytes: 10 00 | 20 00 | (match len 4, distance 4) | = 4 durations 16,32,16,32
// literal run of 4 bytes: ctrl 3; match: len 4 -> enc 2 -> ctrl 0x40, dist-1 = 3
const HAND_STREAM = Uint8Array.from([3, 0x10, 0x00, 0x20, 0x00, 0x40, 0x03])
const toB64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')

describe('tuya codec', () => {
  it('decodes a hand-built level-1 stream with a back-reference', () => {
    expect(decodeTuya(toB64(HAND_STREAM))).toEqual([16, -32, 16, -32])
  })

  it('round-trips decode -> encode -> decode', () => {
    const timings = [
      9000, -4500, 560, -560, 560, -1690, 560, -560, 560, -560, 560, -1690, 560, -560, 560, -45000,
    ]
    const code = encodeTuya(timings)
    expect(decodeTuya(code)).toEqual(timings)
    expect(decodeTuya(encodeTuya(decodeTuya(code)))).toEqual(timings)
  })

  it('compresses a repetitive train smaller than the raw bytes', () => {
    const timings = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 560 : -560))
    const bytes = Buffer.from(encodeTuya(timings), 'base64')
    expect(bytes.length).toBeLessThan(timings.length * 2)
    expect(decodeTuya(encodeTuya(timings))).toEqual(timings)
  })

  it('fastlz round-trips long runs and incompressible data', () => {
    const run = new Uint8Array(1000).fill(7)
    expect(fastlzDecompress(fastlzCompress(run))).toEqual(run)
    const noise = Uint8Array.from({ length: 300 }, (_, i) => (i * 131 + 17) % 251)
    expect(fastlzDecompress(fastlzCompress(noise))).toEqual(noise)
  })

  it.each([
    ['not base64', '!!!!'],
    ['empty', ''],
    ['truncated literal', toB64(Uint8Array.from([5, 1, 2]))],
    ['back-reference before start', toB64(Uint8Array.from([0, 1, 0x40, 9]))],
    ['odd byte count', toB64(Uint8Array.from([2, 1, 2, 3]))],
    ['zero duration', toB64(Uint8Array.from([3, 0, 0, 1, 0]))],
  ])('refuses %s with a typed error', (_name, code) => {
    expect(() => decodeTuya(code)).toThrow(IrCodecError)
    try {
      decodeTuya(code)
    } catch (err: unknown) {
      expect(err instanceof IrCodecError && err.code).toBe('tuya-malformed')
    }
  })

  it('refuses a duration that does not fit 16 bits', () => {
    expect(() => encodeTuya([70000, -500])).toThrow(IrCodecError)
  })
})

describe('native payload', () => {
  it('resolves through the codec table', () => {
    const payload = IrPayloadSchema.parse({
      kind: 'native',
      format: 'tuya',
      code: toB64(HAND_STREAM),
    })
    expect(toTimings(payload).timings).toEqual([16, -32, 16, -32])
  })
  it('rejects an unknown format', () => {
    expect(IrPayloadSchema.safeParse({ kind: 'native', format: 'nec', code: 'x' }).success).toBe(
      false,
    )
  })
})
