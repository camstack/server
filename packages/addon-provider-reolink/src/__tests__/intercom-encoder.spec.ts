import { describe, expect, it } from 'vitest'
import { encodeImaAdpcm } from '../intercom-encoder'

describe('encodeImaAdpcm', () => {
  it('emits one block of (4 + blockSizeBytes) for samplesPerBlock samples', () => {
    const blockSizeBytes = 1024
    const samplesPerBlock = blockSizeBytes * 2 + 1
    const pcm = new Int16Array(samplesPerBlock)
    pcm[0] = 1234 // predictor seed
    const out = encodeImaAdpcm(pcm, blockSizeBytes)
    expect(out.length).toBe(4 + blockSizeBytes)
    // Predictor seed lands in bytes [0..1] little-endian.
    expect(out.readInt16LE(0)).toBe(1234)
    // Step index (byte 2) is always 0 — we re-seed every block so the
    // decoder doesn't need carried state.
    expect(out.readUInt8(2)).toBe(0)
    // Padding (byte 3) is always 0.
    expect(out.readUInt8(3)).toBe(0)
  })

  it('rounds up to a full block for partial trailing samples', () => {
    const blockSizeBytes = 256
    const samplesPerBlock = blockSizeBytes * 2 + 1
    // 1.5 blocks worth of samples → 2 blocks emitted (the second
    // block is padded with whatever the encoder produces from
    // zero-extended PCM, which the camera tolerates).
    const pcm = new Int16Array(Math.floor(samplesPerBlock * 1.5))
    const out = encodeImaAdpcm(pcm, blockSizeBytes)
    expect(out.length).toBe((4 + blockSizeBytes) * 2)
  })

  it('emits N blocks for N × samplesPerBlock samples', () => {
    const blockSizeBytes = 512
    const samplesPerBlock = blockSizeBytes * 2 + 1
    const blocks = 5
    const pcm = new Int16Array(samplesPerBlock * blocks)
    const out = encodeImaAdpcm(pcm, blockSizeBytes)
    expect(out.length).toBe((4 + blockSizeBytes) * blocks)
  })

  it('encodes a known sine fragment without throwing', () => {
    const blockSizeBytes = 1024
    const samplesPerBlock = blockSizeBytes * 2 + 1
    const pcm = new Int16Array(samplesPerBlock)
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(Math.sin(i * 0.1) * 16000)
    }
    const out = encodeImaAdpcm(pcm, blockSizeBytes)
    expect(out.length).toBe(4 + blockSizeBytes)
    // First sample of the block is preserved verbatim as the predictor.
    expect(out.readInt16LE(0)).toBe(pcm[0])
  })

  it('returns an empty buffer for empty PCM input', () => {
    const out = encodeImaAdpcm(new Int16Array(0), 1024)
    expect(out.length).toBe(0)
  })
})
