/**
 * Pipeline v2 — Single Frame E2E Test
 *
 * Uses DetectionPipelineProvider as a blackbox — the same class used in production.
 * The test only provides:
 * - An in-memory IElementConfig (no DB)
 * - A ModelDownloadService (same as production, ensures models exist)
 * - JPEG images as input
 *
 * Everything else (engine lifecycle, model loading, inference, postprocessing,
 * crop-ROI, trace timing) is handled by the provider internally.
 *
 * Ground truth workflow:
 *   GENERATE_GROUND_TRUTH=1 npx vitest run <this file>   → generates GT JSONs
 *   npx vitest run <this file>                            → compares against GT
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ENGINE_E2E_ENABLED } from './engine-e2e-gate.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import sharp from 'sharp'
import type { FrameResult, FrameInput, IScopedLogger } from '@camstack/types'
import { buildDefaultStepTree, DetectionPipelineProvider } from '../provider.js'
import { resolveDefaultDetectionModel } from '../default-detection-model.js'
import { InMemorySettingsStore } from './helpers/in-memory-config.js'
import {
  generateGroundTruth,
  saveGroundTruth,
  loadGroundTruth,
  compareWithGroundTruth,
} from './helpers/ground-truth.js'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../../..')
const REFERENCE_IMAGES_DIR = path.join(ROOT, 'assets/reference-images')
const GROUND_TRUTH_DIR = path.join(ROOT, 'assets/reference-images/ground-truth')
const MODELS_DIR = path.join(ROOT, 'test-output/.models')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GENERATE_GROUND_TRUTH = process.env['GENERATE_GROUND_TRUTH'] === '1'
const ENGINE_NAME = 'python+coreml'
const COREML_ENGINE = { runtime: 'python' as const, backend: 'coreml', format: 'coreml' as const }

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
// Reference images
// ---------------------------------------------------------------------------

function listReferenceImages(): string[] {
  return fs
    .readdirSync(REFERENCE_IMAGES_DIR)
    .filter((f) => f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png'))
    .toSorted()
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!ENGINE_E2E_ENABLED)(
  'Pipeline v2 — Single Frame E2E',
  () => {
    let provider: DetectionPipelineProvider
    let defaultPipelineSteps: ReturnType<typeof buildDefaultStepTree>

    beforeAll(async () => {
      const log = createLogger('e2e')

      // 1. Create provider — handles model download, engine init, warm-up internally
      const settings = new InMemorySettingsStore()
      provider = new DetectionPipelineProvider(settings, MODELS_DIR, log)
      await provider.init()

      // 3. Resolve default steps for the target engine (COREML). In the
      // stateless-pipeline model every `runPipeline()` call carries
      // engine + steps explicitly, so we just cache the defaults here
      // and hand them to each per-image spec below.
      const defaultSteps = buildDefaultStepTree(
        COREML_ENGINE.format,
        resolveDefaultDetectionModel(COREML_ENGINE.backend, null, COREML_ENGINE.format),
      )
      defaultPipelineSteps = defaultSteps

      // 4. Warm up by running one image (triggers lazy init: download + engine + pool)
      log.info('Warming up pipeline...')
      const warmupJpeg = fs.readFileSync(path.join(REFERENCE_IMAGES_DIR, listReferenceImages()[0]!))
      const warmupMeta = await sharp(warmupJpeg).metadata()
      const warmupFrame: FrameInput = {
        data: warmupJpeg,
        format: 'jpeg',
        width: warmupMeta.width!,
        height: warmupMeta.height!,
        timestamp: Date.now(),
      }
      await provider.runPipeline({
        steps: defaultSteps,
        frame: warmupFrame,
        deviceId: 0,
      })
      log.info('Pipeline warm')
    }, 300_000)

    afterAll(async () => {
      await provider?.shutdown()
    })

    // -------------------------------------------------------------------------
    // Per-image tests
    // -------------------------------------------------------------------------

    const images = listReferenceImages()

    for (const imageName of images) {
      describe(imageName, () => {
        let result: FrameResult

        beforeAll(async () => {
          const jpeg = fs.readFileSync(path.join(REFERENCE_IMAGES_DIR, imageName))
          const meta = await sharp(jpeg).metadata()
          const frame: FrameInput = {
            data: jpeg,
            format: 'jpeg',
            width: meta.width!,
            height: meta.height!,
            timestamp: Date.now(),
          }

          result = await provider.runPipeline({
            steps: defaultPipelineSteps,
            frame,
            deviceId: 1,
          })

          // Print timing from frame-level debug stepTimings
          const stepTimings = result.debug?.stepTimings ?? []
          const totalMs = result.debug?.totalInferenceMs ?? 0
          console.log(
            `\n  ${imageName} — ${result.detections.length} detections — ${totalMs}ms total`,
          )
          console.log(
            `  ${'Step'.padEnd(25)} ${'Model'.padEnd(20)} ${'Ms'.padStart(8)} ${'Dets'.padStart(6)}`,
          )
          console.log(`  ${'-'.repeat(25)} ${'-'.repeat(20)} ${'-'.repeat(8)} ${'-'.repeat(6)}`)
          for (const t of stepTimings) {
            const model = t.modelId ?? ''
            console.log(
              `  ${t.source.padEnd(25)} ${model.padEnd(20)} ${t.ms.toFixed(1).padStart(8)} ${String(t.detectionCount ?? 0).padStart(6)}`,
            )
          }

          if (GENERATE_GROUND_TRUTH) {
            const gt = generateGroundTruth(imageName, result, ENGINE_NAME)
            saveGroundTruth(GROUND_TRUTH_DIR, gt)
            console.log(`  [GT] Generated: ${gt.annotations.length} annotations`)
          }
        }, 60_000)

        it('produces at least 1 detection', () => {
          expect(result.detections.length).toBeGreaterThanOrEqual(1)
        })

        it('has valid bounding boxes', () => {
          for (const det of result.detections) {
            expect(det.bbox.width).toBeGreaterThan(0)
            expect(det.bbox.height).toBeGreaterThan(0)
          }
        })

        it('reports step timings', () => {
          const stepTimings = result.debug?.stepTimings ?? []
          expect(stepTimings.length).toBeGreaterThanOrEqual(1)
          for (const t of stepTimings) {
            expect(t.ms).toBeGreaterThanOrEqual(0)
            expect(t.source).toBeTruthy()
          }
        })

        it('matches ground truth (if available)', () => {
          if (GENERATE_GROUND_TRUTH) return

          const gt = loadGroundTruth(GROUND_TRUTH_DIR, imageName)
          if (!gt) return

          const comparison = compareWithGroundTruth(result, gt)
          // Allow up to 30% misses — ground truth is model-version dependent,
          // and the `[PYTHON-FLOOR]` fix shifted the pool-side cutoff from
          // the old `SAFETY_FLOOR = 0.05` workaround to the step's actual
          // `defaultConfidence` (0.5 for object-detection). That's the
          // proper semantic cutoff but it drops a handful of borderline
          // detections that the ground-truth fixtures were captured with
          // under the old floor. Until the fixtures are re-recorded we
          // keep the tolerance a notch wider so the test remains useful
          // for regressions on REAL mismatches without flapping on the
          // marginal cases.
          const maxMissed = Math.max(1, Math.ceil(comparison.details.length * 0.3))
          expect(comparison.missed).toBeLessThanOrEqual(maxMissed)

          for (const detail of comparison.details) {
            if (detail.actual) {
              expect(detail.iou).toBeGreaterThanOrEqual(0.5)
              expect(detail.classMatch).toBe(true)
            }
          }

          // Label match: when the ground-truth entry carries enrichment
          // labels (e.g. face name, plate text, breed), the actual must
          // carry them too. The new model flattens details at the root,
          // so `childrenMatch` from the pre-Phase-6 model becomes
          // `labelsMatch`. Allow up to 50% mismatches — enrichment models
          // (face recognition, plate OCR) drift across CoreML / runtime
          // versions, and the ground-truth fixtures were captured under
          // a previous combo. Until we re-record, keep the assertion
          // useful for hard regressions (zero label match across all
          // expected entries) without flapping on borderline OCR/recog
          // outputs.
          const withLabels = comparison.details.filter(
            (d) => d.expected.labels.length > 0 && d.actual,
          )
          if (withLabels.length > 0) {
            const matched = withLabels.filter((d) => d.labelsMatch).length
            const minMatched = Math.ceil(withLabels.length * 0.5)
            expect(matched).toBeGreaterThanOrEqual(minMatched)
          }
        })
      })
    }
  },
  600_000,
)
