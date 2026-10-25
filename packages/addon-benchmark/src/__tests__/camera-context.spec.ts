/**
 * Resolving a camera to the `(node, deviceKey)` the pipeline really uses.
 *
 * The bench used to invent its tree from `schema.slots[].addons[].defaultModelId`
 * — one model per step, node-wide — which no camera necessarily runs, and it
 * had one dropdown (node) where the system has three coordinates
 * (camera → node → deviceKey). These are the rules that make "run what 102
 * actually runs, on the accelerator it actually runs on" true rather than
 * claimed.
 */
import { describe, expect, it } from 'vitest'
import type { NodeDevice } from '../camera-context.js'
import { describeResolvedSteps, deviceKeyOf, resolvedStepsToRunSteps } from '../camera-context.js'

/** The hub's real roster, read off `pipelineOrchestrator.getNodeInferenceDevices`. */
const HUB_DEVICES: readonly NodeDevice[] = [
  { key: 'cpu', backend: 'cpu', device: 'cpu', format: 'onnx', available: true },
  { key: 'edgetpu:usb', backend: 'edgetpu', device: 'usb', format: 'tflite', available: true },
  { key: 'openvino:gpu', backend: 'openvino', device: 'gpu', format: 'openvino', available: true },
  { key: 'openvino:npu', backend: 'openvino', device: 'npu', format: 'openvino', available: true },
]

describe('deviceKeyOf', () => {
  /**
   * The key comes from the node's OWN roster, matched on the live engine —
   * never composed by this file. `cpu` + `cpu` is spelled `cpu`, not
   * `cpu:cpu`, and only the roster knows that.
   */
  it('returns the roster key for the live engine', () => {
    expect(deviceKeyOf({ backend: 'openvino', device: 'npu' }, HUB_DEVICES)).toBe('openvino:npu')
    expect(deviceKeyOf({ backend: 'cpu', device: 'cpu' }, HUB_DEVICES)).toBe('cpu')
    expect(deviceKeyOf({ backend: 'edgetpu', device: 'usb' }, HUB_DEVICES)).toBe('edgetpu:usb')
  })

  it('is undefined when there is no live engine', () => {
    expect(deviceKeyOf(undefined, HUB_DEVICES)).toBeUndefined()
  })

  /**
   * A roster that does not contain the engine the camera is reported on is a
   * real disagreement — a stale status, or a device that went away. Compose
   * the documented `<backend>:<device>` form so the operator sees WHAT the
   * camera claims, and let the UI mark it unmatched. Silently substituting
   * the first available device would run the bench somewhere else and call
   * it the camera's answer.
   */
  it('falls back to <backend>:<device> when the roster does not list it', () => {
    expect(deviceKeyOf({ backend: 'coreml', device: 'all' }, HUB_DEVICES)).toBe('coreml:all')
  })
})

describe('resolvedStepsToRunSteps', () => {
  /**
   * `resolvePipeline` is the single owner of "which model runs on this
   * (camera, node, device)". An ABSENT `modelId` means "the executing node
   * resolves its own format default" — filling one in here would be a second
   * model resolution in a second place, which is the exact failure
   * `scripts/check-step-model-single-owner.ts` exists to prevent.
   */
  it('passes an absent modelId through untouched', () => {
    const out = resolvedStepsToRunSteps([{ addonId: 'object-detection', enabled: true }])
    expect(out[0]).toEqual({ addonId: 'object-detection', enabled: true, children: [] })
    expect('modelId' in out[0]!).toBe(false)
  })

  it('keeps a resolved modelId exactly as resolvePipeline returned it', () => {
    const out = resolvedStepsToRunSteps([
      { addonId: 'object-detection', modelId: 'yolov9m-320-int8', enabled: true },
    ])
    expect(out[0]!.modelId).toBe('yolov9m-320-int8')
  })

  it('carries children and per-step settings', () => {
    const out = resolvedStepsToRunSteps([
      {
        addonId: 'object-detection',
        modelId: 'yolo26n',
        enabled: true,
        settings: { minScore: 0.3 },
        children: [{ addonId: 'face-detection', modelId: 'scrfd', enabled: true }],
      },
    ])
    expect(out[0]!.settings).toEqual({ minScore: 0.3 })
    expect(out[0]!.children?.[0]?.addonId).toBe('face-detection')
  })
})

describe('describeResolvedSteps', () => {
  it('renders the tree the camera really runs, marking node-resolved models', () => {
    const lines = describeResolvedSteps([
      {
        addonId: 'object-detection',
        modelId: 'yolov9m-320-int8',
        enabled: true,
        children: [{ addonId: 'face-detection', enabled: false }],
      },
    ])
    expect(lines).toEqual([
      { depth: 0, addonId: 'object-detection', modelLabel: 'yolov9m-320-int8', enabled: true },
      { depth: 1, addonId: 'face-detection', modelLabel: 'node default', enabled: false },
    ])
  })
})
