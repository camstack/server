/**
 * `pipeline stats` names every accelerator actually resident, not the one the
 * node was configured with (D463).
 *
 * ## Two corrections, both found by the operator
 *
 * 1. The field was `null` on 208 of 208 lines: `TimingSampler.runtimeInfo` was
 *    initialised to `{}` and NOTHING in the repo ever assigned it.
 *
 * 2. Fixed naively, it then read `getSelectedEngine` — the node's CONFIGURED
 *    device — and printed `python/openvino/npu`. The operator asked what that
 *    means "se girano due devices", and it was the right question: this hub
 *    holds TWO complete pools, `openvino/npu` (kind `runtime`) and
 *    `openvino/gpu` (kind `device-pool`), with the same ten models in each.
 *    The label named one and hid the other entirely. A configured value is not
 *    a measurement, and printing it on a telemetry line reads as one.
 *
 * `listLoadedEngines` is what is actually RESIDENT, per pool, and it already
 * existed — its own docblock says a `device-pool` "runs alongside the
 * `runtime` engine on a DIFFERENT accelerator".
 *
 * ## And `python` is not information
 *
 * Every engine available on this cluster is `python` (onnx, openvino, edgetpu);
 * the `node` runtime exists only in the type. A token that cannot vary tells
 * the reader nothing and costs a column on every line.
 */
import { describe, expect, it } from 'vitest'
import { buildRuntimeLabels, type ResidentEngine } from '../runtime-labels.js'

const pool = (device: string, kind: ResidentEngine['kind'], models: string[]): ResidentEngine => ({
  backend: 'openvino',
  device,
  kind,
  modelsLoaded: models,
})

const MODELS = ['object-detection/yolov9m-320-int8', 'face-detection/scrfd-2.5g']

describe('buildRuntimeLabels', () => {
  it('names BOTH accelerators when two pools are resident', () => {
    const out = buildRuntimeLabels([
      pool('npu', 'runtime', MODELS),
      pool('gpu', 'device-pool', MODELS),
    ])
    expect(out.pipelineRuntime).toBe('openvino/npu+gpu')
  })

  it('puts the runtime pool first, whatever order they arrive in', () => {
    const out = buildRuntimeLabels([
      pool('gpu', 'device-pool', MODELS),
      pool('npu', 'runtime', MODELS),
    ])
    expect(out.pipelineRuntime).toBe('openvino/npu+gpu')
  })

  it('does not print `python` — no other runtime exists on this cluster', () => {
    const out = buildRuntimeLabels([pool('npu', 'runtime', MODELS)])
    expect(out.pipelineRuntime).not.toContain('python')
    expect(out.pipelineRuntime).toBe('openvino/npu')
  })

  it('collapses the model set — two pools of the same models is one list', () => {
    const out = buildRuntimeLabels([
      pool('npu', 'runtime', MODELS),
      pool('gpu', 'device-pool', MODELS),
    ])
    expect(out.pipelineModels).toEqual(MODELS)
  })

  it('keeps a model only ONE pool holds, and says which', () => {
    const out = buildRuntimeLabels([
      pool('npu', 'runtime', ['a']),
      pool('gpu', 'device-pool', ['a', 'b']),
    ])
    expect(out.pipelineModels).toEqual(['a', 'b@gpu'])
  })

  it('omits both fields when nothing is resident — absent is not "no engine"', () => {
    const out = buildRuntimeLabels([])
    expect(out.pipelineRuntime).toBeUndefined()
    expect(out.pipelineModels).toBeUndefined()
  })

  it('omits both when the read FAILED, which is a different thing from empty', () => {
    const out = buildRuntimeLabels(null)
    expect(out.pipelineRuntime).toBeUndefined()
    expect(out.pipelineModels).toBeUndefined()
  })

  it('drops a backend that disagrees between pools rather than picking one', () => {
    // Two backends resident at once is not something the line can name in one
    // token, and inventing a winner would be the same defect as `npu` was.
    const out = buildRuntimeLabels([
      pool('npu', 'runtime', ['a']),
      { backend: 'onnx', device: 'cpu', kind: 'device-pool', modelsLoaded: ['a'] },
    ])
    expect(out.pipelineRuntime).toBe('mixed/npu+cpu')
  })
})
