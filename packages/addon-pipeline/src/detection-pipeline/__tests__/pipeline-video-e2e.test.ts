/**
 * Pipeline v2 — Video E2E Test
 *
 * Uses DetectionPipelineProvider as a blackbox (same as single-frame test).
 * Downloads a MOT17 clip, decodes at 2fps with ffmpeg, runs pipeline per frame.
 *
 * Validates:
 * - Expected classes present in >=80% of frames
 * - Detection count stable across frames (no extreme flicker)
 * - No latency degradation (no memory leak)
 * - Valid bboxes and step timings on every frame
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ENGINE_E2E_ENABLED } from './engine-e2e-gate.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import sharp from 'sharp'
import type { FrameResult, FrameInput, IScopedLogger } from '@camstack/types'
import { buildDefaultStepTree, DetectionPipelineProvider } from '../provider.js'
import { resolveDefaultDetectionModel } from '../default-detection-model.js'
import { InMemorySettingsStore } from './helpers/in-memory-config.js'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../../../..')
const MODELS_DIR = path.join(ROOT, 'test-output/.models')
const VIDEO_DIR = path.join(ROOT, 'test-output/pipeline-v2/video-e2e')
const VIDEO_PATH = path.join(VIDEO_DIR, 'mot17-09.webm')
const FRAMES_DIR = path.join(VIDEO_DIR, 'frames')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TARGET_FPS = 2
const EXPECTED_CLASSES = ['person']
const COREML_ENGINE = { runtime: 'python' as const, backend: 'coreml', format: 'coreml' as const }

// MOT17-09: pedestrians in a street scene (~10s, public dataset)
const VIDEO_URL = 'https://motchallenge.net/sequenceVideos/MOT17-09-raw.webm'

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function createLogger(scope: string): IScopedLogger {
  const fmt = (level: string, msg: string): void => {
    console.log(`[${level}] [${scope}] ${msg}`)
  }
  const logger: IScopedLogger = {
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
// Video helpers
// ---------------------------------------------------------------------------

async function ensureVideoDownloaded(log: IScopedLogger): Promise<void> {
  if (fs.existsSync(VIDEO_PATH)) return

  fs.mkdirSync(VIDEO_DIR, { recursive: true })
  log.info('Downloading MOT17-09 clip...')

  const response = await fetch(VIDEO_URL)
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status} ${response.statusText}`)
  }

  const body = response.body
  if (!body) throw new Error('No response body')

  const { pipeline: streamPipeline } = await import('node:stream/promises')
  const { Readable } = await import('node:stream')
  await streamPipeline(
    Readable.fromWeb(body as import('stream/web').ReadableStream),
    fs.createWriteStream(VIDEO_PATH),
  )
  log.info(`Video downloaded: ${VIDEO_PATH}`)
}

function decodeFrames(log: IScopedLogger): string[] {
  if (
    fs.existsSync(FRAMES_DIR) &&
    fs.readdirSync(FRAMES_DIR).filter((f) => f.endsWith('.jpg')).length > 0
  ) {
    const frames = fs
      .readdirSync(FRAMES_DIR)
      .filter((f) => f.endsWith('.jpg'))
      .toSorted()
    log.info(`Using ${frames.length} cached frames`)
    return frames.map((f) => path.join(FRAMES_DIR, f))
  }

  fs.mkdirSync(FRAMES_DIR, { recursive: true })
  log.info(`Decoding video at ${TARGET_FPS} fps...`)

  execSync(
    `ffmpeg -i "${VIDEO_PATH}" -vf "fps=${TARGET_FPS}" -q:v 2 "${FRAMES_DIR}/frame_%04d.jpg" -y`,
    { stdio: 'pipe', timeout: 30_000 },
  )

  const frames = fs
    .readdirSync(FRAMES_DIR)
    .filter((f) => f.endsWith('.jpg'))
    .toSorted()
  log.info(`Decoded ${frames.length} frames`)
  return frames.map((f) => path.join(FRAMES_DIR, f))
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!ENGINE_E2E_ENABLED)(
  'Pipeline v2 — Video E2E',
  () => {
    let provider: DetectionPipelineProvider
    const frameResults: Array<{ frame: string; result: FrameResult }> = []

    beforeAll(async () => {
      const log = createLogger('video-e2e')

      // 1. Download video + decode frames
      await ensureVideoDownloaded(log)
      const framePaths = decodeFrames(log)
      expect(framePaths.length).toBeGreaterThanOrEqual(5)

      // 2. Create provider — handles model download internally
      const settings = new InMemorySettingsStore()

      provider = new DetectionPipelineProvider(settings, MODELS_DIR, log)
      await provider.init()
      // Stateless: every runPipeline() call carries engine+steps; no global state to seed.
      const defaultSteps = buildDefaultStepTree(
        COREML_ENGINE.format,
        resolveDefaultDetectionModel(COREML_ENGINE.backend, null, COREML_ENGINE.format),
      )

      // 3. Run pipeline on each frame (first frame triggers lazy init + warm-up)
      for (const framePath of framePaths) {
        const jpeg = fs.readFileSync(framePath)
        const meta = await sharp(jpeg).metadata()
        const frame: FrameInput = {
          data: jpeg,
          format: 'jpeg',
          width: meta.width!,
          height: meta.height!,
          timestamp: Date.now(),
        }

        const result = await provider.runPipeline({
          steps: defaultSteps,
          frame,
          deviceId: 2,
        })
        if (result) {
          frameResults.push({ frame: path.basename(framePath), result })
        }
      }

      // Print per-frame summary
      console.log('\n' + '='.repeat(70))
      console.log('VIDEO E2E — PER-FRAME RESULTS')
      console.log('='.repeat(70))
      console.log(
        `  ${'Frame'.padEnd(20)} ${'Dets'.padStart(5)} ${'TotalMs'.padStart(10)} ${'Classes'}`,
      )
      for (const { frame, result } of frameResults) {
        const classes = [...new Set(result.detections.map((d) => d.macroClass))].join(', ')
        const totalMs = result.debug?.totalInferenceMs ?? 0
        console.log(
          `  ${frame.padEnd(20)} ${String(result.detections.length).padStart(5)} ${totalMs.toFixed(1).padStart(10)} ${classes}`,
        )
      }
      console.log('='.repeat(70) + '\n')
    }, 600_000)

    afterAll(async () => {
      await provider?.shutdown()
    })

    it('detects expected classes in >=80% of frames', () => {
      const framesWithExpected = frameResults.filter((r) =>
        r.result.detections.some((d) => EXPECTED_CLASSES.includes(d.macroClass)),
      )
      const ratio = framesWithExpected.length / frameResults.length
      console.log(
        `  Expected class hit rate: ${(ratio * 100).toFixed(1)}% (${framesWithExpected.length}/${frameResults.length})`,
      )
      expect(ratio).toBeGreaterThanOrEqual(0.8)
    })

    it('has stable detection counts (no extreme flicker)', () => {
      const counts = frameResults.map((r) => r.result.detections.length)
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length
      const variance = counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length
      const stddev = Math.sqrt(variance)

      console.log(
        `  Detection counts: mean=${mean.toFixed(1)}, stddev=${stddev.toFixed(1)}, range=[${Math.min(...counts)}, ${Math.max(...counts)}]`,
      )
      expect(stddev).toBeLessThan(mean * 0.5 + 1)
    })

    it('does not degrade inference time across frames', () => {
      const totalTimes = frameResults.map((r) => r.result.debug?.totalInferenceMs ?? 0)
      if (totalTimes.length < 6) return

      const mid = Math.floor(totalTimes.length / 2)
      const avgFirst = totalTimes.slice(0, mid).reduce((a, b) => a + b, 0) / mid
      const avgSecond = totalTimes.slice(mid).reduce((a, b) => a + b, 0) / (totalTimes.length - mid)

      console.log(
        `  Latency trend: first-half=${avgFirst.toFixed(1)}ms, second-half=${avgSecond.toFixed(1)}ms`,
      )
      expect(avgSecond).toBeLessThan(avgFirst * 1.5 + 50)
    })

    it('produces valid bboxes on every frame', () => {
      for (const { result } of frameResults) {
        for (const det of result.detections) {
          expect(det.bbox.width).toBeGreaterThan(0)
          expect(det.bbox.height).toBeGreaterThan(0)
        }
      }
    })

    it('reports step timings on every frame', () => {
      for (const { result } of frameResults) {
        const stepTimings = result.debug?.stepTimings ?? []
        expect(stepTimings.length).toBeGreaterThanOrEqual(1)
        expect(result.debug?.totalInferenceMs ?? 0).toBeGreaterThan(0)
      }
    })
  },
  600_000,
)
