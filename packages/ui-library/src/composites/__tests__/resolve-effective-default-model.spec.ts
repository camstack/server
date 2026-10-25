/**
 * The device's elected model applies only where it BELONGS — see
 * `resolveEffectiveDefaultModel`'s docblock for the live bite (the package
 * step showed the device's yolo as its default the day rfdetr became the
 * package default).
 */
import { describe, it, expect } from 'vitest'
import { resolveEffectiveDefaultModel } from '../resolve-step-default-model'

const DEVICE = { format: 'openvino', defaultModelId: 'yolo26n' }

describe('resolveEffectiveDefaultModel', () => {
  it('shows the device election on the step that carries that model (root detector)', () => {
    const root = {
      slot: 'detector',
      defaultModelId: 'yolov9m-320-int8',
      models: [
        { id: 'yolov9m-320-int8', formats: { openvino: { sizeMB: 20 } } },
        { id: 'yolo26n', formats: { openvino: { sizeMB: 6 } } },
      ],
    }
    expect(resolveEffectiveDefaultModel(root, DEVICE)).toBe('yolo26n')
  })

  it('resolves the STEP default for a detector-slot step whose catalog lacks the election — the package case', () => {
    const packageStep = {
      slot: 'detector',
      defaultModelId: 'rfdetr-package',
      models: [
        { id: 'yolov8n-package', formats: { openvino: { sizeMB: 12 } } },
        { id: 'rfdetr-package', formats: { openvino: { sizeMB: 58 } } },
      ],
    }
    expect(resolveEffectiveDefaultModel(packageStep, DEVICE)).toBe('rfdetr-package')
  })

  it('never applies the election outside the detector slot', () => {
    const face = {
      slot: 'cropper',
      defaultModelId: 'face-a',
      models: [
        { id: 'face-a', formats: { openvino: { sizeMB: 4 } } },
        { id: 'yolo26n', formats: { openvino: { sizeMB: 6 } } },
      ],
    }
    expect(resolveEffectiveDefaultModel(face, DEVICE)).toBe('face-a')
  })

  it('returns undefined without a device format', () => {
    expect(
      resolveEffectiveDefaultModel({ slot: 'detector', defaultModelId: 'x', models: [] }, null),
    ).toBeUndefined()
  })
})
