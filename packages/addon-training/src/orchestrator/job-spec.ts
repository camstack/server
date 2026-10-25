/**
 * `job.json` for the trainer, built from a job record — every field filled
 * here, none left to a default (defaults do not run on the addon cap path,
 * and the trainer's spec has none either). Validated against the shared
 * contract before it leaves the hub.
 */
import {
  TRAINING_JOB_SCHEMA,
  type TrainingJob,
  type TrainingJobSpec,
  TrainingJobSpecSchema,
} from '@camstack/types'
import type { BaseModelSpec } from './base-models.js'
import { PRESETS } from './planner.js'

/** The trainer's evaluation and gate parameters — one place, one value. */
export const JOB_EVAL_DEFAULTS = {
  valFraction: 0.15,
  seed: 1,
  batch: 16,
  lr0: 0.002,
  patience: 10,
  calibrationFrames: 300,
  minSupport: 20,
  floorClamp: 0.15,
  int8MaxMap50Drop: 0.02,
} as const

/** The catalog id of a job's result: `custom-<base>-<first 8 of the job key>`. */
export function resultModelId(job: Pick<TrainingJob, 'id' | 'request'>): string {
  return `custom-${job.request.baseModelId}-${job.id.replaceAll('-', '').slice(0, 8)}`
}

export function buildJobSpec(input: {
  readonly job: TrainingJob
  readonly base: BaseModelSpec
  readonly versionId: string
  readonly annotationHash: string
  readonly datasetSha256: string
}): TrainingJobSpec {
  const { job, base } = input
  const preset = PRESETS[job.request.preset]
  const spec: TrainingJobSpec = {
    schema: TRAINING_JOB_SCHEMA,
    jobKey: job.id,
    target: { kind: 'detector', step: 'object-detection' },
    base: { modelId: base.modelId, weights: base.weights, imgsz: base.imgsz },
    baseline: {
      modelId: base.modelId,
      onnxUrl: base.baselineOnnxUrl,
      imgsz: base.imgsz,
      floors: { ...base.baselineFloors },
    },
    dataset: {
      versionId: input.versionId,
      annotationHash: input.annotationHash,
      sha256: input.datasetSha256,
    },
    split: {
      holdoutCameras: [...job.split.holdoutCameras],
      holdoutLastDays: job.split.holdoutLastDays,
      valFraction: JOB_EVAL_DEFAULTS.valFraction,
      seed: JOB_EVAL_DEFAULTS.seed,
    },
    hyper: {
      epochs: preset.epochs,
      batch: JOB_EVAL_DEFAULTS.batch,
      lr0: JOB_EVAL_DEFAULTS.lr0,
      freeze: job.request.freeze ?? preset.freeze,
      patience: JOB_EVAL_DEFAULTS.patience,
      seed: JOB_EVAL_DEFAULTS.seed,
    },
    replay: { source: 'coco2017', count: preset.replay },
    exports: ['onnx', 'openvino-fp16', 'openvino-int8', 'coreml-fp16'],
    calibration: { maxFrames: JOB_EVAL_DEFAULTS.calibrationFrames },
    floors: { minSupport: JOB_EVAL_DEFAULTS.minSupport, clamp: JOB_EVAL_DEFAULTS.floorClamp },
    int8Gate: { maxMap50Drop: JOB_EVAL_DEFAULTS.int8MaxMap50Drop },
    catalog: { id: resultModelId(job), name: `${base.label} — ${job.name}` },
  }
  return TrainingJobSpecSchema.parse(spec)
}
