/**
 * The analyzer is the ONE consumer that needs 16 kHz mono, and the
 * resampling lives next to it (D450). Two guards:
 *
 *   1. `resampleMono16k` turns an 8 kHz window into the 16 kHz one the
 *      classifier expects — the same linear interpolation the broker used
 *      to do at the source, now over a whole window instead of per packet.
 *   2. `analyseChunk` REPORTS the format it receives, once per device and
 *      again when it changes, saying whether the classifier resamples it —
 *      a plane that stops delivering the expected format is never silent
 *      (D427).
 *
 * The level meter is rate-agnostic: RMS over the source samples.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AudioChunkInput, IScopedLogger } from '@camstack/types'
import { makeTestAudioAnalyzerProvider } from '../../__tests__/support/audio-analyzer-provider.js'
import { resampleMono16k, type AudioChunk, type IAudioPipeline } from '../audio-pipeline.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function f32Chunk(sampleRate: number, fill: number, deviceId: number): AudioChunkInput {
  const samples = sampleRate // 1 s
  const f32 = new Float32Array(samples).fill(fill)
  return {
    data: new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength),
    sampleRate,
    channels: 1,
    timestamp: 1_000,
    deviceId,
  }
}

function makeFakePipeline(): { pipeline: IAudioPipeline; seen: AudioChunk[] } {
  const seen: AudioChunk[] = []
  const pipeline: IAudioPipeline = {
    initialize: vi.fn(async () => {}),
    classify: vi.fn(async (chunk: AudioChunk) => {
      seen.push(chunk)
      return { classifications: [{ className: 'Dog bark', score: 0.9 }], inferenceMs: 3 }
    }),
    dispose: vi.fn(async () => {}),
    getPid: () => null,
  }
  return { pipeline, seen }
}

function makeProvider(log: IScopedLogger, pipeline: IAudioPipeline) {
  return makeTestAudioAnalyzerProvider(log, pipeline)
}

const settings = { minConfidence: 0.3, allowedClasses: [] }

describe('resampleMono16k', () => {
  it('doubles an 8 kHz window with the midpoint between every pair of source samples', () => {
    const src = new Float32Array([0, 1, 0, -1])
    const out = resampleMono16k({ data: src, sampleRate: 8000, channels: 1 })
    expect(out.length).toBe(8)
    expect(Array.from(out)).toEqual([0, 0.5, 1, 0.5, 0, -0.5, -1, -1])
  })

  it('folds stereo to mono before resampling', () => {
    const src = new Float32Array([1, 0, 1, 0]) // two frames, L=1 R=0
    const out = resampleMono16k({ data: src, sampleRate: 16000, channels: 2 })
    expect(Array.from(out)).toEqual([0.5, 0.5])
  })
})

describe('AudioAnalyzerProvider.analyseChunk — the format it receives', () => {
  it('meters the level on the source samples and hands the classifier the source rate', async () => {
    const log = makeLogger()
    const { pipeline, seen } = makeFakePipeline()
    const provider = makeProvider(log, pipeline)
    try {
      const result = await provider.analyseChunk({ chunk: f32Chunk(8000, 0.5, 101), settings })
      expect(result).not.toBeNull()
      expect(result!.level.rms).toBeCloseTo(0.5, 4)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.sampleRate).toBe(8000)
      expect(seen[0]!.data.length).toBe(8000)
    } finally {
      await provider.dispose()
    }
  })

  it('reports the window format once per device, naming whether the classifier resamples', async () => {
    const log = makeLogger()
    const { pipeline } = makeFakePipeline()
    const provider = makeProvider(log, pipeline)
    try {
      await provider.analyseChunk({ chunk: f32Chunk(8000, 0.1, 101), settings })
      await provider.analyseChunk({ chunk: f32Chunk(8000, 0.1, 101), settings })
      await provider.analyseChunk({ chunk: f32Chunk(8000, 0.1, 102), settings })
      const formatLines = vi
        .mocked(log.info)
        .mock.calls.filter(([msg]) => msg === 'audio window format')
      expect(formatLines).toHaveLength(2)
      expect(formatLines[0]![1]).toMatchObject({
        tags: { deviceId: 101 },
        meta: { sampleRate: 8000, channels: 1, windowMs: 1000, classifierResamples: true },
      })
      expect(formatLines[1]![1]).toMatchObject({ tags: { deviceId: 102 } })
    } finally {
      await provider.dispose()
    }
  })

  it('reports again when a device changes format, and a 16 kHz mono window needs no resample', async () => {
    const log = makeLogger()
    const { pipeline } = makeFakePipeline()
    const provider = makeProvider(log, pipeline)
    try {
      await provider.analyseChunk({ chunk: f32Chunk(16000, 0.1, 101), settings })
      await provider.analyseChunk({ chunk: f32Chunk(8000, 0.1, 101), settings })
      const formatLines = vi
        .mocked(log.info)
        .mock.calls.filter(([msg]) => msg === 'audio window format')
      expect(formatLines).toHaveLength(2)
      expect(formatLines[0]![1]).toMatchObject({
        meta: { sampleRate: 16000, classifierResamples: false, previous: null },
      })
      expect(formatLines[1]![1]).toMatchObject({
        meta: {
          sampleRate: 8000,
          classifierResamples: true,
          previous: { sampleRate: 16000, channels: 1 },
        },
      })
    } finally {
      await provider.dispose()
    }
  })
})
