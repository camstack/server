/**
 * Auto tune never overwrites a custom model (cloud-training P7, D786). A
 * device whose root detector is pinned to a custom-registry model — a
 * fine-tune, a canary — is KEPT: no model is chosen for it, so the plan has
 * nothing to write there. The accelerators of a node share one model, so one
 * custom-pinned accelerator keeps the whole accelerator group (a camera's
 * floors must not flip with the device the balancer rotates it onto).
 */
import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../../../interfaces/platform.js'
import type { ModelFormat } from '../../../types/models.js'
import { type AutoTuneNodeInput, recommendNode } from '../recommend.js'

const HW: HardwareInfo = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel(R) Core(TM) Ultra 7 265K',
  cpuCores: 20,
  totalRAM_MB: 65536,
  availableRAM_MB: 32768,
  gpu: null,
  npu: null,
}

const FORMATS: Readonly<Record<string, readonly ModelFormat[]>> = Object.fromEntries(
  ['t', 's', 'm'].flatMap((tier) =>
    ['320', '640'].flatMap((res) => [
      [`yolov9${tier}-${res}`, ['onnx', 'openvino'] as const],
      [`yolov9${tier}-${res}-int8`, ['openvino'] as const],
    ]),
  ),
)

function hub(pins: Readonly<Record<string, string>>): AutoTuneNodeInput {
  return {
    nodeId: 'hub',
    reachable: true,
    hardware: HW,
    devices: ['cpu', 'openvino:gpu', 'openvino:npu'].map((key) => ({
      key,
      format: key === 'cpu' ? 'onnx' : 'openvino',
      enabled: true,
      available: true,
      ...(pins[key] !== undefined ? { customPinModelId: pins[key] } : {}),
    })),
    formatsByModel: FORMATS,
  }
}

describe('Auto tune keeps custom-pinned devices', () => {
  it('without a custom pin every enabled device gets a model', () => {
    const rec = recommendNode({ node: hub({}) })
    expect(rec.devices.every((d) => d.chosen !== null)).toBe(true)
    expect(rec.devices.every((d) => d.kept === undefined)).toBe(true)
  })

  it('a custom-pinned accelerator keeps its whole accelerator group, and says why', () => {
    const rec = recommendNode({ node: hub({ 'openvino:npu': 'custom-yolov9m-640-ft' }) })

    for (const key of ['openvino:gpu', 'openvino:npu']) {
      const device = rec.devices.find((d) => d.deviceKey === key)
      expect(device?.chosen).toBeNull()
      expect(device?.kept).toBe('custom-pin')
      expect(device?.reasons).toContainEqual({
        kind: 'kept-custom-pin',
        modelId: 'custom-yolov9m-640-ft',
        deviceKey: 'openvino:npu',
      })
    }
    expect(rec.acceleratorModelId).toBeNull()
    // The CPU is its own group and is still tuned.
    expect(rec.devices.find((d) => d.deviceKey === 'cpu')?.chosen).not.toBeNull()
  })

  it('a custom-pinned CPU is kept alone', () => {
    const rec = recommendNode({ node: hub({ cpu: 'custom-yolov9s-320-ft' }) })
    expect(rec.devices.find((d) => d.deviceKey === 'cpu')?.kept).toBe('custom-pin')
    expect(rec.devices.find((d) => d.deviceKey === 'openvino:npu')?.chosen).not.toBeNull()
  })

  it('a node whose every device is kept is skipped', () => {
    const rec = recommendNode({
      node: hub({ cpu: 'custom-a', 'openvino:gpu': 'custom-b', 'openvino:npu': 'custom-b' }),
    })
    expect(rec.skipped).toBe(true)
  })
})
