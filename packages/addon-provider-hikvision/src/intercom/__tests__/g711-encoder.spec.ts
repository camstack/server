import { describe, it, expect } from 'vitest'
import {
  encodePcm16,
  encodePcm16ToUlaw,
  encodePcm16ToAlaw,
  resolveHikvisionAudioCodec,
} from '../g711-encoder.js'

/**
 * Build a PCM s16le mono Buffer from sample values, returned as a view at a
 * deliberately ODD byteOffset inside a larger backing ArrayBuffer.
 *
 * This mirrors EXACTLY what `@msgpack/msgpack`'s `decode()` hands back for a
 * binary (`bin`) field after a UDS hop: the `data` of an `AudioPcmChunk` is a
 * Buffer/Uint8Array that is a *view* into the larger frame-decode buffer, at a
 * byteOffset whose parity is payload-dependent (~63% of the time it is odd).
 * An odd byteOffset makes a naive `new Int16Array(buf.buffer, buf.byteOffset)`
 * throw `RangeError: start offset of Int16Array should be a multiple of 2`.
 */
function pcmAtOddOffset(samples: readonly number[]): Buffer {
  const i16 = Int16Array.from(samples)
  const byteLen = i16.byteLength
  // +1 forces an odd start offset; +2 leaves head/tail slack.
  const backing = new ArrayBuffer(byteLen + 3)
  const view = new Uint8Array(backing, 1, byteLen) // offset 1 → odd
  view.set(new Uint8Array(i16.buffer, i16.byteOffset, byteLen))
  const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
  expect(buf.byteOffset & 1).toBe(1) // guard: genuinely odd
  return buf
}

/** Same samples packed into an aligned (offset 0) Buffer. */
function pcmAligned(samples: readonly number[]): Buffer {
  const i16 = Int16Array.from(samples)
  return Buffer.from(i16.buffer.slice(0))
}

const SAMPLES = [0, 1, -1, 100, -100, 1000, -1000, 8000, -8000, 32767, -32768, 12345]

describe('g711 encoders — odd-byteOffset (MsgPack-deserialized) input', () => {
  it('µ-law: encodes a Buffer viewed at an ODD byteOffset identically to an aligned one', () => {
    const odd = pcmAtOddOffset(SAMPLES)
    const aligned = pcmAligned(SAMPLES)
    const fromOdd = encodePcm16ToUlaw(odd)
    const fromAligned = encodePcm16ToUlaw(aligned)
    expect(fromOdd.length).toBe(SAMPLES.length)
    expect(Buffer.compare(fromOdd, fromAligned)).toBe(0)
  })

  it('A-law: encodes a Buffer viewed at an ODD byteOffset identically to an aligned one', () => {
    const odd = pcmAtOddOffset(SAMPLES)
    const aligned = pcmAligned(SAMPLES)
    const fromOdd = encodePcm16ToAlaw(odd)
    const fromAligned = encodePcm16ToAlaw(aligned)
    expect(fromOdd.length).toBe(SAMPLES.length)
    expect(Buffer.compare(fromOdd, fromAligned)).toBe(0)
  })

  it('encodePcm16 dispatcher: odd-offset input works for both codecs', () => {
    const odd = pcmAtOddOffset(SAMPLES)
    expect(encodePcm16(odd, 'g711ulaw').length).toBe(SAMPLES.length)
    expect(encodePcm16(odd, 'g711alaw').length).toBe(SAMPLES.length)
  })
})

describe('g711 encoders — reference vectors (aligned input)', () => {
  // ITU-T G.711 reference values (verified against libavcodec pcm_mulaw /
  // pcm_alaw round-trip): silence and full-scale extremes.
  it('µ-law encodes silence to 0xFF', () => {
    const out = encodePcm16ToUlaw(pcmAligned([0]))
    expect(out[0]).toBe(0xff)
  })

  it('A-law encodes silence to 0xD5', () => {
    const out = encodePcm16ToAlaw(pcmAligned([0]))
    expect(out[0]).toBe(0xd5)
  })

  it('rejects odd-LENGTH buffers (half sample) for both codecs', () => {
    const oddLen = Buffer.from([0x01, 0x02, 0x03]) // 3 bytes = 1.5 samples
    expect(() => encodePcm16ToUlaw(oddLen)).toThrow()
    expect(() => encodePcm16ToAlaw(oddLen)).toThrow()
  })
})

describe('resolveHikvisionAudioCodec', () => {
  it('defaults to µ-law for unknown/empty', () => {
    expect(resolveHikvisionAudioCodec(null)).toBe('g711ulaw')
    expect(resolveHikvisionAudioCodec('PCM')).toBe('g711ulaw')
  })
  it('maps A-law spellings', () => {
    expect(resolveHikvisionAudioCodec('G.711alaw')).toBe('g711alaw')
    expect(resolveHikvisionAudioCodec('G711A')).toBe('g711alaw')
  })
})
