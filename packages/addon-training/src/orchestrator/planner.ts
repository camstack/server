/**
 * Planning a job: the split policy, the support it leaves for evaluation,
 * the GPU-time estimate and every named refusal — pure, nothing started.
 *
 * Split rules (plan §1): by CAMERA and by whole DAYS, never by random frame.
 * Six or more cameras with complete frames → two cameras are held out whole
 * (the 2nd and 3rd largest, so the biggest keeps teaching); fewer → the last
 * three days of every camera. The trainer applies the policy; this module
 * only decides it and predicts its consequences.
 *
 * The GPU-time model is a first guess, labelled as such in the estimate's
 * notes: images × epochs ÷ a per-tier L4 throughput, times a GPU speed factor,
 * plus a fixed overhead (image pull, replay download, evaluation, export).
 * Real runs refine it; until then the cost cap is what bounds a wrong guess.
 */
import type {
  RetrainDatasetStats,
  TrainingGpuOption,
  TrainingPreset,
  TrainingSplitPlan,
} from '@camstack/types'
import type { BaseModelSpec } from './base-models.js'

export const HOLDOUT_CAMERA_THRESHOLD = 6
export const DEFAULT_HOLDOUT_DAYS = 3
export const MIN_HOLDOUT_SUPPORT = 20
export const DETECTOR_CLASSES = ['person', 'vehicle', 'animal'] as const

export interface PresetSpec {
  readonly epochs: number
  readonly freeze: number
  readonly replay: number
}

export const PRESETS: Readonly<Record<TrainingPreset, PresetSpec>> = {
  quick: { epochs: 15, freeze: 10, replay: 800 },
  standard: { epochs: 40, freeze: 10, replay: 1500 },
  thorough: { epochs: 80, freeze: 0, replay: 2500 },
}

/** Training images per second on an L4 at 640 (unmeasured first guess). */
const L4_IMAGES_PER_SEC_640: Readonly<Record<BaseModelSpec['tier'], number>> = {
  t: 180,
  s: 120,
  m: 60,
  c: 45,
}

/** Throughput relative to an L4 (unmeasured first guess, from public benchmarks). */
const GPU_SPEED: Readonly<Record<string, number>> = {
  T4: 0.6,
  L4: 1,
  A10G: 1.3,
  L40S: 2.2,
  'A100-40GB': 2.5,
  'A100-80GB': 2.6,
  H100: 3.5,
}

/** Pull, replay download, evaluation and export — a fixed slice of every run. */
const OVERHEAD_SEC = 15 * 60
/** A detector frame in the archive (a full-resolution JPEG), on average. */
export const BYTES_PER_FRAME = 350 * 1024

function cameraHoldout(stats: RetrainDatasetStats): number[] {
  const withFrames = stats.cameras
    .filter((c) => c.completeFrames > 0)
    .toSorted((a, b) => b.completeFrames - a.completeFrames || a.deviceId - b.deviceId)
  if (withFrames.length < HOLDOUT_CAMERA_THRESHOLD) return []
  return withFrames.slice(1, 3).map((c) => c.deviceId)
}

function supportOf(
  stats: RetrainDatasetStats,
  cameras: ReadonlySet<number>,
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(DETECTOR_CLASSES.map((c) => [c, 0]))
  for (const cell of stats.cells) {
    if (!cameras.has(cell.deviceId)) continue
    out[cell.macroClass] = (out[cell.macroClass] ?? 0) + cell.subjects
  }
  return out
}

export interface SplitDecision {
  readonly split: TrainingSplitPlan
  readonly warnings: readonly string[]
}

/**
 * Warnings about a corpus that can train but is too thin for a trustworthy
 * first GPU run. Not a refusal: the operator may still plan (and the confirm
 * step shows the sentence).
 */
export function thinCorpusWarnings(stats: RetrainDatasetStats): readonly string[] {
  if (stats.subjects <= 0 || stats.subjects >= MIN_HOLDOUT_SUPPORT) return []
  return [
    `Only ${String(stats.subjects)} boxed subjects in this version (< ${String(MIN_HOLDOUT_SUPPORT)}): floors and the comparison will be noisy — collect more annotated frames before spending GPU time.`,
  ]
}

export function planSplit(
  stats: RetrainDatasetStats,
  requestedHoldout: readonly number[] | null,
): SplitDecision {
  const holdout = requestedHoldout ?? cameraHoldout(stats)
  const warnings: string[] = [...thinCorpusWarnings(stats)]
  if (holdout.length === 0) {
    warnings.push(
      `Fewer than ${String(HOLDOUT_CAMERA_THRESHOLD)} cameras: the last ${String(DEFAULT_HOLDOUT_DAYS)} days of every camera are held out instead of whole cameras.`,
    )
    return {
      split: {
        holdoutCameras: [],
        holdoutLastDays: DEFAULT_HOLDOUT_DAYS,
        holdoutSupport: null,
        trainSubjects: stats.subjects,
      },
      warnings,
    }
  }
  const held = new Set(holdout)
  const support = supportOf(stats, held)
  const heldSubjects = Object.values(support).reduce((a, b) => a + b, 0)
  for (const cls of DETECTOR_CLASSES) {
    const n = support[cls] ?? 0
    if (n < MIN_HOLDOUT_SUPPORT) {
      warnings.push(
        `${cls}: ${String(n)} held-out positives < ${String(MIN_HOLDOUT_SUPPORT)} — its floor will inherit the baseline's.`,
      )
    }
  }
  return {
    split: {
      holdoutCameras: [...holdout],
      holdoutLastDays: 0,
      holdoutSupport: support,
      trainSubjects: Math.max(0, stats.subjects - heldSubjects),
    },
    warnings,
  }
}

export interface GpuEstimate {
  readonly gpuSecondsLow: number
  readonly gpuSecondsHigh: number
}

export function estimateGpuSeconds(input: {
  readonly frames: number
  readonly base: BaseModelSpec
  readonly preset: TrainingPreset
  readonly gpuType: string
}): GpuEstimate {
  const preset = PRESETS[input.preset]
  const images = input.frames + preset.replay
  const resFactor = (input.base.imgsz / 640) ** 2
  const throughput =
    (L4_IMAGES_PER_SEC_640[input.base.tier] / resFactor) * (GPU_SPEED[input.gpuType] ?? 1)
  const nominal = (images * preset.epochs) / throughput + OVERHEAD_SEC
  return { gpuSecondsLow: Math.round(nominal * 0.7), gpuSecondsHigh: Math.round(nominal * 1.6) }
}

export function datasetBytesEstimate(frames: number): number {
  return frames * BYTES_PER_FRAME
}

export function uploadMinutes(bytes: number, mbps = 20): number {
  return Math.round(((bytes * 8) / (mbps * 1e6) / 60) * 10) / 10
}

/**
 * The default cost cap: the provider's own setting (operator decision
 * 2026-10-08 — it depends on the account), else 1.5× the high estimate.
 */
export function defaultCostCap(usdHigh: number, providerCap: number): number {
  if (providerCap > 0) return providerCap
  return Math.max(1, Math.ceil(usdHigh * 1.5 * 100) / 100)
}

export function knownGpu(gpus: readonly TrainingGpuOption[], gpuType: string): boolean {
  return gpus.some((g) => g.id === gpuType)
}
