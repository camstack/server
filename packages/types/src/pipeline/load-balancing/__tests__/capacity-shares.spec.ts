/**
 * D755 — automatic shares from capacity, with no load input: `hardware` from
 * the latency table at the Auto tune models, `benchmark` from measured
 * results, falling back to `hardware` per node and saying so.
 */
import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../../../interfaces/platform.js'
import type { ModelFormat } from '../../../types/models.js'
import { type AutoTuneNodeInput, recommendNode } from '../../auto-tune/recommend.js'
import {
  computeCapacityShares,
  type NodeMeasuredCapacity,
  toPercentShares,
} from '../capacity-shares.js'

function hw(cpuModel: string, arch: HardwareInfo['arch']): HardwareInfo {
  return {
    platform: arch === 'arm64' ? 'darwin' : 'linux',
    arch,
    cpuModel,
    cpuCores: 8,
    totalRAM_MB: 16384,
    availableRAM_MB: 8192,
    gpu: null,
    npu: null,
  }
}

const FORMATS: Readonly<Record<string, readonly ModelFormat[]>> = Object.fromEntries(
  ['t', 's', 'm'].flatMap((tier) =>
    ['320', '640'].flatMap((res) => [
      [`yolov9${tier}-${res}`, ['onnx', 'openvino', 'coreml'] as const],
      [`yolov9${tier}-${res}-int8`, ['openvino'] as const],
    ]),
  ),
)

const NODES: readonly AutoTuneNodeInput[] = [
  {
    nodeId: 'hub',
    reachable: true,
    hardware: hw('Intel(R) Core(TM) Ultra 7 265K', 'x64'),
    devices: [
      { key: 'openvino:gpu', format: 'openvino', enabled: true, available: true },
      { key: 'openvino:npu', format: 'openvino', enabled: true, available: true },
    ],
    formatsByModel: FORMATS,
  },
  {
    nodeId: 'agent-a',
    reachable: true,
    hardware: hw('Intel(R) N100', 'x64'),
    devices: [{ key: 'openvino:gpu', format: 'openvino', enabled: true, available: true }],
    formatsByModel: FORMATS,
  },
  {
    nodeId: 'mac',
    reachable: true,
    hardware: hw('Apple M2', 'arm64'),
    devices: [{ key: 'coreml:all', format: 'coreml', enabled: true, available: true }],
    formatsByModel: FORMATS,
  },
]

const recs = NODES.map((node) => recommendNode({ node }))

function shares(
  source: 'hardware' | 'benchmark',
  measured: ReadonlyMap<string, NodeMeasuredCapacity> = new Map(),
) {
  return computeCapacityShares({
    recommendations: recs,
    source,
    measured,
    headroom: 0.4,
    cameraFps: 10,
    minSessionsPerDevice: 2,
  })
}

describe('computeCapacityShares — hardware', () => {
  it('node shares follow parallel-session capacity at the Auto tune models', () => {
    const result = shares('hardware')
    expect(result.nodes.map((n) => [n.nodeId, n.capacitySessions, n.share])).toEqual([
      ['hub', 5, 42],
      ['agent-a', 2, 17],
      ['mac', 5, 41],
    ])
    expect(result.nodes.every((n) => n.capacitySource === 'hardware')).toBe(true)
    expect(result.nodes.every((n) => n.capacityFallback === null)).toBe(true)
  })

  it('device shares inside a node follow throughput; caps are the per-device sessions', () => {
    const hub = shares('hardware').nodes.find((n) => n.nodeId === 'hub')
    expect(hub?.devices.map((d) => [d.deviceKey, d.share, d.suggestedMaxSessions])).toEqual([
      ['openvino:gpu', 46, 2],
      ['openvino:npu', 54, 3],
    ])
  })

  it('an enabled Coral earns a weight; a disabled one earns none (D912)', () => {
    const proxmox: AutoTuneNodeInput = {
      nodeId: 'agent-b',
      reachable: true,
      hardware: hw('AMD Ryzen 7 7640HS', 'x64'),
      devices: [
        { key: 'edgetpu:pci', format: 'tflite', enabled: true, available: true },
        { key: 'edgetpu:pci:1', format: 'tflite', enabled: true, available: true },
        { key: 'edgetpu:usb', format: 'tflite', enabled: false, available: true },
      ],
      formatsByModel: { ...FORMATS, 'yolov9s-320-edgetpu': ['tflite'] },
    }
    const result = computeCapacityShares({
      recommendations: [recommendNode({ node: proxmox })],
      source: 'hardware',
      measured: new Map(),
      headroom: 0.4,
      cameraFps: 10,
      minSessionsPerDevice: 2,
    })
    const node = result.nodes[0]
    expect(node?.capacitySource).toBe('hardware')
    expect(node?.devices.map((d) => [d.deviceKey, d.share > 0])).toEqual([
      ['edgetpu:pci', true],
      ['edgetpu:pci:1', true],
    ])
    expect(node?.capacitySessions).toBeGreaterThan(0)
  })

  it('a skipped node has no share and no source', () => {
    const result = computeCapacityShares({
      recommendations: [
        ...recs.slice(0, 2),
        recommendNode({ node: { ...NODES[2]!, reachable: false } }),
      ],
      source: 'hardware',
      measured: new Map(),
      headroom: 0.4,
      cameraFps: 10,
      minSessionsPerDevice: 2,
    })
    const mac = result.nodes.find((n) => n.nodeId === 'mac')
    expect(mac).toMatchObject({ share: null, skippedReason: 'node-offline', capacitySource: null })
  })
})

describe('computeCapacityShares — benchmark', () => {
  it('no results anywhere: every node falls back to hardware, and says so', () => {
    const result = shares('benchmark')
    expect(result.source).toBe('benchmark')
    expect(result.nodes.map((n) => n.share)).toEqual(shares('hardware').nodes.map((n) => n.share))
    expect(result.nodes.map((n) => [n.capacitySource, n.capacityFallback])).toEqual([
      ['hardware', 'no-benchmark-results'],
      ['hardware', 'no-benchmark-results'],
      ['hardware', 'no-benchmark-results'],
    ])
  })

  it('a node with results uses its measured sessions; the others fall back', () => {
    const measured = new Map<string, NodeMeasuredCapacity>([
      [
        'mac',
        {
          nodeId: 'mac',
          devices: [
            { deviceKey: 'coreml:all', maxSessions: 9, modelId: 'yolov9m-640', measuredAtMs: 1 },
          ],
        },
      ],
    ])
    const result = shares('benchmark', measured)
    const mac = result.nodes.find((n) => n.nodeId === 'mac')
    expect(mac).toMatchObject({
      capacitySessions: 9,
      capacitySource: 'benchmark',
      capacityFallback: null,
    })
    // hub 5 + N100 2 + Mac 9 = 16 sessions.
    expect(result.nodes.map((n) => n.share)).toEqual([31, 13, 56])
  })

  it('results for only some of a node’s devices: the whole node uses hardware', () => {
    const measured = new Map<string, NodeMeasuredCapacity>([
      [
        'hub',
        {
          nodeId: 'hub',
          devices: [
            {
              deviceKey: 'openvino:npu',
              maxSessions: 7,
              modelId:
                recs[0]?.devices.find((d) => d.deviceKey === 'openvino:npu')?.chosen?.modelId ??
                null,
              measuredAtMs: 1,
            },
          ],
        },
      ],
    ])
    const hub = shares('benchmark', measured).nodes.find((n) => n.nodeId === 'hub')
    expect(hub).toMatchObject({
      capacitySessions: 5,
      capacitySource: 'hardware',
      capacityFallback: 'partial-benchmark-results',
    })
  })
})

describe('toPercentShares', () => {
  it('sums to 100 by largest remainder', () => {
    const pct = toPercentShares(
      new Map([
        ['a', 1],
        ['b', 1],
        ['c', 1],
      ]),
    )
    expect([...pct.values()].reduce((x, y) => x + y, 0)).toBe(100)
  })
})
