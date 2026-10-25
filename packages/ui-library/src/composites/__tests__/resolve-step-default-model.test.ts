import { describe, it, expect } from 'vitest'
import { resolveStepDefaultModel, type StepModelCatalog } from '../resolve-step-default-model'

/** A face-detection–like step: two models, all with cross-format builds. */
const FACE: StepModelCatalog = {
  defaultModelId: 'scrfd-2.5g',
  models: [
    {
      id: 'scrfd-2.5g',
      formats: { onnx: { sizeMB: 3 }, coreml: { sizeMB: 3 }, openvino: { sizeMB: 3 } },
    },
    {
      id: 'scrypted-yolov9t-face',
      formats: { onnx: { sizeMB: 8 }, coreml: { sizeMB: 8 }, openvino: { sizeMB: 8 } },
    },
  ],
}

/** An object-detection–like step with a per-format tflite override (Coral). */
const OBJECT: StepModelCatalog = {
  defaultModelId: 'yolo26n',
  defaultModelIdByFormat: { tflite: 'ssd-mobilenet-v2-coco-edgetpu' },
  models: [
    { id: 'yolo26n', formats: { onnx: { sizeMB: 6 }, openvino: { sizeMB: 6 } } },
    { id: 'yolo26s', formats: { onnx: { sizeMB: 12 }, openvino: { sizeMB: 12 } } },
    { id: 'ssd-mobilenet-v2-coco-edgetpu', formats: { tflite: { sizeMB: 7 } } },
    // A superseded tiny lineage: smaller than the curated default but LEGACY,
    // so it must NOT win the openvino auto-pick.
    { id: 'yolov9t-legacy', legacy: true, formats: { openvino: { sizeMB: 1 } } },
  ],
}

describe('resolveStepDefaultModel', () => {
  it('returns the step defaultModelId when it has a build for the format', () => {
    expect(resolveStepDefaultModel(FACE, 'openvino')).toBe('scrfd-2.5g')
    expect(resolveStepDefaultModel(FACE, 'onnx')).toBe('scrfd-2.5g')
    expect(resolveStepDefaultModel(OBJECT, 'openvino')).toBe('yolo26n')
  })

  it('honours the declared per-format default over the plain default', () => {
    expect(resolveStepDefaultModel(OBJECT, 'tflite')).toBe('ssd-mobilenet-v2-coco-edgetpu')
  })

  it('never returns an object-detection model for a face/plate step (the DEFECT-2 bug)', () => {
    // The reported bug showed "yolov9…" for every row; the face step must resolve
    // its OWN catalog default, never the device object-detection model.
    const resolved = resolveStepDefaultModel(FACE, 'openvino')
    expect(resolved).toBe('scrfd-2.5g')
    expect(resolved.startsWith('yolo')).toBe(false)
  })

  it('falls back to the smallest NON-legacy build when neither default has one', () => {
    const noDefaultBuild: StepModelCatalog = {
      defaultModelId: 'onnx-only',
      models: [
        { id: 'onnx-only', formats: { onnx: { sizeMB: 5 } } },
        { id: 'big-openvino', formats: { openvino: { sizeMB: 20 } } },
        { id: 'small-openvino', formats: { openvino: { sizeMB: 4 } } },
        { id: 'tiny-legacy', legacy: true, formats: { openvino: { sizeMB: 1 } } },
      ],
    }
    // legacy is excluded, smallest non-legacy openvino build wins.
    expect(resolveStepDefaultModel(noDefaultBuild, 'openvino')).toBe('small-openvino')
  })

  it('returns defaultModelId unchanged when no compatible build exists', () => {
    expect(resolveStepDefaultModel(FACE, 'tflite')).toBe('scrfd-2.5g')
  })
})
