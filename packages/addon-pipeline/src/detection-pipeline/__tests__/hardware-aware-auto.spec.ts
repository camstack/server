/**
 * Hardware-aware "Auto" in the LIVE step-resolution path.
 *
 * `resolveInputSteps` is the seam behind the per-frame dispatch path. When
 * the object-detection step arrives with NO `modelId` (the operator left the
 * cell on Auto) and the caller provides its resolved engine, the default must
 * be the node's HARDWARE-AWARE pick (`resolveDefaultDetectionModel` — e.g.
 * intel-gpu → yolo26m-256), not the flat catalog default (`yolo26n`).
 *
 * A PINNED `modelId` is kept verbatim; every other step keeps its flat
 * per-format default; omitting the engine keeps the pre-existing flat
 * behaviour (no caller does this in production).
 */
import type { PipelineStepInput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { resolveDefaultDetectionModel } from '../default-detection-model'
import { getDefaultModelForFormat } from '../registry/step-definitions'
import { resolveInputSteps, type StepResolutionEngine } from '../step-resolution'

function detectionStep(overrides: Partial<PipelineStepInput> = {}): PipelineStepInput {
  return {
    addonId: 'object-detection',
    enabled: true,
    children: [],
    ...overrides,
  }
}

const INTEL_GPU: StepResolutionEngine = { backend: 'openvino', device: 'gpu' }
const APPLE_ANE: StepResolutionEngine = { backend: 'coreml', device: 'all' }
const CPU_FLOOR: StepResolutionEngine = { backend: 'onnx', device: 'cpu' }

describe('resolveInputSteps — hardware-aware Auto (object-detection)', () => {
  it('absent modelId + intel-gpu engine resolves the accelerated default (yolov9m-320-int8), not the flat nano', () => {
    const { steps } = resolveInputSteps([detectionStep()], 'openvino', INTEL_GPU)
    expect(steps[0]?.modelId).toBe('yolov9m-320-int8')
    expect(steps[0]?.modelId).toBe(resolveDefaultDetectionModel('openvino', 'gpu', 'openvino'))
  })

  it('absent modelId + apple-ane engine resolves the CoreML v9 default (yolov9m-320)', () => {
    const { steps } = resolveInputSteps([detectionStep()], 'coreml', APPLE_ANE)
    expect(steps[0]?.modelId).toBe('yolov9m-320')
  })

  it('absent modelId + cpu engine resolves the safe nano (yolo26n)', () => {
    const { steps } = resolveInputSteps([detectionStep()], 'onnx', CPU_FLOOR)
    expect(steps[0]?.modelId).toBe('yolo26n')
  })

  it('a PINNED modelId is kept verbatim (never replaced by the hardware default)', () => {
    const { steps, diagnostics } = resolveInputSteps(
      [detectionStep({ modelId: 'yolo26s' })],
      'openvino',
      INTEL_GPU,
    )
    expect(steps[0]?.modelId).toBe('yolo26s')
    expect(diagnostics.substitutions).toEqual([])
  })

  it('an Auto resolve reports NO substitution diagnostic (nothing was overridden)', () => {
    const { diagnostics } = resolveInputSteps([detectionStep()], 'openvino', INTEL_GPU)
    expect(diagnostics.substitutions).toEqual([])
  })

  it('non-detection steps keep their flat per-format default even with an engine', () => {
    const input: PipelineStepInput = {
      addonId: 'face-detection',
      enabled: true,
      children: [],
    }
    const { steps } = resolveInputSteps([input], 'openvino', INTEL_GPU)
    expect(steps[0]?.modelId).toBe(getDefaultModelForFormat('face-detection', 'openvino'))
  })

  it('the engine threads into CHILD steps of the tree (recursive Auto)', () => {
    const tree: PipelineStepInput = {
      addonId: 'object-detection',
      enabled: true,
      children: [detectionStep()],
    }
    const { steps } = resolveInputSteps([tree], 'openvino', INTEL_GPU)
    expect(steps[0]?.children?.[0]?.modelId).toBe('yolov9m-320-int8')
  })

  it('omitting the engine keeps the flat per-format default (back-compat)', () => {
    const { steps } = resolveInputSteps([detectionStep()], 'openvino')
    expect(steps[0]?.modelId).toBe(getDefaultModelForFormat('object-detection', 'openvino'))
  })
})
