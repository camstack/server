import { describe, it, expect } from 'vitest'
import {
  audioChunkBytesPerSample,
  expandAudioChunkToF32le,
  isAudioChunkFormat,
  AUDIO_CHUNK_FORMATS,
} from '../audio/audio-chunk-format.js'

/**
 * The audio plane's format contract (D455).
 *
 * `expandAudioChunkToF32le` is the ONE place a coded audio window becomes
 * float samples. It exists so the plane can carry the source bytes — one
 * G.711 byte per sample instead of four — and the consumer that needs floats
 * pays for them next to itself. Both the broker (which must still serve a
 * subscriber that did not ask for coded bytes) and the orchestrator's window
 * accumulator call it; a second table anywhere is the bug this file guards.
 */
describe('audio chunk format', () => {
  it('costs one byte per sample coded and four expanded — the whole point of the lever', () => {
    expect(audioChunkBytesPerSample('pcmu')).toBe(1)
    expect(audioChunkBytesPerSample('pcma')).toBe(1)
    expect(audioChunkBytesPerSample('f32le')).toBe(4)
  })

  it('expands μ-law to exactly four bytes per input byte', () => {
    const coded = new Uint8Array([0x00, 0x7f, 0x80, 0xff])
    const expanded = expandAudioChunkToF32le(coded, 'pcmu')
    expect(expanded.byteLength).toBe(coded.byteLength * 4)
  })

  it('decodes μ-law to the ITU-T G.711 scale, not the quarter-scale it shipped with', () => {
    // D455 pinned this table VERBATIM at the quarter scale it had always had,
    // so that correcting it would be a conscious act with its own record.
    // D459 is that act: the magnitude is now the standard's closed form
    // `((8*m + 132) << e) - 132`, and the extremes are ±0.9803 where they used
    // to be ±0.2451 — exactly four times, on all 256 codes.
    //
    // Every G.711 camera on the fleet was metered 12.04 dB low until this
    // landed, and every configured audio threshold is calibrated against the
    // old scale. This test pins the CORRECT scale; the thresholds are a
    // separate, still-open half (D459 §2).
    const coded = new Uint8Array([0xff, 0x80, 0x00, 0x7f])
    const f32 = new Float32Array(expandAudioChunkToF32le(coded, 'pcmu').buffer)
    expect(f32[0]).toBeCloseTo(0, 6)
    expect(f32[1]).toBeCloseTo(32124 / 32768, 6)
    expect(f32[2]).toBeCloseTo(-32124 / 32768, 6)
    expect(f32[3]).toBeCloseTo(-0, 6)
  })

  it('decodes A-law with its own table — the two codecs are not interchangeable', () => {
    const coded = new Uint8Array([0xd5, 0x2a])
    const ulaw = new Float32Array(expandAudioChunkToF32le(coded, 'pcmu').buffer)
    const alaw = new Float32Array(expandAudioChunkToF32le(coded, 'pcma').buffer)
    expect(alaw[0]).not.toBeCloseTo(ulaw[0]!, 3)
  })

  it('never re-expands f32le bytes — the samples come back unchanged', () => {
    const source = new Float32Array([0.25, -0.5, 0.75])
    const bytes = new Uint8Array(source.buffer.slice(0))
    const out = expandAudioChunkToF32le(bytes, 'f32le')
    expect(out.byteLength).toBe(bytes.byteLength)
    expect([...new Float32Array(out.buffer)]).toEqual([0.25, -0.5, 0.75])
  })

  it('always returns owned, 0-offset bytes a Float32Array view can be built over', () => {
    const out = expandAudioChunkToF32le(new Uint8Array([0xff, 0x80]), 'pcmu')
    expect(out.byteOffset).toBe(0)
    expect(() => new Float32Array(out.buffer)).not.toThrow()
  })

  it('expands from a misaligned view — msgpack hands out subviews at any offset', () => {
    // The window accumulator's bytes arrive as a subview of msgpack's internal
    // buffer, whose byteOffset is not guaranteed 4-byte aligned. A `new
    // Float32Array(buf, offset)` on such a view throws; the expander must not.
    const backing = new Uint8Array(9)
    backing.set([0xff, 0xff, 0xff, 0xff], 1)
    const misaligned = backing.subarray(1, 5)
    expect(misaligned.byteOffset % 4).not.toBe(0)
    expect(() => expandAudioChunkToF32le(misaligned, 'pcmu')).not.toThrow()
    expect(expandAudioChunkToF32le(misaligned, 'pcmu').byteLength).toBe(16)
  })

  it('names the formats it knows, so an unknown one is refused rather than guessed', () => {
    expect([...AUDIO_CHUNK_FORMATS]).toEqual(['f32le', 'pcmu', 'pcma'])
    expect(isAudioChunkFormat('pcmu')).toBe(true)
    expect(isAudioChunkFormat('s16le')).toBe(false)
    expect(isAudioChunkFormat(undefined)).toBe(false)
  })
})
