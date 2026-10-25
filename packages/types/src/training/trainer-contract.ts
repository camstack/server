/**
 * The trainer contract — what the hub hands the cloud trainer and what it
 * gets back (cloud training, D805+).
 *
 * The trainer (`hf/camstack-trainer`, published as the Hugging Face repo
 * `camstack/camstack-trainer`) is a separate AGPL program the hub never
 * imports: `job.json` goes in, files come out, and progress is `CAMSTACK_EVENT`
 * lines on stdout. These schemas are the hub's half of that boundary; the
 * trainer's pydantic models (and the JSON Schemas generated from them under
 * `hf/camstack-trainer/schemas/`) are the other half. A change here is a
 * change there, in the same piece of work.
 *
 * No `.default()` anywhere: defaults do not run on the addon cap path, so the
 * orchestrator fills every field of a job spec explicitly.
 */
import { z } from 'zod'

export const TRAINING_JOB_SCHEMA = 'camstack.training/v1'
export const TRAINING_RESULT_SCHEMA = 'camstack.training-result/v1'

/** The stdout prefix of a progress line. Anything else on stdout is log text. */
export const CAMSTACK_EVENT_PREFIX = 'CAMSTACK_EVENT '

/** What the trainer can export. Edge TPU is a later, separate image. */
export const TrainingExportSchema = z.enum([
  'onnx',
  'openvino-fp16',
  'openvino-int8',
  'coreml-fp16',
])
export type TrainingExport = z.infer<typeof TrainingExportSchema>

const FloorsSchema = z.record(z.string(), z.number().min(0).max(1))

export const TrainingJobSpecSchema = z.object({
  schema: z.literal(TRAINING_JOB_SCHEMA),
  jobKey: z.string().uuid(),
  target: z.object({ kind: z.literal('detector'), step: z.literal('object-detection') }),
  base: z.object({
    modelId: z.string().min(1),
    /** Ultralytics weights id, e.g. `yolov9m.pt`. */
    weights: z.string().min(1),
    imgsz: z.number().int().positive(),
  }),
  baseline: z.object({
    modelId: z.string().min(1),
    /** The baseline ONNX the holdout comparison runs; public mirror URL. */
    onnxUrl: z.string().url(),
    imgsz: z.number().int().positive(),
    floors: FloorsSchema,
  }),
  dataset: z.object({
    versionId: z.string().min(1),
    annotationHash: z.string(),
    /** sha256 of the uploaded archive; the trainer refuses a mismatch (exit 65). */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  split: z.object({
    holdoutCameras: z.array(z.number().int()),
    /** When no camera is held out: the last N days of every camera. */
    holdoutLastDays: z.number().int().nonnegative(),
    valFraction: z.number().min(0).max(0.5),
    seed: z.number().int(),
  }),
  hyper: z.object({
    epochs: z.number().int().positive(),
    batch: z.number().int().positive(),
    lr0: z.number().positive(),
    /** Layers frozen from the start of the backbone; 0 = none. */
    freeze: z.number().int().nonnegative(),
    patience: z.number().int().nonnegative(),
    seed: z.number().int(),
  }),
  replay: z.object({ source: z.literal('coco2017'), count: z.number().int().nonnegative() }),
  exports: z.array(TrainingExportSchema).min(1),
  calibration: z.object({ maxFrames: z.number().int().positive() }),
  floors: z.object({ minSupport: z.number().int().positive(), clamp: z.number().min(0).max(1) }),
  int8Gate: z.object({ maxMap50Drop: z.number().min(0).max(1) }),
  catalog: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
    name: z.string().min(1).max(160),
  }),
})
export type TrainingJobSpec = z.infer<typeof TrainingJobSpecSchema>

/** One regular file of the bundle. An mlpackage contributes one row per member. */
export const TrainingResultFileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  format: z.enum(['onnx', 'openvino', 'coreml', 'pt']),
  variant: z.enum(['base', 'int8']),
})
export type TrainingResultFile = z.infer<typeof TrainingResultFileSchema>

const DraftFormatSchema = z.object({
  /** RELATIVE path inside the bundle; the hub rewrites it to `camstack-local://`. */
  url: z.string().min(1),
  sizeMB: z.number().nonnegative(),
  isDirectory: z.boolean().optional(),
  files: z.array(z.string()).optional(),
  runtimes: z.array(z.literal('python')).optional(),
  revision: z.string().min(1),
})

/** The trainer's half of a catalog entry; the hub completes it (labels, licence, group). */
export const TrainingCatalogDraftSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  labels: z.array(z.unknown()),
  inputSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  preprocessMode: z.literal('letterbox'),
  defaultClassFloors: FloorsSchema,
  formats: z.object({
    onnx: DraftFormatSchema.optional(),
    openvino: DraftFormatSchema.optional(),
    coreml: DraftFormatSchema.optional(),
  }),
})
export type TrainingCatalogDraft = z.infer<typeof TrainingCatalogDraftSchema>

/** One class of one model's holdout report (the eval harness's summary). */
export const TrainingEvalClassSchema = z
  .object({
    positives: z.number().int(),
    floor: z.number().nullable(),
    tp: z.number().int(),
    fp: z.number().int(),
    fn: z.number().int(),
    precision: z.number().nullable(),
    recall: z.number().nullable(),
    ap50: z.number().nullable(),
    recallByCamera: z.record(z.string(), z.number().nullable()).optional(),
    recallByLight: z.record(z.string(), z.number().nullable()).optional(),
    fpByCamera: z.record(z.string(), z.number()).optional(),
    smallFound: z.number().int().optional(),
    smallTotal: z.number().int().optional(),
  })
  .passthrough()
export type TrainingEvalClass = z.infer<typeof TrainingEvalClassSchema>

export const TrainingEvalReportSchema = z
  .object({ frames: z.number().int(), classes: z.record(z.string(), TrainingEvalClassSchema) })
  .passthrough()
export type TrainingEvalReport = z.infer<typeof TrainingEvalReportSchema>

/**
 * A succeeded result carries every block; a failed one carries the error and
 * whatever was known by then — the other blocks are ABSENT, not null. The
 * orchestrator checks the blocks it needs before it trusts a success.
 */
export const TrainingResultSchema = z.object({
  schema: z.literal(TRAINING_RESULT_SCHEMA),
  jobKey: z.string(),
  status: z.enum(['succeeded', 'failed']),
  error: z.object({ stage: z.string(), code: z.string(), message: z.string() }).nullable(),
  trainer: z.object({ version: z.string(), revision: z.string() }),
  toolchain: z.record(z.string(), z.string().nullable()),
  dataset: z
    .object({
      versionId: z.string(),
      annotationHash: z.string(),
      sha256: z.string(),
      frames: z.object({
        train: z.number().int(),
        val: z.number().int(),
        holdout: z.number().int(),
      }),
      holdoutCameras: z.array(z.number().int()),
      replayImages: z.number().int(),
    })
    .optional(),
  training: z
    .object({
      epochsRun: z.number().int(),
      bestEpoch: z.number().int(),
      bestMap50: z.number(),
      bestMap50_95: z.number(),
      seconds: z.number(),
    })
    .optional(),
  evaluation: z
    .object({
      holdoutFrames: z.number().int(),
      baseline: TrainingEvalReportSchema.nullable(),
      candidate: TrainingEvalReportSchema.nullable(),
      candidateInt8: TrainingEvalReportSchema.nullable(),
      recallDeltaByCamera: z.record(z.string(), z.record(z.string(), z.number())).nullable(),
      map50: z.record(z.string(), z.number().nullable()),
    })
    .optional(),
  floors: z
    .object({
      baseline: FloorsSchema,
      candidate: FloorsSchema,
      candidateInt8: FloorsSchema.nullable(),
      notes: z.array(z.string()),
    })
    .optional(),
  int8: z
    .object({
      kept: z.boolean(),
      map50Fp16: z.number().nullable(),
      map50Int8: z.number().nullable(),
      reason: z.string().nullable(),
    })
    .optional(),
  exportsDropped: z.array(z.object({ export: z.string(), reason: z.string() })).optional(),
  files: z.array(TrainingResultFileSchema).optional(),
  bundle: z
    .object({
      path: z.literal('bundle.tar'),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .nullable()
    .optional(),
  catalogDraft: z
    .object({ base: TrainingCatalogDraftSchema, int8: TrainingCatalogDraftSchema.nullable() })
    .nullable()
    .optional(),
  licence: z.string(),
})
export type TrainingResult = z.infer<typeof TrainingResultSchema>

// ── Progress events (stdout) ─────────────────────────────────────────

export const TrainingStageSchema = z.enum([
  'prepare',
  'replay',
  'train',
  'eval',
  'export',
  'package',
])
export type TrainingStage = z.infer<typeof TrainingStageSchema>

const EventBase = { v: z.literal(1), ts: z.number() }

export const TrainingEventSchema = z.discriminatedUnion('type', [
  z.object({ ...EventBase, type: z.literal('stage'), stage: TrainingStageSchema }),
  z.object({
    ...EventBase,
    type: z.literal('epoch'),
    epoch: z.number().int(),
    epochs: z.number().int(),
    boxLoss: z.number().nullable().optional(),
    map50: z.number().nullable().optional(),
    map50_95: z.number().nullable().optional(),
    etaSec: z.number().nullable().optional(),
  }),
  z.object({ ...EventBase, type: z.literal('metric'), name: z.string(), value: z.number() }),
  z.object({
    ...EventBase,
    type: z.literal('artifact'),
    path: z.string(),
    bytes: z.number(),
    sha256: z.string(),
  }),
  z.object({
    ...EventBase,
    type: z.literal('done'),
    status: z.enum(['succeeded', 'failed']),
    resultSha256: z.string().nullable().optional(),
  }),
  z.object({
    ...EventBase,
    type: z.literal('error'),
    stage: z.string(),
    code: z.string(),
    message: z.string(),
  }),
])
export type TrainingEvent = z.infer<typeof TrainingEventSchema>

/**
 * Parse one stdout line. `null` = not an event (plain log text, or an event
 * line this hub does not understand — a newer trainer may add types).
 */
export function parseTrainingEventLine(line: string): TrainingEvent | null {
  const start = line.indexOf(CAMSTACK_EVENT_PREFIX)
  if (start < 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(line.slice(start + CAMSTACK_EVENT_PREFIX.length))
  } catch {
    return null
  }
  const parsed = TrainingEventSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
