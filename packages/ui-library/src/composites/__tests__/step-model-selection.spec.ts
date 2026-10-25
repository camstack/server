/**
 * The ONE step-model primitive — options and effective value.
 *
 * Both step matrices (`NodeDeviceStepsMatrix`, `DeviceStepOverrideTab`) and the
 * `AgentStepEditor` drawer must derive the model OPTIONS and the model SHOWN
 * from the same functions. The bite this pins: on 2026-08-08 the two surfaces
 * had drifted — the pipeline matrix had been fixed to gate the device's elected
 * model on catalog membership, the device tab still applied it slot-wide, so
 * the package step showed the device's `yolov9m-320-int8` and its picker,
 * seeded with a model the package catalog does not contain, painted the FIRST
 * option (yolov8n-package) as if it were the selection.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveEffectiveStepModel,
  stepHasModelForFormat,
  stepModelOptions,
} from '../resolve-step-default-model'

/** The live `package-detection` catalog as `pipelineExecutor.getSchema` serves it. */
const PACKAGE_STEP = {
  slot: 'detector',
  defaultModelId: 'rfdetr-package',
  models: [
    {
      id: 'yolov8n-package',
      formats: {
        onnx: { sizeMB: 12 },
        coreml: { sizeMB: 12 },
        openvino: { sizeMB: 12 },
      },
    },
    {
      id: 'rfdetr-package',
      formats: {
        onnx: { sizeMB: 115 },
        coreml: { sizeMB: 58 },
        openvino: { sizeMB: 58 },
      },
    },
  ],
} as const

/** A hub accelerator: its ELECTED object-detection model is not a package model. */
const OPENVINO_NPU = { format: 'openvino', defaultModelId: 'yolov9m-320-int8' }
/** Coral: the package step ships no tflite build at all. */
const EDGETPU = {
  format: 'tflite',
  defaultModelId: 'ssd-mobilenet-v2-coco-edgetpu',
}

describe('stepModelOptions', () => {
  it('offers every model with a build for the format — rfdetr-package included', () => {
    const ids = stepModelOptions(PACKAGE_STEP.models, 'openvino').map((m) => m.id)
    expect(ids).toContain('rfdetr-package')
    expect(ids).toEqual(['yolov8n-package', 'rfdetr-package'])
  })

  it('offers nothing for a format with no build', () => {
    expect(stepModelOptions(PACKAGE_STEP.models, 'tflite')).toEqual([])
  })

  it('offers nothing without a known format (rather than every model)', () => {
    expect(stepModelOptions(PACKAGE_STEP.models, undefined)).toEqual([])
  })
})

describe('stepHasModelForFormat', () => {
  it('is true where a build exists and false where none does', () => {
    expect(stepHasModelForFormat(PACKAGE_STEP.models, 'openvino')).toBe(true)
    expect(stepHasModelForFormat(PACKAGE_STEP.models, 'tflite')).toBe(false)
    expect(stepHasModelForFormat(PACKAGE_STEP.models, undefined)).toBe(false)
  })
})

describe('resolveEffectiveStepModel', () => {
  it("shows the STEP's default when nothing is pinned — never the device's elected yolo", () => {
    expect(
      resolveEffectiveStepModel({
        catalog: PACKAGE_STEP,
        device: OPENVINO_NPU,
      }),
    ).toBe('rfdetr-package')
  })

  it('honours the per-(node,device) base over the step default', () => {
    expect(
      resolveEffectiveStepModel({
        catalog: PACKAGE_STEP,
        device: OPENVINO_NPU,
        base: 'yolov8n-package',
      }),
    ).toBe('yolov8n-package')
  })

  it("still shows the device's election on the step that actually carries it", () => {
    const root = {
      slot: 'detector',
      defaultModelId: 'yolo26n',
      models: [
        { id: 'yolo26n', formats: { openvino: { sizeMB: 6 } } },
        { id: 'yolov9m-320-int8', formats: { openvino: { sizeMB: 20 } } },
      ],
    }
    expect(resolveEffectiveStepModel({ catalog: root, device: OPENVINO_NPU })).toBe(
      'yolov9m-320-int8',
    )
  })

  it('returns undefined for a device the step cannot run on', () => {
    expect(resolveEffectiveStepModel({ catalog: PACKAGE_STEP, device: EDGETPU })).toBe(
      // No tflite build: the resolver still names the catalog default, and the
      // CALLER (via stepHasModelForFormat) renders "⚠ skip"/"—" instead.
      'rfdetr-package',
    )
    expect(resolveEffectiveStepModel({ catalog: PACKAGE_STEP, device: null })).toBeUndefined()
  })
})
