/**
 * `AudioWindowAccumulator` — the window is anchored to ONE format, and a
 * format that changes under it is reported, never silently mixed (D450, in
 * the D427 vocabulary: the audio decision of a relay is never silent).
 *
 * The plane started carrying 8 kHz f32le for G.711 cameras on 2026-09-11
 * (it used to upsample to 16 kHz at the source). A broker redeploy flips the
 * rate of a live subscription mid-window: without the guard, the flushed
 * window carries 16 kHz bytes labelled 8 kHz, and the classifier eats one
 * garbage second per camera with no line saying so.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DecodedAudioChunkWire } from '@camstack/types'
import { AudioWindowAccumulator } from '../audio-window-accumulator.js'

const F32 = 4

/** One 500 ms f32le mono chunk at `sampleRate`, every sample = `fill`. */
function chunkOf(sampleRate: number, fill: number, timestamp = 1_000): DecodedAudioChunkWire {
  const samples = sampleRate / 2
  const f32 = new Float32Array(samples).fill(fill)
  return {
    data: new Uint8Array(f32.buffer, f32.byteOffset, samples * F32),
    sampleRate,
    channels: 1,
    timestamp,
  }
}

function floatsOf(data: Uint8Array): Float32Array {
  const aligned = data.byteOffset % 4 === 0 ? data : new Uint8Array(data)
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / F32)
}

describe('AudioWindowAccumulator', () => {
  it('flushes one ~1 s window from two 500 ms chunks at the SOURCE rate (8 kHz)', () => {
    const acc = new AudioWindowAccumulator(101)
    expect(acc.push(chunkOf(8000, 0.25))).toBeNull()
    const window = acc.push(chunkOf(8000, 0.25))
    expect(window).not.toBeNull()
    expect(window!.sampleRate).toBe(8000)
    expect(window!.channels).toBe(1)
    expect(window!.deviceId).toBe(101)
    // 8000 samples × 4 bytes: the window is the source bytes, not 2× them.
    expect(window!.data.byteLength).toBe(8000 * F32)
  })

  it('reports the format ONCE on the first chunk and stays quiet while it holds', () => {
    const onFormat = vi.fn()
    const acc = new AudioWindowAccumulator(101, onFormat)
    for (let i = 0; i < 4; i++) acc.push(chunkOf(8000, 0.1))
    expect(onFormat).toHaveBeenCalledTimes(1)
    expect(onFormat).toHaveBeenCalledWith({
      from: null,
      to: { sampleRate: 8000, channels: 1, format: 'f32le' },
      droppedMs: 0,
    })
  })

  it('a chunk whose rate differs from the OPEN window drops the partial window and reports it', () => {
    const onFormat = vi.fn()
    const acc = new AudioWindowAccumulator(101, onFormat)
    // 500 ms of 16 kHz (the legacy upsampled rate) opens a window…
    expect(acc.push(chunkOf(16000, 0.9))).toBeNull()
    // …then the redeployed broker delivers 8 kHz.
    expect(acc.push(chunkOf(8000, 0.1))).toBeNull()
    expect(onFormat).toHaveBeenLastCalledWith({
      from: { sampleRate: 16000, channels: 1, format: 'f32le' },
      to: { sampleRate: 8000, channels: 1, format: 'f32le' },
      droppedMs: 500,
    })
    // The next 8 kHz chunk closes a window made ONLY of 8 kHz bytes.
    const window = acc.push(chunkOf(8000, 0.1))
    expect(window).not.toBeNull()
    expect(window!.sampleRate).toBe(8000)
    expect(window!.data.byteLength).toBe(8000 * F32)
    const floats = floatsOf(window!.data)
    for (const s of floats) expect(s).toBeCloseTo(0.1, 5)
  })

  it('a rate change BETWEEN windows is reported with nothing dropped', () => {
    const onFormat = vi.fn()
    const acc = new AudioWindowAccumulator(101, onFormat)
    acc.push(chunkOf(16000, 0.5))
    expect(acc.push(chunkOf(16000, 0.5))).not.toBeNull() // window closed, nothing open
    acc.push(chunkOf(8000, 0.5))
    expect(onFormat).toHaveBeenCalledTimes(2)
    expect(onFormat).toHaveBeenLastCalledWith({
      from: { sampleRate: 16000, channels: 1, format: 'f32le' },
      to: { sampleRate: 8000, channels: 1, format: 'f32le' },
      droppedMs: 0,
    })
  })

  it('a channel-count change is a format change too', () => {
    const onFormat = vi.fn()
    const acc = new AudioWindowAccumulator(101, onFormat)
    acc.push(chunkOf(16000, 0.5))
    const stereo: DecodedAudioChunkWire = { ...chunkOf(16000, 0.5), channels: 2 }
    expect(acc.push(stereo)).toBeNull()
    expect(onFormat).toHaveBeenLastCalledWith({
      from: { sampleRate: 16000, channels: 1, format: 'f32le' },
      to: { sampleRate: 16000, channels: 2, format: 'f32le' },
      droppedMs: 500,
    })
  })
})
