import { describe, expect, it } from 'vitest'
import { benchmarkRowFor, opsAccelerators } from '../mcp/ops-accelerators.js'
import { fakeHub, noSessionContext } from './ops-fake-hub.js'

const hardware = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel(R) Core(TM) Ultra 7 265K',
  cpuCores: 20,
  totalRAM_MB: 64000,
  availableRAM_MB: 30000,
  gpu: { type: 'intel', name: 'Arc' },
  npu: { type: 'intel-npu' },
}

const device = (key: string, over: object = {}): object => ({
  key,
  backend: key.split(':')[0],
  device: key.split(':')[1] ?? 'cpu',
  available: true,
  presence: 'present',
  enabled: true,
  exclusion: null,
  defaultModelId: 'yolov9m-320-int8',
  ...over,
})

describe('benchmarkRowFor', () => {
  it('is null when the device maps to no accelerator kind', () => {
    expect(benchmarkRowFor('intel-core-ultra', null)).toBeNull()
  })

  it('reads the typed DETECTOR_PERF table: measured, estimated-only, none', () => {
    expect(benchmarkRowFor('intel-core-ultra', 'intel-npu')).toMatchObject({
      state: 'measured',
    })
    expect(benchmarkRowFor('intel-core-ultra', 'coral')).toMatchObject({
      state: 'estimated-only',
    })
    expect(benchmarkRowFor('apple-m-base', 'intel-npu')).toEqual({
      state: 'none',
    })
  })
})

describe('ops_accelerators', () => {
  const topology = [
    { id: 'hub', isOnline: true },
    { id: 'agent-off', isOnline: false },
    { id: 'agent-blind', isOnline: true },
  ]

  it('answers no-session without a hub', async () => {
    expect(await opsAccelerators(noSessionContext())).toMatchObject({
      status: 'no-session',
    })
  })

  it('reports the hardware class, devices and benchmark presence per node', async () => {
    const { ctx, calls } = fakeHub({
      'nodes.topology': topology,
      'platformProbe.getHardware': (i: unknown) =>
        typeof i === 'object' && i !== null && 'nodeId' in i && i.nodeId === 'hub'
          ? hardware
          : new Error('probe timed out'),
      'pipelineOrchestrator.getNodeInferenceDevices': (i: unknown) =>
        typeof i === 'object' && i !== null && 'nodeId' in i && i.nodeId === 'hub'
          ? {
              reachable: true,
              devices: [device('openvino:npu'), device('cpu', { enabled: false })],
            }
          : { reachable: false, devices: [] },
    })
    const out = await opsAccelerators(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const hub = out.nodes.find((n) => n.nodeId === 'hub')
    expect(hub?.hardwareClass).toBe('intel-core-ultra')
    expect(hub?.devices?.map((d) => [d.key, d.acceleratorKind, d.benchmark?.state])).toEqual([
      ['openvino:npu', 'intel-npu', 'measured'],
      ['cpu', 'x86-cpu', 'measured'],
    ])
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('a node that could not be read is unknown with a reason, never "no accelerator"', async () => {
    const { ctx } = fakeHub({
      'nodes.topology': topology,
      'platformProbe.getHardware': new Error('probe timed out'),
      'pipelineOrchestrator.getNodeInferenceDevices': {
        reachable: false,
        devices: [],
      },
    })
    const out = await opsAccelerators(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const off = out.nodes.find((n) => n.nodeId === 'agent-off')
    expect(off).toMatchObject({ online: false, devices: null })
    const blind = out.nodes.find((n) => n.nodeId === 'agent-blind')
    expect(blind?.devices).toBeNull()
    expect(blind?.hardwareClass).toBeNull()
    expect(blind?.unavailable['hardware']).toContain('probe timed out')
    expect(blind?.unavailable['devices']).toContain('unreachable')
  })

  it('refuses a protected credential', async () => {
    const { ctx, calls } = fakeHub({}, 'protected')
    expect(await opsAccelerators(ctx)).toMatchObject({ status: 'refused' })
    expect(calls).toHaveLength(0)
  })
})
