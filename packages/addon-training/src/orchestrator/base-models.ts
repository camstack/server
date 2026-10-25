/**
 * The base models a detector job can fine-tune: the fleet's YOLOv9 family.
 *
 * `baselineFloors` are the measured per-class floors of the fp32 catalog row
 * (D739, `docs/benchmarks/model-floors.json`, mirrored in the pipeline's
 * catalog); a spec holds this table equal to that file, so a re-measurement
 * that forgets this table fails CI. `suppliedLabelFloors` are the base's D741
 * root-supply floors, copied onto the fine-tune because nothing has measured
 * the fine-tune's own yet.
 */
import type { TrainingBaseModel } from '@camstack/types'

const HF_MODELS = 'https://huggingface.co/camstack/camstack-models/resolve/main'

export interface BaseModelSpec extends TrainingBaseModel {
  /** `t`/`s`/`m`/`c`, used by the GPU-time model. */
  readonly tier: 't' | 's' | 'm' | 'c'
  /** D741 floors of the base (fp32 row) and of its INT8 row. */
  readonly suppliedLabelFloors: Readonly<Record<string, number>>
  readonly suppliedLabelFloorsInt8: Readonly<Record<string, number>>
}

const TIER_LABEL: Readonly<Record<BaseModelSpec['tier'], string>> = {
  t: 'Tiny',
  s: 'Small',
  m: 'Medium',
  c: 'Compact',
}

function base(
  tier: BaseModelSpec['tier'],
  res: 320 | 640,
  floors: Readonly<Record<string, number>>,
  supplied: {
    readonly fp32?: Readonly<Record<string, number>>
    readonly int8?: Readonly<Record<string, number>>
  } = {},
): BaseModelSpec {
  return {
    modelId: `yolov9${tier}-${String(res)}`,
    label: `YOLOv9 ${TIER_LABEL[tier]} @${String(res)}`,
    weights: `yolov9${tier}.pt`,
    imgsz: res,
    baselineOnnxUrl: `${HF_MODELS}/objectDetection/yolov9/onnx/camstack-yolov9${tier}-${String(res)}.onnx`,
    baselineFloors: floors,
    recommended: tier === 'm' && res === 640,
    tier,
    suppliedLabelFloors: supplied.fp32 ?? {},
    suppliedLabelFloorsInt8: supplied.int8 ?? {},
  }
}

export const BASE_MODELS: readonly BaseModelSpec[] = [
  base(
    'm',
    640,
    { person: 0.6, vehicle: 0.4, animal: 0.55 },
    { int8: { 'animal-classifier': 0.7 } },
  ),
  base(
    'm',
    320,
    { person: 0.7, vehicle: 0.5, animal: 0.55 },
    { int8: { 'animal-classifier': 0.75 } },
  ),
  base('s', 640, { person: 0.7, vehicle: 0.4, animal: 0.6 }),
  base('s', 320, { person: 0.7, vehicle: 0.55, animal: 0.4 }),
  base(
    'c',
    640,
    { person: 0.55, vehicle: 0.45, animal: 0.3 },
    { int8: { 'animal-classifier': 0.75 } },
  ),
  base('c', 320, { person: 0.7, vehicle: 0.45, animal: 0.45 }),
  base('t', 640, { person: 0.65, vehicle: 0.5, animal: 0.5 }),
  base('t', 320, { person: 0.55, vehicle: 0.45, animal: 0.3 }),
]

export function findBaseModel(modelId: string): BaseModelSpec | null {
  return BASE_MODELS.find((m) => m.modelId === modelId) ?? null
}

/** The public shape (`listBaseModels`) — the internal fields stay here. */
export function publicBaseModel(spec: BaseModelSpec): TrainingBaseModel {
  return {
    modelId: spec.modelId,
    label: spec.label,
    weights: spec.weights,
    imgsz: spec.imgsz,
    baselineOnnxUrl: spec.baselineOnnxUrl,
    baselineFloors: { ...spec.baselineFloors },
    recommended: spec.recommended,
  }
}
