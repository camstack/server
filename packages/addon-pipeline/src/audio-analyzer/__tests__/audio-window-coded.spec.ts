/**
 * `AudioWindowAccumulator` over CODED chunks (D455).
 *
 * The plane now carries the fleet's G.711 as one byte per sample instead of
 * four (D455 extends D450's "source rate" to "source bytes"). Two things had
 * to change here and each is a way the window can be silently wrong:
 *
 *   1. **Duration.** The accumulator divided `byteLength` by 4 to count
 *      samples. On a coded chunk that undercounts by 4x, so it would buffer
 *      FOUR seconds of audio before believing it had one, and hand the
 *      classifier a 4 s window it throttles against a 1 s cadence.
 *   2. **Expansion.** `AudioChunkInput` — the analyzer cap's contract — is
 *      unchanged and stays f32le. The window is expanded at FLUSH, once, next
 *      to the consumer that needs floats. That is what keeps this deployable
 *      while the analyzer runs on three nodes from a different bundle: no
 *      analyzer, old or new, is ever handed bytes it cannot read.
 *
 * And the format is part of the window's identity, not just its rate: a
 * subscription that flips from coded to f32le mid-window would otherwise
 * concatenate one byte per sample with four and label the result 8 kHz.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DecodedAudioChunkWire } from '@camstack/types'
import { AudioWindowAccumulator } from '../audio-window-accumulator.js'

/** One 500 ms μ-law mono chunk at 8 kHz — 4000 bytes, one per sample. */
function codedChunk(fill = 0xff, timestamp = 1_000): DecodedAudioChunkWire {
  return {
    data: new Uint8Array(4000).fill(fill),
    sampleRate: 8000,
    channels: 1,
    timestamp,
    format: 'pcmu',
  }
}

/** One 500 ms f32le mono chunk at 8 kHz — 16 000 bytes. */
function wideChunk(fill = 0.25, timestamp = 1_000): DecodedAudioChunkWire {
  const f32 = new Float32Array(4000).fill(fill)
  return {
    data: new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength),
    sampleRate: 8000,
    channels: 1,
    timestamp,
  }
}

describe('AudioWindowAccumulator over coded chunks', () => {
  it('counts ONE sample per coded byte — two 500 ms chunks make one window, not eight', () => {
    const acc = new AudioWindowAccumulator(101)
    expect(acc.push(codedChunk())).toBeNull()
    const window = acc.push(codedChunk())
    expect(window).not.toBeNull()
    expect(window!.sampleRate).toBe(8000)
  })

  it('flushes f32le to the analyzer — the cap contract is unchanged', () => {
    const acc = new AudioWindowAccumulator(101)
    acc.push(codedChunk(0x80))
    const window = acc.push(codedChunk(0x80))!
    // 8000 samples expanded to 4 bytes each. The analyzer reads this with
    // `float32FromBytes` and has no idea a codec was ever involved.
    expect(window.data.byteLength).toBe(8000 * 4)
    // 32124/32768 is ITU-T G.711's μ-law full scale for code 0x80. It was
    // pinned at 8031/32768 — exactly a quarter of it — until D459 corrected
    // the table, and this spec was not re-anchored with it, so it has been red
    // on `main` since. Re-anchored here rather than left broken: a failing
    // guard states nothing, and a guard nobody re-anchors is how the
    // quarter-scale table survived unnoticed in the first place (D461).
    const f32 = new Float32Array(window.data.buffer, window.data.byteOffset, 8000)
    expect(f32[0]).toBeCloseTo(32124 / 32768, 6)
    expect(f32[7999]).toBeCloseTo(32124 / 32768, 6)
  })

  it('expands μ-law silence to ~0 — the level meter must read the same as before', () => {
    const acc = new AudioWindowAccumulator(101)
    acc.push(codedChunk(0xff))
    const window = acc.push(codedChunk(0xff))!
    const f32 = new Float32Array(window.data.buffer, window.data.byteOffset, 8000)
    let sumSquares = 0
    for (const s of f32) sumSquares += s * s
    expect(Math.sqrt(sumSquares / f32.length)).toBeCloseTo(0, 6)
  })

  it('leaves an f32le window untouched — no codec, no expansion, no copy of a copy', () => {
    const acc = new AudioWindowAccumulator(101)
    acc.push(wideChunk())
    const window = acc.push(wideChunk())!
    expect(window.data.byteLength).toBe(8000 * 4)
    const f32 = new Float32Array(window.data.buffer, window.data.byteOffset, 8000)
    expect(f32[0]).toBeCloseTo(0.25, 6)
  })

  it('reports the FORMAT beside the rate, so a leg still paying 4x is named', () => {
    const onFormat = vi.fn()
    const acc = new AudioWindowAccumulator(101, onFormat)
    acc.push(codedChunk())
    expect(onFormat).toHaveBeenCalledWith({
      from: null,
      to: { sampleRate: 8000, channels: 1, format: 'pcmu' },
      droppedMs: 0,
    })
  })

  it('treats a format flip under an OPEN window as a format change and drops the partial', () => {
    const onFormat = vi.fn()
    const acc = new AudioWindowAccumulator(101, onFormat)
    // 500 ms of coded audio is buffered…
    expect(acc.push(codedChunk())).toBeNull()
    // …then the broker is redeployed and the same 8 kHz mono stream arrives
    // as f32le. Concatenating the two would label 4000 coded bytes as 1000
    // float samples and hand the classifier a second of noise.
    expect(acc.push(wideChunk())).toBeNull()

    expect(onFormat).toHaveBeenCalledTimes(2)
    expect(onFormat).toHaveBeenLastCalledWith({
      from: { sampleRate: 8000, channels: 1, format: 'pcmu' },
      to: { sampleRate: 8000, channels: 1, format: 'f32le' },
      droppedMs: 500,
    })
  })

  it('an absent format is f32le, and is reported as f32le rather than as unknown', () => {
    const onFormat = vi.fn()
    const acc = new AudioWindowAccumulator(101, onFormat)
    acc.push(wideChunk())
    expect(onFormat).toHaveBeenCalledWith({
      from: null,
      to: { sampleRate: 8000, channels: 1, format: 'f32le' },
      droppedMs: 0,
    })
  })

  it('carries the coded bytes across a chunk boundary without an off-by-a-sample', () => {
    const acc = new AudioWindowAccumulator(101)
    const first = codedChunk(0x80)
    const second = codedChunk(0xff)
    acc.push(first)
    const window = acc.push(second)!
    const f32 = new Float32Array(window.data.buffer, window.data.byteOffset, 8000)
    expect(f32[3999]).toBeCloseTo(32124 / 32768, 6)
    expect(f32[4000]).toBeCloseTo(0, 6)
  })
})
