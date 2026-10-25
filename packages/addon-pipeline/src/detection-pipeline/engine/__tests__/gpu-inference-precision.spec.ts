/**
 * D738 follow-up — some YOLO26 base FP32 IRs return no valid detection on an
 * Intel GPU at its default f16 inference precision (2026-10-07, Core Ultra
 * iGPU and N100: `yolo26s` 0 true / 146 false positives, `yolo26m` and
 * `yolo26m-320` NaN scores). At f32 they match the CPU.
 *
 * The fix is DATA: the catalog entry states `gpuInferencePrecision: 'f32'`,
 * the engine factory threads it into the pool config, the serializer puts it
 * on the wire, and the Python pool sets INFERENCE_PRECISION_HINT on a GPU only
 * (`python/test_inference_pool_ov_precision.py`). No name matching.
 */
import { describe, expect, it } from 'vitest'
import {
  OBJECT_DETECTION_MODELS,
  OPENVINO_GPU_F32_MODEL_ID_LIST,
} from '../../registry/model-catalogs.js'
import { buildPoolModelConfigForStep } from '../engine-factory.js'
import { serializeModelConfig } from '../shared-inference-pool.js'

/** Measured broken at the GPU default precision. */
const MEASURED_BROKEN = ['yolo26s', 'yolo26m', 'yolo26m-320'] as const
/** Measured correct at the GPU default precision — must stay at full speed. */
const MEASURED_FINE = ['yolo26n', 'yolo26n-320', 'yolo26s-320'] as const

function precisionOf(id: string): string | undefined {
  const entry = OBJECT_DETECTION_MODELS.find((m) => m.id === id)
  if (entry === undefined) throw new Error(`catalog lost ${id}`)
  return entry.gpuInferencePrecision
}

describe('catalog — which IRs need f32 on a GPU', () => {
  it.each(MEASURED_BROKEN)('%s requires f32', (id) => {
    expect(precisionOf(id)).toBe('f32')
  })

  it.each(MEASURED_FINE)('%s keeps the device default', (id) => {
    expect(precisionOf(id)).toBeUndefined()
  })

  it('no INT8 IR and no YOLOv9 entry is slowed down', () => {
    for (const entry of OBJECT_DETECTION_MODELS) {
      if (entry.group?.precision === 'int8' || entry.group?.family === 'yolov9') {
        expect(entry.gpuInferencePrecision).toBeUndefined()
      }
    }
  })
})

describe('the requirement reaches the pool', () => {
  const build = (modelId: string) =>
    buildPoolModelConfigForStep({
      stepId: 'object-detection',
      modelId,
      poolRuntime: 'openvino',
      modelsDir: '/nonexistent-models-dir',
    })

  it('the pool config carries it for a model that needs it, and only then', () => {
    expect(build('yolo26s').gpuInferencePrecision).toBe('f32')
    expect(build('yolov9m-320-int8').gpuInferencePrecision).toBeUndefined()
  })

  it('the wire carries it as the key the Python pool reads', () => {
    expect(serializeModelConfig(build('yolo26s'))['gpuInferencePrecision']).toBe('f32')
    expect('gpuInferencePrecision' in serializeModelConfig(build('yolo26n'))).toBe(false)
  })
})

describe('the f32 list names only catalog entries', () => {
  it('every listed id is an object-detection model', () => {
    const ids = new Set(OBJECT_DETECTION_MODELS.map((m) => m.id))
    for (const id of OPENVINO_GPU_F32_MODEL_ID_LIST) expect(ids.has(id)).toBe(true)
  })
})
