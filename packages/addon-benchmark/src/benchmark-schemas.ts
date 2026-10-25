/**
 * Zod schemas for the benchmark customActions catalog: the Image section's
 * single run. The node benchmark is the orchestrator's (D791) and has no
 * schema here; the history, the synthetic bench and the session replay are
 * gone with it.
 */
import { z } from 'zod'
import type { PipelineStepInputOutput } from '@camstack/types'
import { PipelineStepInputSchema } from '@camstack/types'

// Re-export the underlying type so this file fully owns the public
// surface of the schemas — keeps tsup's DTS portable.
export type { PipelineStepInputOutput }

// ─── Detection Pipeline single run ────────────────────────────────────────

export interface PipelineRunInputShape {
  readonly steps: readonly PipelineStepInputOutput[]
  readonly imageBase64?: string
  readonly referenceImage?: string
  readonly nodeId?: string
  readonly sessionId?: string
  /**
   * Inference-device selector of `nodeId`, `<backend>:<device>` —
   * `openvino:npu`, `edgetpu:usb`, `coreml:all`, `cpu`. Selects WHICH device
   * pool of the node runs the call; omitted ⇒ that node's default pool. The
   * ONLY pool selector: the `engine` override that sat beside it swapped the
   * executor's shared engine state and is gone (D646).
   */
  readonly deviceKey?: string
  /**
   * Execution plane, forwarded verbatim to `pipelineExecutor.runPipeline`.
   * `'full'` (the cap's default) runs root AND crop children in one call;
   * `'frame'` is the live per-frame dispatch — root-plane steps only.
   */
  readonly plane?: 'full' | 'frame'
}

export const PipelineRunInputSchema: z.ZodType<PipelineRunInputShape> = z.object({
  steps: z.array(PipelineStepInputSchema).readonly(),
  imageBase64: z.string().optional(),
  referenceImage: z.string().optional(),
  /** Target node. Forwarded to `pipelineExecutor.runPipeline`. Omit to run on the hub. */
  nodeId: z.string().optional(),
  /** UI correlation id stamped on every `pipeline.progress` line of the run. */
  sessionId: z.string().optional(),
  deviceKey: z.string().optional(),
  plane: z.enum(['full', 'frame']).optional(),
})

// ─── Accuracy evaluation (the Accuracy tab) ───────────────────────────────
//
// An evaluation replays a labelled dataset through one node×device with ONE
// pinned model (D54) and scores what came out. Two record kinds hold it
// (`record-kinds.ts`): `eval-run` — the pass and its summary report — and
// `eval-sample` — the slim per-sample outcome the report is computed from.
// The scorer (`accuracy/eval-score.ts`) is pure and takes these shapes.

/** The three macro classes an evaluation scores; any other class is ignored. */
export const EVAL_MACROS = ['person', 'vehicle', 'animal'] as const
export const EvalMacroSchema = z.enum(EVAL_MACROS)
export type EvalMacro = z.infer<typeof EvalMacroSchema>

/** A box NORMALISED `[0, 1]` against its image. */
export const EvalBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})
export type EvalBox = z.infer<typeof EvalBoxSchema>

/**
 * Where the dataset comes from. `retrain` is a retrain collection — the
 * operator's own reviewed annotations (D781), the truth for OUR cameras;
 * `coco-subset` is the licence-checked COCO subset, the human-labelled
 * public baseline.
 */
export const EvalDatasetSourceSchema = z.enum(['retrain', 'coco-subset'])
export type EvalDatasetSource = z.infer<typeof EvalDatasetSourceSchema>

/** One box a pass produced, slimmed to what scoring and the diff read. */
export const EvalDetectionSchema = z.object({
  /** The macro class as the executor reported it; scoring ignores anything outside {@link EVAL_MACROS}. */
  macro: z.string(),
  cls: z.string().nullable(),
  score: z.number(),
  box: EvalBoxSchema,
  /** `full` — the full-frame pass; `recovered` — added by the second pass. */
  origin: z.enum(['full', 'recovered']),
})
export type EvalDetection = z.infer<typeof EvalDetectionSchema>

/** One sample's outcome on one run. A failed measurement is `null`, never `0`. */
export const EvalSampleBodySchema = z.object({
  runId: z.string(),
  sampleId: z.string(),
  /** `false` when the sample did not run (or ran another model) — then `refusal` says why. */
  ok: z.boolean(),
  refusal: z.string().nullable(),
  /** The full-frame pass alone. */
  full: z.array(EvalDetectionSchema),
  /** What the live pipeline would output: the full pass plus the second pass's additions. */
  final: z.array(EvalDetectionSchema),
  /** Which second-pass recipe ran, `null` when none did. */
  recipe: z.enum(['motion-crop', 'uncovered-region']).nullable(),
  timings: z.object({
    fullStepMs: z.number().nullable(),
    fullPredictMs: z.number().nullable(),
    fullWallMs: z.number().nullable(),
    /** Full pass + every crop, the executor's own step time; `null` when the full step was not timed. */
    frameStepMs: z.number().nullable(),
    /** One entry per crop that ran; `null` for a crop the executor did not time. */
    cropStepMs: z.array(z.number().nullable()),
  }),
  /** Boxes the crop-only class floor removed. */
  flooredCount: z.number().int().nonnegative(),
})
export type EvalSampleBody = z.infer<typeof EvalSampleBodySchema>

/** Detection counts with the ratios derived from them; a ratio over nothing is `null`. */
export const EvalCountsSchema = z.object({
  tp: z.number().int().nonnegative(),
  fp: z.number().int().nonnegative(),
  fn: z.number().int().nonnegative(),
  recall: z.number().nullable(),
  precision: z.number().nullable(),
})
export type EvalCounts = z.infer<typeof EvalCountsSchema>

/**
 * A `model_error` annotation is a phantom the operator rejected: a box a model
 * drew where nothing is. A run that draws it again REPEATS the phantom.
 */
export const EvalPhantomStatsSchema = z.object({
  boxes: z.number().int().nonnegative(),
  repeated: z.number().int().nonnegative(),
  repeatRate: z.number().nullable(),
  byClass: z.record(
    z.string(),
    z.object({ boxes: z.number().int().nonnegative(), repeated: z.number().int().nonnegative() }),
  ),
})
export type EvalPhantomStats = z.infer<typeof EvalPhantomStatsSchema>

export const EvalScoreSchema = z.object({
  which: z.enum(['final', 'full']),
  scored: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  labelStatuses: z.record(z.string(), z.number().int().nonnegative()),
  overall: EvalCountsSchema,
  byClass: z.record(z.string(), EvalCountsSchema),
  bySize: z.record(z.string(), EvalCountsSchema),
  byLighting: z.record(z.string(), EvalCountsSchema),
  byClassSize: z.record(z.string(), EvalCountsSchema),
  /** Frames with no labelled subject: how many drew a box at all. */
  emptyFrames: z.object({
    frames: z.number().int().nonnegative(),
    framesWithFp: z.number().int().nonnegative(),
    fpBoxes: z.number().int().nonnegative(),
    fpFrameRate: z.number().nullable(),
  }),
  phantoms: EvalPhantomStatsSchema,
})
export type EvalScore = z.infer<typeof EvalScoreSchema>

export const EvalStatSchema = z.object({
  n: z.number().int().nonnegative(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
})
export type EvalStat = z.infer<typeof EvalStatSchema>

export const EvalLatencySchema = z.object({
  fullStepMs: EvalStatSchema,
  fullPredictMs: EvalStatSchema,
  fullWallMs: EvalStatSchema,
  frameStepMs: EvalStatSchema,
  cropStepMs: EvalStatSchema,
  cropsPerFrame: z.number().nullable(),
  flooredCropBoxes: z.number().int().nonnegative(),
  recoveredBoxes: z.number().int().nonnegative(),
})
export type EvalLatency = z.infer<typeof EvalLatencySchema>

/** This run against another (the reference), on the FINAL output, independent of labels. */
export const EvalDiffSchema = z.object({
  referenceRunId: z.string(),
  samples: z.number().int().nonnegative(),
  agreedBoxes: z.number().int().nonnegative(),
  lostVsRef: z.number().int().nonnegative(),
  gainedVsRef: z.number().int().nonnegative(),
  boxAgreement: z.number().nullable(),
  lostByClassSize: z.record(z.string(), z.number().int().nonnegative()),
  gainedByClassSize: z.record(z.string(), z.number().int().nonnegative()),
  worstSamples: z.array(
    z.object({
      sampleId: z.string(),
      lost: z.array(EvalDetectionSchema),
      gained: z.array(EvalDetectionSchema),
    }),
  ),
})
export type EvalDiff = z.infer<typeof EvalDiffSchema>

export const EvalRunSummarySchema = z.object({
  final: EvalScoreSchema,
  full: EvalScoreSchema,
  latency: EvalLatencySchema,
  diff: EvalDiffSchema.nullable(),
})
export type EvalRunSummary = z.infer<typeof EvalRunSummarySchema>

export const EvalRunStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled'])
export type EvalRunState = z.infer<typeof EvalRunStateSchema>

export const EvalRunBodySchema = z.object({
  datasetSource: EvalDatasetSourceSchema,
  /** The retrain collection id, or the COCO subset id. */
  datasetId: z.string(),
  /** Hash of the annotations the run was scored against: two runs compare only on the same hash. */
  annotationHash: z.string(),
  nodeId: z.string(),
  /** `<backend>:<device>` — `openvino:npu`, `coreml:all`, `edgetpu:usb`, `cpu`. */
  deviceKey: z.string(),
  /** The ONE model pinned for the whole pass (D54). */
  modelId: z.string(),
  secondPass: z.boolean(),
  state: EvalRunStateSchema,
  progress: z.object({
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  /** `null` until the run is scored. */
  summary: EvalRunSummarySchema.nullable(),
  /** Why the run failed, `null` otherwise. */
  error: z.string().nullable(),
  /** A reference run is the baseline others are diffed against; retention never trims it. */
  isReference: z.boolean(),
  createdAt: z.number(),
})
export type EvalRunBody = z.infer<typeof EvalRunBodySchema>
