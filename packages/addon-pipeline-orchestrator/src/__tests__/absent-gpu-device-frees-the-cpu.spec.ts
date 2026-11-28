import { describe, expect, it } from 'vitest'
import type { InferenceDeviceDescriptor } from '@dominevo/types'
import {
  annotateInferenceDeviceExclusions,
  mergeInferenceDevices,
  resolveInferenceDeviceEligibility,
  resolveNodeInferenceUsability,
} from '../inference-device-model.js'

/**
 * i7-8700K, UHD 630 (Gen9.5), `/dev/dri/renderD128` present: the compute runtime
 * no longer supports the iGPU, so OpenVINO enumerates NO GPU. The hardware probe
 * still lists `openvino:gpu` (the device node exists), the executor answers every
 * GPU load with `no-gpu-device`, and the orchestrator used to keep that device
 * "up" — so the CPU stayed `accelerator-preferred`, the node's only eligible
 * device was a corpse, and the camera got no detection at all.
 */
function mk(
  key: string,
  backend: string,
  device: string,
  format: string,
): InferenceDeviceDescriptor {
  return { key, backend, device, format, available: true } as InferenceDeviceDescriptor
}

const GPU = mk('openvino:gpu', 'openvino', 'gpu', 'openvino')
const CPU = mk('cpu', 'cpu', 'cpu', 'onnx')
const STORED = {
  'openvino:gpu': { enabled: true, weight: 50 },
  cpu: { enabled: true, weight: 1 },
}
const absent = (key: string) => (key === 'openvino:gpu' ? ('no-gpu-device' as const) : null)

describe('an inference device the runtime does not see', () => {
  it('is excluded with its named reason and the CPU becomes eligible', () => {
    const { eligible, excluded } = resolveInferenceDeviceEligibility(
      [GPU, CPU],
      STORED,
      undefined,
      undefined,
      undefined,
      absent,
    )
    expect(excluded).toEqual([{ key: 'openvino:gpu', reason: 'no-gpu-device', format: 'openvino' }])
    expect(eligible).toEqual({ cpu: 1 })
  })

  it('the view names the reason where the exclusion reasons surface', () => {
    const eligibility = resolveInferenceDeviceEligibility(
      [GPU, CPU],
      STORED,
      undefined,
      undefined,
      undefined,
      absent,
    )
    const rows = annotateInferenceDeviceExclusions(
      mergeInferenceDevices([GPU, CPU], STORED),
      eligibility,
    )
    expect(rows.find((r) => r.key === 'openvino:gpu')?.exclusion).toBe('no-gpu-device')
    expect(rows.find((r) => r.key === 'cpu')?.exclusion).toBeNull()
  })

  it('does not make the node unusable (the CPU serves)', () => {
    const eligibility = resolveInferenceDeviceEligibility(
      [GPU, CPU],
      STORED,
      undefined,
      undefined,
      undefined,
      absent,
    )
    expect(resolveNodeInferenceUsability(eligibility).usable).toBe(true)
  })

  it('without the absent signal the CPU stays held back (the old behaviour)', () => {
    const { eligible } = resolveInferenceDeviceEligibility([GPU, CPU], STORED)
    expect(eligible).toEqual({ 'openvino:gpu': 50 })
  })
})
