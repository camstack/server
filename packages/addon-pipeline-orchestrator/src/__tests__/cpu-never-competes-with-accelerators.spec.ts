import { describe, expect, it } from 'vitest'
import type { InferenceDeviceDescriptor } from '@camstack/types'
import { resolveInferenceDeviceEligibility } from '../inference-device-model.js'

/**
 * The CPU is a SAFETY NET, never a peer of an accelerator.
 *
 * Measured on 2026-08-21: `cpu` sat stored as `enabled: true` with weight 1
 * beside two openvino devices at weight 50. The balancer minimises
 * `capacityScore / weight`, so a momentarily-idle weight-1 device scores 0 and
 * beats any loaded accelerator — with ephemeral on-motion sessions the CPU was
 * idle at nearly every decision and took **188 of 428 dispatches in ten
 * minutes** (44%, where its weight says ~1%). The hub's ONNX CPU pool hit 647%
 * CPU with 199 threads and the container 1543%.
 *
 * Weight cannot express "last resort" — a ratio always lets an empty device
 * win. So eligibility, not weight, carries the rule: while the node has ANY
 * enabled∧available accelerator, the CPU is not a candidate at all. It returns
 * the moment the accelerators do not: a node with no accelerator left must
 * keep detecting, which is the whole reason the CPU stays configured.
 */

function mkDescriptor(
  key: string,
  backend: string,
  device: string,
  format: string,
  available = true,
): InferenceDeviceDescriptor {
  return { key, backend, device, format, available } as InferenceDeviceDescriptor
}

const NPU = mkDescriptor('openvino:npu', 'openvino', 'npu', 'openvino')
const GPU = mkDescriptor('openvino:gpu', 'openvino', 'gpu', 'openvino')
const CPU = mkDescriptor('cpu', 'cpu', 'cpu', 'onnx')
const CORAL = mkDescriptor('edgetpu:usb', 'edgetpu', 'usb', 'tflite')

describe('the CPU never competes with an accelerator', () => {
  it('is excluded while an accelerator is enabled and available — even stored enabled:true', () => {
    const { eligible, excluded } = resolveInferenceDeviceEligibility([NPU, GPU, CPU], {
      'openvino:npu': { enabled: true, weight: 50 },
      'openvino:gpu': { enabled: true, weight: 50 },
      cpu: { enabled: true, weight: 1 },
    })

    expect(Object.keys(eligible).toSorted()).toEqual(['openvino:gpu', 'openvino:npu'])
    expect(excluded.find((e) => e.key === 'cpu')?.reason).toBe('accelerator-preferred')
  })

  it('serves as the fallback when every accelerator is disabled', () => {
    const { eligible } = resolveInferenceDeviceEligibility([NPU, GPU, CPU], {
      'openvino:npu': { enabled: false },
      'openvino:gpu': { enabled: false },
      cpu: { enabled: true, weight: 1 },
    })

    expect(eligible).toEqual({ cpu: 1 })
  })

  it('serves as the fallback when the accelerators are enabled but the probe lost them', () => {
    const { eligible } = resolveInferenceDeviceEligibility(
      [mkDescriptor('openvino:npu', 'openvino', 'npu', 'openvino', false), CPU],
      { 'openvino:npu': { enabled: true, weight: 50 }, cpu: { enabled: true, weight: 1 } },
    )

    expect(eligible).toEqual({ cpu: 1 })
  })

  it('an accelerator that cannot host the camera root does not keep the CPU out', () => {
    // The Coral is enabled and available but its format cannot run the root:
    // it is not a root candidate, so it must not suppress the fallback either.
    const { eligible } = resolveInferenceDeviceEligibility(
      [CORAL, CPU],
      { 'edgetpu:usb': { enabled: true }, cpu: { enabled: true } },
      (format) => format !== 'tflite',
    )

    expect(eligible).toEqual({ cpu: 1 })
  })

  it('leaves a CPU the operator switched off switched off, accelerators or not', () => {
    const { eligible, excluded } = resolveInferenceDeviceEligibility([NPU, CPU], {
      'openvino:npu': { enabled: false },
      cpu: { enabled: false },
    })

    expect(eligible).toEqual({})
    expect(excluded.find((e) => e.key === 'cpu')?.reason).toBe('disabled')
  })

  it('never removes the only device on a CPU-only node', () => {
    const { eligible } = resolveInferenceDeviceEligibility([CPU], { cpu: { enabled: true } })

    expect(eligible).toEqual({ cpu: 1 })
  })
})
