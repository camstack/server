import type { ClusterDetectionDefaults, HardwareInfo, NodeInferenceDevices } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  DetectionDefaultsService,
  type DetectionDefaultsServiceDeps,
  decode4kMaxStreams,
  nodeAcceleratorOf,
} from '../detection-defaults-service.js'

const HW_X86 = { arch: 'x64' } as unknown as HardwareInfo

function devices(keys: readonly { key: string; enabled: boolean }[], reachable = true) {
  return { nodeId: 'n', reachable, devices: keys } as unknown as NodeInferenceDevices
}

describe('nodeAcceleratorOf', () => {
  it('every enabled device a CPU: cpu', () => {
    expect(nodeAcceleratorOf(devices([{ key: 'cpu:0', enabled: true }]), HW_X86)).toBe('x86-cpu')
  })
  it('a real accelerator among CPUs: the accelerator', () => {
    expect(
      nodeAcceleratorOf(
        devices([
          { key: 'cpu:0', enabled: true },
          { key: 'openvino:npu', enabled: true },
        ]),
        HW_X86,
      ),
    ).toBe('intel-npu')
  })
  it('a disabled accelerator does not count', () => {
    expect(
      nodeAcceleratorOf(
        devices([
          { key: 'cpu:0', enabled: true },
          { key: 'openvino:npu', enabled: false },
        ]),
        HW_X86,
      ),
    ).toBe('x86-cpu')
  })
  it('unreachable node, no hardware, no enabled device or an unknown key: null', () => {
    expect(nodeAcceleratorOf(devices([{ key: 'cpu:0', enabled: true }], false), HW_X86)).toBeNull()
    expect(nodeAcceleratorOf(devices([{ key: 'cpu:0', enabled: true }]), null)).toBeNull()
    expect(nodeAcceleratorOf(devices([{ key: 'cpu:0', enabled: false }]), HW_X86)).toBeNull()
    expect(nodeAcceleratorOf(devices([{ key: 'weird:9', enabled: true }]), HW_X86)).toBeNull()
  })
})

describe('decode4kMaxStreams', () => {
  it('only a 4K cell answers; a 1080p cell or no cell is null, never 0', () => {
    expect(decode4kMaxStreams({ maxStreams: 3, profile: { height: 2160 } })).toBe(3)
    expect(decode4kMaxStreams({ maxStreams: 9, profile: { height: 1080 } })).toBeNull()
    expect(decode4kMaxStreams(null)).toBeNull()
  })
})

function harness(over: Partial<DetectionDefaultsServiceDeps> = {}) {
  let stored: ClusterDetectionDefaults = {}
  const cameraStores = new Map<number, Record<string, unknown>>([
    [1, { motionFps: 4 }],
    [2, { detectionFps: 7 }],
    [3, { detectionStreamProfile: 'mid' }],
    [4, { detectionFps: 0 }], // legacy "native rate": the camera's own value
  ])
  const writeClusterDefaults = vi.fn(async (d: ClusterDetectionDefaults) => {
    stored = d
  })
  const onApplied = vi.fn(async () => {})
  const service = new DetectionDefaultsService({
    nodeIds: () => ['hub'],
    readNodeDevices: async () => devices([{ key: 'cpu:0', enabled: true }]),
    readHardware: async () => HW_X86,
    camerasByNode: () => new Map([['hub', 4]]),
    readDecode: async () => null,
    readCameraStores: async () => cameraStores,
    readClusterDefaults: async () => stored,
    writeClusterDefaults,
    onApplied,
    ...over,
  })
  return { service, writeClusterDefaults, onApplied, cameraStores, get: () => stored }
}

describe('DetectionDefaultsService', () => {
  it('plan: recommendation + current + the pinned cameras; writes nothing', async () => {
    const h = harness()
    const plan = await h.service.plan()
    expect(plan.recommendation.detectionStreamProfile).toBe('low')
    expect(plan.recommendation.detectionFps).toBe(5)
    expect(plan.current).toEqual({})
    expect(plan.overrides).toEqual({ count: 3, deviceIds: [2, 3, 4] })
    expect(h.writeClusterDefaults).not.toHaveBeenCalled()
    expect(h.onApplied).not.toHaveBeenCalled()
  })

  it('apply: writes the cluster default only, never a camera store', async () => {
    const h = harness()
    const { planHash } = await h.service.plan()
    const before = JSON.stringify([...h.cameraStores])
    const result = await h.service.apply({ planHash })
    expect(result).toEqual({
      kind: 'applied',
      written: { detectionStreamProfile: 'low', detectionFps: 5 },
    })
    expect(h.get()).toEqual({ detectionStreamProfile: 'low', detectionFps: 5 })
    expect(JSON.stringify([...h.cameraStores])).toBe(before)
    expect(h.onApplied).toHaveBeenCalledTimes(1)
  })

  it('apply with a stale hash answers stale with the fresh plan and writes nothing', async () => {
    const h = harness()
    const result = await h.service.apply({ planHash: 'not-the-hash' })
    expect(result.kind).toBe('stale')
    expect(h.writeClusterDefaults).not.toHaveBeenCalled()
  })

  it('a dimension with no recommendation is left as stored (never a guess, never 0)', async () => {
    const h = harness({
      nodeIds: () => ['hub'],
      readNodeDevices: async () => devices([{ key: 'cpu:0', enabled: true }], false),
      readClusterDefaults: async () => ({ detectionFps: 6 }),
    })
    const plan = await h.service.plan()
    expect(plan.recommendation.detectionStreamProfile).toBeNull()
    expect(plan.recommendation.detectionFps).toBeNull()
    const result = await h.service.apply({ planHash: plan.planHash })
    expect(result).toEqual({ kind: 'applied', written: { detectionFps: 6 } })
  })

  it('a node serving no camera is not judged', async () => {
    const h = harness({ camerasByNode: () => new Map() })
    const plan = await h.service.plan()
    expect(plan.recommendation.reasons).toEqual([{ kind: 'no-serving-nodes' }])
  })

  it('set: replaces the stored default, a field left out is cleared', async () => {
    const h = harness({ readClusterDefaults: async () => ({ detectionFps: 6 }) })
    await h.service.set({ detectionStreamProfile: 'mid' })
    expect(h.writeClusterDefaults).toHaveBeenCalledWith({ detectionStreamProfile: 'mid' })
  })

  it('set and apply of an unchanged default write nothing and re-resolve no camera', async () => {
    const h = harness({
      readClusterDefaults: async () => ({ detectionStreamProfile: 'low', detectionFps: 5 }),
    })
    await h.service.set({ detectionStreamProfile: 'low', detectionFps: 5 })
    const { planHash } = await h.service.plan()
    await h.service.apply({ planHash })
    expect(h.writeClusterDefaults).not.toHaveBeenCalled()
    expect(h.onApplied).not.toHaveBeenCalled()
  })
})
