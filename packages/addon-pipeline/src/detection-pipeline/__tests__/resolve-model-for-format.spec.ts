import { describe, it, expect } from 'vitest'
import {
  resolveModelForFormat,
  getDefaultModelForFormat,
  getStepDefinition,
} from '../registry/step-definitions.js'

// object-detection is a well-known step with multiple format builds in the catalog.
const STEP = 'object-detection'

describe('object-detection format default (legacy curation)', () => {
  // With the whole YOLOv9 family + fp16 dupes marked legacy, the smallest
  // NON-legacy model on every format is yolo26n — so the auto format-default
  // finally AGREES with the declared `defaultModelId` (was: yolov9t /
  // yolov9t-int8 silently won the smallest-by-size race).
  it('picks yolo26n on every format (no legacy yolov9t drift)', () => {
    expect(getDefaultModelForFormat(STEP, 'onnx')).toBe('yolo26n')
    expect(getDefaultModelForFormat(STEP, 'coreml')).toBe('yolo26n')
    expect(getDefaultModelForFormat(STEP, 'openvino')).toBe('yolo26n')
  })

  it('an EXPLICIT legacy pin falls back to the format default (no longer offered)', () => {
    // Legacy = still in the catalog for an old pin, but hidden from the picker.
    // Since f74a47280 a legacy pin no longer keeps running a model the picker
    // cannot name: it resolves to the format default, and because chosen ≠
    // resolved the caller surfaces it as a substitution (visible, not silent).
    const def = getStepDefinition(STEP)
    const legacy = def.models.find((m) => m.id === 'yolo26n-fp16')
    expect(legacy?.legacy).toBe(true)
    expect(legacy?.formats['openvino']).toBeDefined()
    expect(resolveModelForFormat(STEP, 'yolo26n-fp16', 'openvino')).toBe(
      getDefaultModelForFormat(STEP, 'openvino'),
    )
    // A NON-legacy model with the same build is kept as chosen.
    expect(resolveModelForFormat(STEP, 'yolo26n-int8', 'openvino')).toBe('yolo26n-int8')
  })
})

describe('resolveModelForFormat', () => {
  it('null chosen → format default', () => {
    expect(resolveModelForFormat(STEP, null, 'coreml')).toBe(
      getDefaultModelForFormat(STEP, 'coreml'),
    )
    expect(resolveModelForFormat(STEP, null, 'openvino')).toBe(
      getDefaultModelForFormat(STEP, 'openvino'),
    )
  })

  it('chosen catalog model WITH a build for the format → chosen kept', () => {
    // Pick a real catalog model that has the coreml format.
    const def = getStepDefinition(STEP)
    const coremlModel = def.models.find((m) => m.formats['coreml'])
    expect(coremlModel).toBeDefined()
    expect(resolveModelForFormat(STEP, coremlModel!.id, 'coreml')).toBe(coremlModel!.id)
  })

  it('chosen catalog model WITHOUT a build for the format → format default (substitution)', () => {
    const def = getStepDefinition(STEP)
    // A model that has openvino but NOT coreml — resolve for coreml must substitute.
    const openvinoOnly = def.models.find((m) => m.formats['openvino'] && !m.formats['coreml'])
    if (!openvinoOnly) return // catalog has no such model on this build — skip
    expect(resolveModelForFormat(STEP, openvinoOnly.id, 'coreml')).toBe(
      getDefaultModelForFormat(STEP, 'coreml'),
    )
  })

  it('chosen model that is NOT in the catalog (custom) → returned unchanged', () => {
    expect(resolveModelForFormat(STEP, 'my-custom-model-xyz', 'coreml')).toBe('my-custom-model-xyz')
  })

  it('unknown stepId → chosen returned unchanged, no throw', () => {
    expect(resolveModelForFormat('no-such-step', 'whatever', 'coreml')).toBe('whatever')
    expect(() => resolveModelForFormat('no-such-step', null, 'coreml')).not.toThrow()
  })
})
