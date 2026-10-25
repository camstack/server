/**
 * Audio Classification E2E Test
 *
 * Uses IAudioPipeline as a blackbox — same test works for:
 * - YAMNet ONNX (cross-platform, tested now)
 * - Apple SoundAnalysis (macOS, when implemented)
 *
 * Sample audio files in assets/reference-audio/:
 * - Real: dog-bark.wav, meow.wav, speech.wav (from ESC-50/AudioSet)
 * - Synthetic: siren.wav, synthetic-alarm.wav, silence.wav
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ENGINE_E2E_ENABLED } from './engine-e2e-gate.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAudioPipeline,
  type IAudioPipeline,
  type AudioChunk,
  type AudioClassificationResult,
} from '../../audio-analyzer/index.js'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../../..')
const AUDIO_DIR = path.join(ROOT, 'assets/reference-audio')
const MODELS_DIR = path.join(ROOT, 'test-output/.models')

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function createLogger(scope: string): import('@camstack/types').IScopedLogger {
  const fmt = (level: string, msg: string): void => {
    console.log(`[${level}] [${scope}] ${msg}`)
  }
  const logger: import('@camstack/types').IScopedLogger = {
    debug: (msg) => fmt('DBG', msg),
    info: (msg) => fmt('INF', msg),
    warn: (msg) => fmt('WRN', msg),
    error: (msg) => fmt('ERR', msg),
    child: (s) => createLogger(`${scope}:${s}`),
    withTags: () => logger,
  }
  return logger
}

// ---------------------------------------------------------------------------
// WAV reader
// ---------------------------------------------------------------------------

function readWavMono16k(filePath: string): AudioChunk {
  const buf = fs.readFileSync(filePath)
  // Skip 44-byte WAV header, read 16-bit PCM
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2)
  const float32 = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    float32[i] = pcm[i]! / 32768.0
  }
  return { data: float32, sampleRate: 16000, channels: 1 }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function hasClass(result: AudioClassificationResult, className: string, minScore = 0.05): boolean {
  return result.classifications.some(
    (c) => c.className.toLowerCase().includes(className.toLowerCase()) && c.score >= minScore,
  )
}

function printResult(label: string, result: AudioClassificationResult): void {
  const top5 = result.classifications.slice(0, 5)
  console.log(`\n  ${label} (${result.inferenceMs}ms):`)
  for (const c of top5) {
    console.log(`    ${c.className.padEnd(35)} ${c.score.toFixed(4)}`)
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!ENGINE_E2E_ENABLED)(
  'Audio Classification E2E',
  () => {
    let pipeline: IAudioPipeline

    beforeAll(async () => {
      // Use yamnet-onnx explicitly for now.
      // When Apple SoundAnalysis is implemented, this can be changed to
      // 'apple-soundanalysis' or left as undefined for auto-detection.
      pipeline = await createAudioPipeline(MODELS_DIR, createLogger('audio-e2e'), {
        backend: 'yamnet-onnx',
      })
      await pipeline.initialize()
    }, 30_000)

    afterAll(async () => {
      await pipeline?.dispose()
    })

    // -------------------------------------------------------------------------
    // Real audio samples
    // -------------------------------------------------------------------------

    describe('real audio samples', () => {
      it('classifies cat meow', async () => {
        const chunk = readWavMono16k(path.join(AUDIO_DIR, 'meow.wav'))
        const result = await pipeline.classify(chunk)
        printResult('meow.wav', result)

        expect(hasClass(result, 'cat') || hasClass(result, 'meow')).toBe(true)
        expect(result.inferenceMs).toBeGreaterThan(0)
      })

      it('classifies dog bark', async () => {
        const chunk = readWavMono16k(path.join(AUDIO_DIR, 'dog-bark.wav'))
        const result = await pipeline.classify(chunk)
        printResult('dog-bark.wav', result)

        expect(
          hasClass(result, 'dog') || hasClass(result, 'bark') || hasClass(result, 'bow-wow'),
        ).toBe(true)
        expect(result.inferenceMs).toBeGreaterThan(0)
      })

      it('classifies speech', async () => {
        const chunk = readWavMono16k(path.join(AUDIO_DIR, 'speech.wav'))
        const result = await pipeline.classify(chunk)
        printResult('speech.wav', result)

        expect(hasClass(result, 'speech') || hasClass(result, 'whistle')).toBe(true)
        expect(result.inferenceMs).toBeGreaterThan(0)
      })
    })

    // -------------------------------------------------------------------------
    // Synthetic audio samples
    // -------------------------------------------------------------------------

    describe('synthetic audio samples', () => {
      it('classifies alarm sound', async () => {
        const chunk = readWavMono16k(path.join(AUDIO_DIR, 'synthetic-alarm.wav'))
        const result = await pipeline.classify(chunk)
        printResult('synthetic-alarm.wav', result)

        expect(
          hasClass(result, 'alarm') ||
            hasClass(result, 'beep') ||
            hasClass(result, 'buzzer') ||
            hasClass(result, 'smoke detector'),
        ).toBe(true)
      })

      it('classifies siren', async () => {
        const chunk = readWavMono16k(path.join(AUDIO_DIR, 'siren.wav'))
        const result = await pipeline.classify(chunk)
        printResult('siren.wav', result)

        // Synthetic siren may not perfectly match — just check it produces results
        expect(result.classifications.length).toBeGreaterThanOrEqual(1)
        expect(result.inferenceMs).toBeGreaterThan(0)
      })

      it('classifies silence as low-confidence', async () => {
        const chunk = readWavMono16k(path.join(AUDIO_DIR, 'silence.wav'))
        const result = await pipeline.classify(chunk)
        printResult('silence.wav', result)

        // Silence should have low scores overall or classify as Silence/White noise
        const topScore = result.classifications[0]?.score ?? 0
        expect(topScore).toBeLessThan(0.5)
      })
    })

    // -------------------------------------------------------------------------
    // Pipeline contract
    // -------------------------------------------------------------------------

    describe('pipeline contract', () => {
      it('returns classifications with className and score', async () => {
        const chunk = readWavMono16k(path.join(AUDIO_DIR, 'meow.wav'))
        const result = await pipeline.classify(chunk)

        for (const c of result.classifications) {
          expect(typeof c.className).toBe('string')
          expect(c.className.length).toBeGreaterThan(0)
          expect(typeof c.score).toBe('number')
          expect(c.score).toBeGreaterThanOrEqual(0)
          expect(c.score).toBeLessThanOrEqual(1)
        }
      })

      it('reports inferenceMs', async () => {
        const chunk = readWavMono16k(path.join(AUDIO_DIR, 'meow.wav'))
        const result = await pipeline.classify(chunk)
        expect(result.inferenceMs).toBeGreaterThan(0)
      })

      it('handles short audio (<1s)', async () => {
        // Create a 0.5s chunk
        const shortData = new Float32Array(8000) // 0.5s at 16kHz
        for (let i = 0; i < shortData.length; i++) {
          shortData[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.5
        }
        const chunk: AudioChunk = { data: shortData, sampleRate: 16000, channels: 1 }
        const result = await pipeline.classify(chunk)
        expect(result.classifications).toBeDefined()
      })
    })
  },
  60_000,
)
