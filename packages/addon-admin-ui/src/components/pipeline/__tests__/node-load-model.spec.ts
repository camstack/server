import type { AgentLoadSummary, NodeInferenceDevice } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildNodeLoadRows, type ClusterNodeFacts } from '../node-load-model'

/**
 * The per-node load prospectus is a READING of the balancer's own inputs. Its
 * only job is to not lie:
 *  - a node the load snapshot does not carry is REPORTED as unreported, never
 *    rendered as an idle node with zeros;
 *  - the weight share is normalised over the nodes that actually compete
 *    (online ∧ detect-enabled), because that is the set `balance()` ranks;
 *  - an accelerator the dispatcher excludes carries its REASON and is out of
 *    the node's device share — the share the operator reads must be the share
 *    the balancer would apply.
 */

function load(
  nodeId: string,
  attached: number,
  active: number,
  devices: AgentLoadSummary['load']['devices'] = [],
): AgentLoadSummary {
  return {
    nodeId,
    online: true,
    score: attached,
    decodeHwaccel: 'vaapi',
    load: {
      nodeId,
      attachedCameras: attached,
      activeCameras: active,
      avgInferenceFps: 0,
      avgInferenceTimeMs: 25,
      queueDepthTotal: 0,
      devices,
      hardware: { hasGpu: true, cpuCores: 8 },
    },
  }
}

function device(key: string, overrides: Partial<NodeInferenceDevice> = {}): NodeInferenceDevice {
  return {
    key,
    backend: key.split(':')[0] ?? key,
    device: key.split(':')[1] ?? key,
    format: 'openvino',
    available: true,
    enabled: true,
    weight: 1,
    maxSessions: null,
    defaultModelId: 'yolov9m-320-int8',
    exclusion: null,
    ...overrides,
  }
}

const HUB: ClusterNodeFacts = {
  id: 'hub',
  name: 'hub',
  isOnline: true,
  detectEnabled: true,
  weight: 20,
  maxCameras: null,
}
const MAC: ClusterNodeFacts = {
  id: 'mac',
  name: 'Mac mini',
  isOnline: true,
  detectEnabled: true,
  weight: 70,
  maxCameras: 4,
}
const N100: ClusterNodeFacts = {
  id: 'n100',
  name: 'agent-a',
  isOnline: true,
  detectEnabled: true,
  weight: 10,
  maxCameras: null,
}

describe('buildNodeLoadRows', () => {
  it('normalises the weight share over the nodes that actually compete', () => {
    const rows = buildNodeLoadRows({
      nodes: [HUB, MAC, N100],
      loads: [load('hub', 2, 2), load('mac', 3, 3), load('n100', 0, 0)],
      devicesByNode: {},
    })

    expect(rows.map((r) => [r.nodeId, r.weightSharePct])).toEqual([
      ['hub', 20],
      ['mac', 70],
      ['n100', 10],
    ])
  })

  it('excludes an offline or detect-disabled node from the weight denominator', () => {
    const rows = buildNodeLoadRows({
      nodes: [HUB, { ...MAC, isOnline: false }, { ...N100, detectEnabled: false }],
      loads: [load('hub', 2, 2)],
      devicesByNode: {},
    })

    const byId = new Map(rows.map((r) => [r.nodeId, r]))
    expect(byId.get('hub')?.weightSharePct).toBe(100)
    expect(byId.get('mac')?.weightSharePct).toBeNull()
    expect(byId.get('n100')?.weightSharePct).toBeNull()
  })

  it('reports a node with no load snapshot as unreported instead of idle', () => {
    const rows = buildNodeLoadRows({
      nodes: [HUB, MAC],
      loads: [load('hub', 2, 2)],
      devicesByNode: {},
    })

    const mac = rows.find((r) => r.nodeId === 'mac')
    expect(mac?.reported).toBe(false)
    expect(mac?.attachedCameras).toBeNull()
    expect(mac?.score).toBeNull()
  })

  it('computes the capacity fill only when the node carries a cap', () => {
    const rows = buildNodeLoadRows({
      nodes: [HUB, MAC],
      loads: [load('hub', 2, 2), load('mac', 3, 3)],
      devicesByNode: {},
    })

    const byId = new Map(rows.map((r) => [r.nodeId, r]))
    expect(byId.get('hub')?.capacityPct).toBeNull()
    expect(byId.get('mac')?.capacityPct).toBe(75)
  })

  it('joins live per-device sessions onto the node accelerators', () => {
    const rows = buildNodeLoadRows({
      nodes: [HUB],
      loads: [
        load('hub', 1, 1, [
          {
            deviceKey: 'openvino:npu',
            backend: 'openvino',
            attachedCameras: 1,
          },
        ]),
      ],
      devicesByNode: {
        hub: [device('openvino:gpu', { weight: 50 }), device('openvino:npu', { weight: 50 })],
      },
    })

    const devices = rows[0]!.devices
    expect(devices.map((d) => [d.key, d.sessions])).toEqual([
      ['openvino:gpu', 0],
      ['openvino:npu', 1],
    ])
    // No runner measures a per-device queue depth (D762): the row carries
    // none, rather than a 0 that reads as a measurement.
    expect(devices.every((d) => !('queueDepth' in d))).toBe(true)
  })

  it('keeps an excluded accelerator visible, out of the share, and carrying its reason', () => {
    const rows = buildNodeLoadRows({
      nodes: [HUB],
      loads: [load('hub', 2, 2)],
      devicesByNode: {
        hub: [
          device('cpu', { format: 'onnx', weight: 1, exclusion: 'accelerator-preferred' }),
          device('edgetpu:usb', { format: 'tflite', exclusion: 'disabled', enabled: false }),
          device('openvino:gpu', { weight: 50 }),
          device('openvino:npu', { weight: 50 }),
        ],
      },
    })

    const devices = rows[0]!.devices
    // In-rotation devices sort first and split the share between themselves.
    expect(devices.map((d) => d.key)).toEqual([
      'openvino:gpu',
      'openvino:npu',
      'cpu',
      'edgetpu:usb',
    ])
    expect(devices[0]!.weightSharePct).toBe(50)
    expect(devices[1]!.weightSharePct).toBe(50)
    expect(devices[2]).toMatchObject({ weightSharePct: null, exclusion: 'accelerator-preferred' })
    expect(devices[3]).toMatchObject({ weightSharePct: null, exclusion: 'disabled' })
  })

  it('flags a device sitting at its concurrent-session cap', () => {
    const rows = buildNodeLoadRows({
      nodes: [HUB],
      loads: [
        load('hub', 2, 2, [
          {
            deviceKey: 'openvino:npu',
            backend: 'openvino',
            attachedCameras: 2,
          },
        ]),
      ],
      devicesByNode: {
        hub: [device('openvino:gpu'), device('openvino:npu', { maxSessions: 2 })],
      },
    })

    const byKey = new Map(rows[0]!.devices.map((d) => [d.key, d]))
    expect(byKey.get('openvino:npu')?.atCap).toBe(true)
    expect(byKey.get('openvino:gpu')?.atCap).toBe(false)
  })

  it('reports the whole node as running on the runner default pool when nothing is eligible', () => {
    const rows = buildNodeLoadRows({
      nodes: [HUB],
      loads: [load('hub', 1, 1)],
      devicesByNode: {
        hub: [device('cpu', { format: 'onnx', enabled: false, exclusion: 'disabled' })],
      },
    })

    expect(rows[0]!.eligibleDeviceCount).toBe(0)
    expect(rows[0]!.devices.every((d) => d.weightSharePct === null)).toBe(true)
  })

  it('reads a device of an unreported node as unknown, never 0 sessions', () => {
    const rows = buildNodeLoadRows({
      nodes: [MAC],
      loads: [],
      devicesByNode: { mac: [device('coreml:all', { format: 'coreml' })] },
    })

    const coreml = rows[0]!.devices[0]!
    expect(coreml.sessions).toBeNull()
    expect(coreml.atCap).toBe(false)
  })

  it('reads a device as unknown while the node carries sessions no device accounts for', () => {
    // The Mac: "1/1 attached", but the runner attributed its default-pool
    // session to no device key. Which accelerator holds it is not known here,
    // so no device may claim 0 of it.
    const rows = buildNodeLoadRows({
      nodes: [MAC],
      loads: [load('mac', 1, 1)],
      devicesByNode: { mac: [device('coreml:all', { format: 'coreml', maxSessions: 1 })] },
    })

    const coreml = rows[0]!.devices[0]!
    expect(coreml.sessions).toBeNull()
    expect(coreml.atCap).toBe(false)
  })

  it('reads an absent device as a real 0 once every attached session is attributed', () => {
    const rows = buildNodeLoadRows({
      nodes: [MAC],
      loads: [
        load('mac', 1, 1, [{ deviceKey: 'coreml:all', backend: 'coreml', attachedCameras: 1 }]),
      ],
      devicesByNode: {
        mac: [device('coreml:all', { format: 'coreml' }), device('cpu', { format: 'onnx' })],
      },
    })

    const byKey = new Map(rows[0]!.devices.map((d) => [d.key, d.sessions]))
    expect(byKey.get('coreml:all')).toBe(1)
    expect(byKey.get('cpu')).toBe(0)
  })
})
