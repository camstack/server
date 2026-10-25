/**
 * D745, D755 — the Auto tune recommender on the operator's three nodes: a
 * Core Ultra 7 265K hub (NPU + iGPU, Coral attached, CPU off), an N100 agent
 * (iGPU, CPU off) and an Apple M2 Mac mini (Neural Engine, CPU off). Sized by
 * a capacity floor — at least N parallel sessions per device — never by load.
 */
import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../../../interfaces/platform.js'
import type { ModelFormat } from '../../../types/models.js'
import type { NodeRecommendation } from '../plan-schemas.js'
import { classifyInferenceHardware } from '../hardware-class.js'
import { type AutoTuneNodeInput, capacitySessionsOf, recommendNode } from '../recommend.js'

function hw(
  cpuModel: string,
  arch: HardwareInfo['arch'],
  platform: HardwareInfo['platform'],
): HardwareInfo {
  return {
    platform,
    arch,
    cpuModel,
    cpuCores: 8,
    totalRAM_MB: 16384,
    availableRAM_MB: 8192,
    gpu: null,
    npu: null,
  }
}

const BASE_FORMATS: readonly ModelFormat[] = ['onnx', 'openvino', 'coreml']
const INT8_FORMATS: readonly ModelFormat[] = ['openvino']
const FORMATS: Readonly<Record<string, readonly ModelFormat[]>> = Object.fromEntries(
  ['t', 's', 'm'].flatMap((tier) =>
    ['320', '640'].flatMap((res) => [
      [`yolov9${tier}-${res}`, BASE_FORMATS],
      [`yolov9${tier}-${res}-int8`, INT8_FORMATS],
    ]),
  ),
)

const HUB: AutoTuneNodeInput = {
  nodeId: 'hub',
  reachable: true,
  hardware: hw('Intel(R) Core(TM) Ultra 7 265K', 'x64', 'linux'),
  devices: [
    { key: 'cpu', format: 'onnx', enabled: false, available: true },
    { key: 'edgetpu:usb', format: 'tflite', enabled: false, available: true },
    { key: 'openvino:gpu', format: 'openvino', enabled: true, available: true },
    { key: 'openvino:npu', format: 'openvino', enabled: true, available: true },
  ],
  formatsByModel: FORMATS,
}

const N100: AutoTuneNodeInput = {
  nodeId: 'agent-a',
  reachable: true,
  hardware: hw('Intel(R) N100', 'x64', 'linux'),
  devices: [
    { key: 'cpu', format: 'onnx', enabled: false, available: true },
    { key: 'openvino:gpu', format: 'openvino', enabled: true, available: true },
  ],
  formatsByModel: FORMATS,
}

const MAC: AutoTuneNodeInput = {
  nodeId: 'mac',
  reachable: true,
  hardware: hw('Apple M2', 'arm64', 'darwin'),
  devices: [
    { key: 'coreml:all', format: 'coreml', enabled: true, available: true },
    { key: 'cpu', format: 'onnx', enabled: false, available: true },
  ],
  formatsByModel: FORMATS,
}

function modelOn(rec: NodeRecommendation, deviceKey: string): string | null {
  return rec.devices.find((d) => d.deviceKey === deviceKey)?.chosen?.modelId ?? null
}

describe('classifyInferenceHardware', () => {
  it('reads the class from the host CPU string', () => {
    expect(
      classifyInferenceHardware(hw('Intel(R) Core(TM) Ultra 7 265K', 'x64', 'linux')).hardwareClass,
    ).toBe('intel-core-ultra')
    expect(classifyInferenceHardware(hw('Intel(R) N100', 'x64', 'linux')).hardwareClass).toBe(
      'intel-n-series',
    )
    expect(classifyInferenceHardware(hw('Apple M2', 'arm64', 'darwin')).hardwareClass).toBe(
      'apple-m-base',
    )
    expect(classifyInferenceHardware(hw('Apple M3 Pro', 'arm64', 'darwin')).hardwareClass).toBe(
      'apple-m-pro',
    )
    expect(classifyInferenceHardware(hw('AMD Ryzen 7 5800X', 'x64', 'linux')).hardwareClass).toBe(
      'unknown',
    )
    expect(classifyInferenceHardware(hw('AMD Ryzen 7 7640HS', 'x64', 'linux')).hardwareClass).toBe(
      'amd-phoenix',
    )
    expect(classifyInferenceHardware(hw('AMD Ryzen 5 8600G', 'x64', 'linux')).hardwareClass).toBe(
      'amd-phoenix',
    )
  })
})

describe('capacitySessionsOf', () => {
  it('counts whole sessions at the camera rate with the headroom kept free', () => {
    expect(capacitySessionsOf(52, 0.4, 10)).toBe(3)
    expect(capacitySessionsOf(26, 0.4, 10)).toBe(1)
    expect(capacitySessionsOf(50, 0.4, 10)).toBe(3)
    expect(capacitySessionsOf(0, 0.4, 10)).toBe(0)
    expect(capacitySessionsOf(99, 0.4, 0)).toBe(0)
  })
})

describe('recommendNode — at least two sessions per device (the default), the operator cluster', () => {
  const hub = recommendNode({ node: HUB })
  const n100 = recommendNode({ node: N100 })
  const mac = recommendNode({ node: MAC })

  it('hub: m-640-int8 on BOTH accelerators — m-640 would carry one session on the NPU, the int8 build carries 3 and 2', () => {
    expect(modelOn(hub, 'openvino:npu')).toBe('yolov9m-640-int8')
    expect(modelOn(hub, 'openvino:gpu')).toBe('yolov9m-640-int8')
    expect(hub.acceleratorModelId).toBe('yolov9m-640-int8')
    expect(hub.devices.find((d) => d.deviceKey === 'openvino:gpu')?.reasons[0]).toEqual({
      kind: 'capacity',
      sessions: 2,
      minSessions: 2,
    })
  })

  it('hub: the Coral, the CPU and every disabled device are left alone', () => {
    expect(modelOn(hub, 'edgetpu:usb')).toBeNull() // disabled
    expect(modelOn(hub, 'cpu')).toBeNull()
    expect(hub.devices.find((d) => d.deviceKey === 'cpu')?.reasons).toEqual([
      { kind: 'device-disabled' },
    ])
  })

  it('N100: s-320-int8 — refreshed m-320-int8 (15 fps) clears no 10 fps session with headroom', () => {
    expect(modelOn(n100, 'openvino:gpu')).toBe('yolov9s-320-int8')
    expect(n100.reasons).toContainEqual(
      expect.objectContaining({ kind: 'stepped-down', from: 'yolov9m-640' }),
    )
    expect(n100.devices.find((d) => d.deviceKey === 'openvino:gpu')?.chosen?.capacitySessions).toBe(
      2,
    )
  })

  it('N100 with a floor of one session: the unrevised yolov9t-640 cell still clears one', () => {
    // m-320-int8 was re-measured at 15 fps (2026-10-24), so it no longer clears
    // one 10 fps session with headroom. yolov9t-640 (38.5 ms / 26 fps) was not
    // re-measured and still does; same person recall as its int8 twin, lower p50.
    expect(modelOn(recommendNode({ node: N100, minSessionsPerDevice: 1 }), 'openvino:gpu')).toBe(
      'yolov9t-640',
    )
  })

  it('Mac M2: m-640 on the Neural Engine, from a MEASURED cell', () => {
    expect(modelOn(mac, 'coreml:all')).toBe('yolov9m-640')
    const ane = mac.devices.find((d) => d.deviceKey === 'coreml:all')
    expect(ane?.chosen?.measured).toBe(true)
  })

  it('the plan does not depend on anything but hardware, the floor, the headroom and the camera rate', () => {
    expect(recommendNode({ node: HUB })).toEqual(hub)
  })
})

describe('recommendNode — the step-down follows the data', () => {
  it('a higher floor keeps 640 and drops the tier first (m-640-int8 → s-640-int8)', () => {
    const rec = recommendNode({ node: HUB, minSessionsPerDevice: 4 })
    expect(rec.acceleratorModelId).toBe('yolov9s-640-int8')
  })

  it('higher still, it goes to 320', () => {
    const rec = recommendNode({ node: HUB, minSessionsPerDevice: 7 })
    expect(rec.acceleratorModelId).toBe('yolov9m-320-int8')
  })

  it('one model per node: the slower accelerator limits the pick for both', () => {
    // A floor of 3: m-640-int8 carries 3 on the NPU (52 fps) but 2 on the iGPU (44 fps).
    const rec = recommendNode({ node: HUB, minSessionsPerDevice: 3 })
    expect(modelOn(rec, 'openvino:npu')).toBe(modelOn(rec, 'openvino:gpu'))
    expect(rec.acceleratorModelId).not.toBe('yolov9m-640-int8')
    expect(rec.reasons).toContainEqual(
      expect.objectContaining({
        kind: 'stepped-down',
        limitedBy: 'openvino:gpu',
      }),
    )
  })

  it('a faster camera rate counts fewer sessions', () => {
    const rec = recommendNode({ node: N100, cameraFps: 20 })
    // s-320-int8 (34 fps) carries one 20 fps session; t-320-int8 (67 fps) carries two.
    expect(modelOn(rec, 'openvino:gpu')).toBe('yolov9t-320-int8')
  })

  it('nothing reaches the floor: the model with the most capacity, said so', () => {
    const rec = recommendNode({ node: N100, minSessionsPerDevice: 8 })
    expect(rec.reasons[0]).toEqual({
      kind: 'no-fit-lightest',
      sessions: 4,
      minSessions: 8,
    })
    expect(rec.acceleratorModelId).toBe('yolov9t-320-int8')
  })
})

describe('recommendNode — nodes it must not touch', () => {
  it('an offline node is skipped', () => {
    const rec = recommendNode({ node: { ...HUB, reachable: false } })
    expect(rec.skipped).toBe(true)
    expect(rec.reasons).toEqual([{ kind: 'node-offline' }])
  })

  it('an unmeasured CPU class is skipped, never guessed', () => {
    const rec = recommendNode({
      node: { ...HUB, hardware: hw('AMD Ryzen 7 5800X', 'x64', 'linux') },
    })
    expect(rec.skipped).toBe(true)
    expect(rec.reasons).toEqual([{ kind: 'no-measured-data', hardwareClass: 'unknown' }])
  })

  it('an enabled Coral is sized at its default model with the measured latency (D912)', () => {
    const rec = recommendNode({
      node: {
        ...HUB,
        devices: HUB.devices.map((d) => (d.key === 'edgetpu:usb' ? { ...d, enabled: true } : d)),
        formatsByModel: { ...FORMATS, 'yolov9s-320-edgetpu': ['tflite'] },
      },
    })
    const coral = rec.devices.find((d) => d.deviceKey === 'edgetpu:usb')
    expect(coral?.chosen?.modelId).toBe('yolov9s-320-edgetpu')
    expect(coral?.chosen?.p50Ms).toBe(32)
    expect(coral?.chosen?.fps).toBe(31)
    expect(coral?.reasons.map((r) => r.kind)).toContain('capacity')
    // The Coral is its own pick: it never drags the accelerator group's model.
    expect(rec.acceleratorModelId).toBe('yolov9m-640-int8')
  })

  it('a disabled Coral (stored enabled:false) gets no model (D912)', () => {
    const rec = recommendNode({
      node: { ...HUB, formatsByModel: { ...FORMATS, 'yolov9s-320-edgetpu': ['tflite'] } },
    })
    const coral = rec.devices.find((d) => d.deviceKey === 'edgetpu:usb')
    expect(coral?.chosen).toBeNull()
    expect(coral?.reasons).toEqual([{ kind: 'device-disabled' }])
  })

  it('an enabled Coral whose catalog has no Edge TPU build is reported, not guessed', () => {
    const rec = recommendNode({
      node: {
        ...HUB,
        devices: HUB.devices.map((d) => (d.key === 'edgetpu:usb' ? { ...d, enabled: true } : d)),
      },
    })
    const coral = rec.devices.find((d) => d.deviceKey === 'edgetpu:usb')
    expect(coral?.chosen).toBeNull()
    expect(coral?.reasons).toEqual([{ kind: 'no-family-build', format: 'tflite' }])
  })

  it('an enabled x86 CPU gets its own pick from the builds it can run', () => {
    const rec = recommendNode({
      node: {
        ...N100,
        devices: N100.devices.map((d) => ({ ...d, enabled: true })),
      },
      minSessionsPerDevice: 1,
    })
    const cpu = rec.devices.find((d) => d.deviceKey === 'cpu')
    expect(cpu?.chosen?.modelId).toMatch(/^yolov9[tsm]-(320|640)$/)
    expect(cpu?.reasons[0]).toEqual({ kind: 'cpu-device' })
  })
})
