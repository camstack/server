import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_PLACEMENT_POLICY,
  DEFAULT_SHARE_SOURCE,
  parseSessionPlacementPolicy,
  parseShareSource,
  resolveEffectiveShares,
} from '../index.js'

describe('load balancing defaults', () => {
  it('places sessions by share, with automatic shares, when nothing is stored', () => {
    expect(DEFAULT_SESSION_PLACEMENT_POLICY).toBe('share')
    expect(parseSessionPlacementPolicy(undefined)).toBe('share')
    // D791: measured on the node beats the table — the default reads node
    // benchmark results, each node without them falling back to hardware.
    expect(DEFAULT_SHARE_SOURCE).toBe('benchmark')
    expect(parseShareSource(undefined)).toBe('benchmark')
    expect(parseShareSource('garbage')).toBe('benchmark')
    expect(parseShareSource('hardware')).toBe('hardware')
    expect(parseShareSource('manual')).toBe('manual')
    expect(parseShareSource('benchmark')).toBe('benchmark')
  })

  it('a stored D750 `auto` reads as `hardware` — what it computed', () => {
    expect(parseShareSource('auto')).toBe('hardware')
    expect(parseSessionPlacementPolicy('least-loaded')).toBe('least-loaded')
  })
})

const NODES = ['hub', 'agent-a', 'mac']

describe('resolveEffectiveShares', () => {
  it('hardware: uses the capacity shares, not the stored sliders, and says per node where they came from', () => {
    const view = resolveEffectiveShares({
      source: 'hardware',
      nodeIds: NODES,
      stored: { nodes: { hub: 20, 'agent-a': 10, mac: 70 }, devices: {} },
      auto: { nodes: { hub: 46, 'agent-a': 9, mac: 45 }, devices: {} },
      autoCapacity: {
        hub: { source: 'hardware', fallback: null },
        mac: { source: 'hardware', fallback: 'no-benchmark-results' },
      },
      eligibleNodes: NODES,
      eligibleDevices: {},
    })
    expect(view.source).toBe('hardware')
    expect(view.nodes.find((n) => n.nodeId === 'mac')?.capacityFallback).toBe(
      'no-benchmark-results',
    )
    expect(view.nodeWeights).toEqual({ hub: 46, 'agent-a': 9, mac: 45 })
    expect(view.nodes.find((n) => n.nodeId === 'hub')?.effectivePct).toBe(46)
  })

  it('auto without a computed answer yet falls back to the stored sliders and says so', () => {
    const view = resolveEffectiveShares({
      source: 'hardware',
      nodeIds: NODES,
      stored: { nodes: { hub: 20, 'agent-a': 10, mac: 70 }, devices: {} },
      auto: null,
      eligibleNodes: NODES,
      eligibleDevices: {},
    })
    expect(view.autoPending).toBe(true)
    expect(view.nodeWeights).toEqual({ hub: 20, 'agent-a': 10, mac: 70 })
  })

  it('manual: an offline node gives its share to the others in proportion, stored values untouched', () => {
    const stored = { nodes: { hub: 20, 'agent-a': 10, mac: 70 }, devices: {} }
    const view = resolveEffectiveShares({
      source: 'manual',
      nodeIds: NODES,
      stored,
      auto: null,
      eligibleNodes: ['hub', 'mac'],
      eligibleDevices: {},
    })
    const byId = Object.fromEntries(view.nodes.map((n) => [n.nodeId, n]))
    expect(byId['agent-a']?.eligible).toBe(false)
    expect(byId['agent-a']?.effectivePct).toBe(0)
    expect(byId['agent-a']?.configuredPct).toBe(10)
    expect(byId.hub?.effectivePct).toBeCloseTo(22.2, 1)
    expect(byId.mac?.effectivePct).toBeCloseTo(77.8, 1)
    expect(stored.nodes['agent-a']).toBe(10)
  })

  it('a disabled device gives its share to the node’s other devices', () => {
    const view = resolveEffectiveShares({
      source: 'hardware',
      nodeIds: ['hub'],
      stored: { nodes: {}, devices: {} },
      auto: {
        nodes: { hub: 100 },
        devices: { hub: { 'openvino:npu': 54, 'openvino:gpu': 46 } },
      },
      eligibleNodes: ['hub'],
      eligibleDevices: { hub: ['openvino:npu'] },
    })
    const hub = view.nodes[0]!
    expect(hub.devices.find((d) => d.deviceKey === 'openvino:npu')?.effectivePct).toBe(100)
    expect(hub.devices.find((d) => d.deviceKey === 'openvino:gpu')?.effectivePct).toBe(0)
    expect(view.deviceWeights.hub).toEqual({ 'openvino:npu': 54, 'openvino:gpu': 46 })
  })

  it('a node with no share anywhere still gets an equal default weight', () => {
    const view = resolveEffectiveShares({
      source: 'manual',
      nodeIds: ['a', 'b'],
      stored: { nodes: {}, devices: {} },
      auto: null,
      eligibleNodes: ['a', 'b'],
      eligibleDevices: {},
    })
    expect(view.nodes.map((n) => n.effectivePct)).toEqual([50, 50])
  })
})

describe('resolveEffectiveShares — a device the node no longer has (D919)', () => {
  // The hub's Coral moved to another node; its stored weight survives in the
  // node's settings. It must get no share at all: the devices the node HAS
  // split 100%, and the election's weights never name it.
  const stored = {
    nodes: { hub: 1 },
    devices: { hub: { 'edgetpu:usb': 1, 'openvino:gpu': 7, cpu: 2 } },
  }
  for (const source of ['manual', 'hardware'] as const) {
    it(`${source}: an absent device has no set share and no election weight`, () => {
      const view = resolveEffectiveShares({
        source,
        nodeIds: ['hub'],
        stored,
        auto: source === 'manual' ? null : stored,
        eligibleNodes: ['hub'],
        eligibleDevices: { hub: ['openvino:gpu'] },
        absentDevices: { hub: ['edgetpu:usb'] },
      })
      const devices = view.nodes[0]!.devices
      // A disabled device (cpu here, not eligible) keeps its set share.
      expect(devices.map((d) => [d.deviceKey, d.configuredPct, d.effectivePct])).toEqual([
        ['cpu', 22.2, 0],
        ['openvino:gpu', 77.8, 100],
      ])
      expect(Object.keys(view.deviceWeights.hub ?? {})).toEqual(['cpu', 'openvino:gpu'])
    })
  }
})
