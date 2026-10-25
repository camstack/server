/**
 * Real node-av encode → decode roundtrip coverage. node-av is installed in the
 * workspace, so these tests exercise the ACTUAL native codec path — the risky
 * part of this addon (libavcodec/libswresample lifecycle + AudioFifo batching).
 * They also validate the free/close discipline: repeated create/destroy cycles
 * must not throw or crash the process.
 *
 * If the native binding cannot load in the test environment the whole suite
 * skips (mirrors `addon-decoder-nodeav`), so CI without the binding stays green
 * on the pure catalogue tests.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type { AudioEncodedChunk, AudioPcmChunk, IScopedLogger } from '@camstack/types'
import { loadNodeAvRuntime, type NodeAvRuntime } from '../nodeav-runtime-loader.js'
import { NodeAvAudioDecodeSession } from '../nodeav-audio-decode-session.js'
import { NodeAvAudioEncodeSession } from '../nodeav-audio-encode-session.js'

const noopLogger: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger
  },
} as unknown as IScopedLogger

let runtime: NodeAvRuntime | null = null

beforeAll(async () => {
  try {
    runtime = await loadNodeAvRuntime()
  } catch {
    runtime = null
  }
})

/** Generate `ms` of an interleaved mono s16le sine tone at `rate` Hz. */
function sineS16(rate: number, ms: number, freq = 440): Uint8Array {
  const samples = Math.round((rate * ms) / 1000)
  const buf = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    buf[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000)
  }
  return new Uint8Array(buf.buffer)
}

interface RoundtripCase {
  readonly codec: string
  readonly rate: number
  readonly chunkMs: number
  readonly chunks: number
}

const CASES: readonly RoundtripCase[] = [
  { codec: 'opus', rate: 48000, chunkMs: 20, chunks: 10 },
  { codec: 'g722', rate: 16000, chunkMs: 20, chunks: 10 },
  { codec: 'aac', rate: 16000, chunkMs: 40, chunks: 10 },
  { codec: 'pcm_mulaw', rate: 8000, chunkMs: 20, chunks: 10 },
]

describe('node-av audio encode → decode roundtrip', () => {
  for (const c of CASES) {
    it(`${c.codec} @ ${c.rate}Hz mono survives a roundtrip`, () => {
      if (!runtime) return // node-av unavailable — skip
      const encoded: AudioEncodedChunk[] = []
      const enc = new NodeAvAudioEncodeSession(
        runtime,
        {
          codec: c.codec,
          sourceSampleRate: c.rate,
          sourceChannels: 1,
          sourceFormat: 's16le',
          targetSampleRate: c.rate,
          targetChannels: 1,
        },
        noopLogger,
        (chunk) => encoded.push(chunk),
      )
      try {
        for (let i = 0; i < c.chunks; i++) {
          enc.pushPcm(sineS16(c.rate, c.chunkMs))
        }
        enc.flush()
      } finally {
        enc.destroy()
      }

      // The encoder must have produced at least one packet, each marked as a
      // complete frame (node-av emits one packet per receivePacket).
      expect(encoded.length).toBeGreaterThan(0)
      expect(encoded.every((e) => e.frameComplete)).toBe(true)
      expect(encoded.every((e) => e.codec === c.codec)).toBe(true)
      expect(encoded.every((e) => e.data.byteLength > 0)).toBe(true)

      const decoded: AudioPcmChunk[] = []
      const dec = new NodeAvAudioDecodeSession(
        runtime,
        {
          codec: c.codec,
          sourceSampleRate: c.rate,
          sourceChannels: 1,
          targetSampleRate: c.rate,
          targetChannels: 1,
          targetFormat: 's16le',
        },
        noopLogger,
        (chunk) => decoded.push(chunk),
      )
      try {
        for (const e of encoded) {
          dec.pushEncoded(e.data, e.pts)
        }
      } finally {
        dec.destroy()
      }

      // Decode must yield interleaved s16le PCM at the requested rate.
      expect(decoded.length).toBeGreaterThan(0)
      const totalSamples = decoded.reduce((n, d) => n + d.data.byteLength / 2, 0)
      expect(totalSamples).toBeGreaterThan(0)
      expect(decoded.every((d) => d.sampleRate === c.rate)).toBe(true)
      expect(decoded.every((d) => d.channels === 1)).toBe(true)
      expect(decoded.every((d) => d.format === 's16le')).toBe(true)
    })
  }

  it('resamples across rates (16k mono → opus 48k → 16k mono)', () => {
    if (!runtime) return
    const encoded: AudioEncodedChunk[] = []
    const enc = new NodeAvAudioEncodeSession(
      runtime,
      {
        codec: 'opus',
        sourceSampleRate: 16000,
        sourceChannels: 1,
        sourceFormat: 's16le',
        targetSampleRate: 48000,
        targetChannels: 1,
      },
      noopLogger,
      (chunk) => encoded.push(chunk),
    )
    try {
      for (let i = 0; i < 10; i++) enc.pushPcm(sineS16(16000, 20))
      enc.flush()
    } finally {
      enc.destroy()
    }
    expect(encoded.length).toBeGreaterThan(0)
  })

  /**
   * The Stage-0 defect, on the real native path.
   *
   * A `pcm_s16le` DECODE session is a pure libswresample rate conversion — the
   * codec stage is a passthrough. This is what the two intercom providers had
   * nothing to call, and why an 8 kHz Hikvision dropped every 22 050 Hz frame
   * HomeKit / Alexa / a TTS engine pushed at it (D281).
   *
   * Asserted on the OUTPUT, not on the call: 500 ms in at 22 050 Hz must come
   * back as ~500 ms at 8 000 Hz. A conversion that silently kept the input
   * rate would produce ~2.76x the samples and play back as chipmunk audio,
   * which is the outcome the old drop branch existed to avoid.
   */
  it('converts raw pcm_s16le 22050 → 8000 Hz through libswresample', () => {
    if (!runtime) return
    const decoded: AudioPcmChunk[] = []
    const dec = new NodeAvAudioDecodeSession(
      runtime,
      {
        codec: 'pcm_s16le',
        sourceSampleRate: 22050,
        sourceChannels: 1,
        targetSampleRate: 8000,
        targetChannels: 1,
        targetFormat: 's16le',
      },
      noopLogger,
      (chunk) => decoded.push(chunk),
    )
    const frames = 25
    const frameMs = 20
    try {
      for (let i = 0; i < frames; i++) dec.pushEncoded(sineS16(22050, frameMs))
    } finally {
      dec.destroy()
    }

    expect(decoded.length).toBeGreaterThan(0)
    expect(decoded.every((d) => d.sampleRate === 8000)).toBe(true)
    expect(decoded.every((d) => d.channels === 1)).toBe(true)
    expect(decoded.every((d) => d.format === 's16le')).toBe(true)

    // 500 ms at 8 kHz = 4000 samples. Allow one resampler frame of slack in
    // either direction (swr holds a few samples of its filter tail); the
    // interval that matters is the one that EXCLUDES 22050-rate output
    // (~11 025 samples), which is the failure this asserts against.
    const outSamples = decoded.reduce((n, d) => n + d.data.byteLength / 2, 0)
    const expected = (8000 * frames * frameMs) / 1000
    expect(outSamples).toBeGreaterThan(expected * 0.9)
    expect(outSamples).toBeLessThan(expected * 1.1)
  })

  /** The other direction, at the rate a 16 kHz Reolink talk channel wants. */
  it('converts raw pcm_s16le 22050 → 16000 Hz through libswresample', () => {
    if (!runtime) return
    const decoded: AudioPcmChunk[] = []
    const dec = new NodeAvAudioDecodeSession(
      runtime,
      {
        codec: 'pcm_s16le',
        sourceSampleRate: 22050,
        sourceChannels: 1,
        targetSampleRate: 16000,
        targetChannels: 1,
        targetFormat: 's16le',
      },
      noopLogger,
      (chunk) => decoded.push(chunk),
    )
    try {
      for (let i = 0; i < 25; i++) dec.pushEncoded(sineS16(22050, 20))
    } finally {
      dec.destroy()
    }
    const outSamples = decoded.reduce((n, d) => n + d.data.byteLength / 2, 0)
    expect(decoded.every((d) => d.sampleRate === 16000)).toBe(true)
    expect(outSamples).toBeGreaterThan(8000 * 0.9)
    expect(outSamples).toBeLessThan(8000 * 1.1)
  })

  it('survives repeated create/destroy cycles without throwing', () => {
    if (!runtime) return
    expect(() => {
      for (let i = 0; i < 25; i++) {
        const dec = new NodeAvAudioDecodeSession(
          runtime!,
          {
            codec: 'opus',
            sourceSampleRate: 48000,
            sourceChannels: 1,
            targetSampleRate: 48000,
            targetChannels: 1,
            targetFormat: 's16le',
          },
          noopLogger,
          () => {},
        )
        dec.destroy()
        // double-destroy + use-after-close must be safe no-ops
        dec.destroy()
        dec.pushEncoded(new Uint8Array([0, 0, 0, 0]))
      }
    }).not.toThrow()
  })
})
