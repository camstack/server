import type { InferenceDeviceDescriptor } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  annotateInferenceDeviceExclusions,
  makeRootCapabilityGuard,
  mergeInferenceDevices,
  resolveInferenceDeviceEligibility,
} from '../inference-device-model.js'

/**
 * `getNodeInferenceDevices` must REPORT why an accelerator the node has is not
 * a camera-root candidate — the operator should read the reason, not deduce it.
 *
 * Two of the four reasons are underivable from the row itself:
 *  - `accelerator-preferred` needs the node-wide "an accelerator is serving"
 *    predicate (D215) — a CPU row stored `enabled:true, available:true` looks
 *    perfectly eligible on its own;
 *  - `cannot-host-camera-root` needs the node's model catalog.
 * So the annotation is computed from the SAME `resolveInferenceDeviceEligibility`
 * the dispatcher runs, and never re-derived in the UI.
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

describe('annotateInferenceDeviceExclusions', () => {
  it('marks an eligible accelerator with a null exclusion', () => {
    const stored = {
      'openvino:npu': { enabled: true, weight: 50 },
      'openvino:gpu': { enabled: true, weight: 50 },
    }
    const merged = mergeInferenceDevices([NPU, GPU], stored)
    const annotated = annotateInferenceDeviceExclusions(
      merged,
      resolveInferenceDeviceEligibility([NPU, GPU], stored),
    )

    expect(annotated.map((d) => [d.key, d.exclusion])).toEqual([
      ['openvino:gpu', null],
      ['openvino:npu', null],
    ])
  })

  it('names accelerator-preferred on an enabled+available CPU beside a serving accelerator', () => {
    const stored = {
      'openvino:npu': { enabled: true, weight: 50 },
      cpu: { enabled: true, weight: 1 },
    }
    const merged = mergeInferenceDevices([NPU, CPU], stored)
    const annotated = annotateInferenceDeviceExclusions(
      merged,
      resolveInferenceDeviceEligibility([NPU, CPU], stored),
    )

    const cpuRow = annotated.find((d) => d.key === 'cpu')
    // The row alone says enabled + available: only the node-wide rule explains it.
    expect(cpuRow?.enabled).toBe(true)
    expect(cpuRow?.available).toBe(true)
    expect(cpuRow?.exclusion).toBe('accelerator-preferred')
  })

  it('names disabled, unavailable and cannot-host-camera-root distinctly', () => {
    const stored = {
      'openvino:npu': { enabled: true, weight: 50 },
      'openvino:gpu': { enabled: false, weight: 50 },
      'edgetpu:usb': { enabled: true, weight: 1 },
    }
    const lostNpu = mkDescriptor('openvino:npu', 'openvino', 'npu', 'openvino', false)
    const probed = [lostNpu, GPU, CORAL]
    // Catalog can run openvino roots but has no tflite root model.
    const guard = makeRootCapabilityGuard({
      slots: [
        {
          addons: [
            {
              id: 'object-detection',
              models: [{ id: 'yolov9m-320-int8', formats: { openvino: true } }],
            },
          ],
        },
      ],
    } as never)
    const merged = mergeInferenceDevices(probed, stored)
    const annotated = annotateInferenceDeviceExclusions(
      merged,
      resolveInferenceDeviceEligibility(probed, stored, guard),
    )

    const byKey = new Map(annotated.map((d) => [d.key, d.exclusion]))
    expect(byKey.get('openvino:gpu')).toBe('disabled')
    expect(byKey.get('openvino:npu')).toBe('unavailable')
    expect(byKey.get('edgetpu:usb')).toBe('cannot-host-camera-root')
  })

  it('preserves the merged row order and every other field', () => {
    const stored = { 'openvino:npu': { enabled: true, weight: 50, maxSessions: 2 } }
    const merged = mergeInferenceDevices([NPU], stored)
    const annotated = annotateInferenceDeviceExclusions(
      merged,
      resolveInferenceDeviceEligibility([NPU], stored),
    )

    expect(annotated).toHaveLength(1)
    expect(annotated[0]).toMatchObject({ ...merged[0], exclusion: null })
  })
})
