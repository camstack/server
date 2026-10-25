import type { EffectiveShares, SuggestSharesResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  benchmarkFallbackNote,
  effectiveShareNote,
  SHARE_SOURCE_OPTIONS,
  shareSliderView,
  sharesWriteFromCommit,
  sharesWriteFromSuggestion,
  stalePinText,
  suggestedCapsByNode,
} from '../load-balancing/load-balancing-view-model'

const suggestion: SuggestSharesResult = {
  headroom: 0.4,
  source: 'hardware',
  cameraFps: 10,
  minSessionsPerDevice: 2,
  nodes: [
    {
      nodeId: 'hub',
      share: 50,
      capacitySessions: 17,
      skippedReason: null,
      capacitySource: 'hardware',
      capacityFallback: null,
      devices: [
        {
          deviceKey: 'openvino:npu',
          share: 56,
          modelId: 'm',
          fps: 165,
          measured: true,
          suggestedMaxSessions: 9,
        },
        {
          deviceKey: 'openvino:gpu',
          share: 44,
          modelId: 'm',
          fps: 127,
          measured: true,
          suggestedMaxSessions: 7,
        },
      ],
    },
    {
      nodeId: 'agent-a',
      share: null,
      capacitySessions: 0,
      skippedReason: 'node-offline',
      capacitySource: null,
      capacityFallback: null,
      devices: [],
    },
  ],
}

describe('load balancing view model', () => {
  it('a slider commit becomes ONE share write; a 0 share is stored as the smallest positive share', () => {
    expect(
      sharesWriteFromCommit([
        { nodeId: 'mac', weight: 70 },
        { nodeId: 'n100', weight: 0 },
      ]),
    ).toEqual({ nodes: { mac: 70, n100: 1 }, devices: {} })
  })

  it('applying a suggestion writes node and device shares, skipping skipped nodes', () => {
    expect(sharesWriteFromSuggestion(suggestion)).toEqual({
      nodes: { hub: 50 },
      devices: { hub: { 'openvino:npu': 56, 'openvino:gpu': 44 } },
    })
  })

  it('exposes the advisory caps per node and device', () => {
    expect(suggestedCapsByNode(suggestion)).toEqual({
      hub: { 'openvino:npu': 9, 'openvino:gpu': 7 },
      'agent-a': {},
    })
  })

  it('names why a pin is stale', () => {
    expect(stalePinText({ deviceId: 3836, deviceKey: 'edgetpu:usb', reason: 'disabled' })).toBe(
      'edgetpu:usb is not enabled on any node — sessions ignore this pin',
    )
    expect(stalePinText({ deviceId: 1, deviceKey: 'x:y', reason: 'absent' })).toBe(
      'no node offers x:y — sessions ignore this pin',
    )
  })
})

describe('share source in the sliders (D750, D755)', () => {
  const effective: EffectiveShares = {
    source: 'hardware',
    policy: 'share',
    autoPending: false,
    computedAt: 1_000,
    trigger: 'node-offline:agent-a',
    nodes: [
      {
        nodeId: 'hub',
        eligible: true,
        configuredPct: 46,
        effectivePct: 51.1,
        capacitySource: 'hardware',
        capacityFallback: null,
        devices: [],
      },
      {
        nodeId: 'agent-a',
        eligible: false,
        configuredPct: 9,
        effectivePct: 0,
        capacitySource: 'hardware',
        capacityFallback: null,
        devices: [],
      },
      {
        nodeId: 'mac',
        eligible: true,
        configuredPct: 45,
        effectivePct: 48.9,
        capacitySource: 'hardware',
        capacityFallback: null,
        devices: [
          { deviceKey: 'coreml:all', eligible: true, configuredPct: 100, effectivePct: 100 },
        ],
      },
    ],
    nodeWeights: { hub: 46, 'agent-a': 9, mac: 45 },
    deviceWeights: {},
  }
  const stored = [
    { id: 'hub', name: 'Hub', weight: 20 },
    { id: 'agent-a', name: 'N100', weight: 10 },
    { id: 'mac', name: 'Mac', weight: 70 },
  ]

  it('automatic: the sliders show the computed shares and cannot be dragged', () => {
    const view = shareSliderView(stored, effective)
    expect(view.readOnly).toBe(true)
    expect(view.nodes.map((n) => n.weight)).toEqual([46, 9, 45])
  })

  it('manual: the stored sliders, editable', () => {
    const view = shareSliderView(stored, { ...effective, source: 'manual' })
    expect(view.readOnly).toBe(false)
    expect(view.nodes.map((n) => n.weight)).toEqual([20, 10, 70])
  })

  it('names what an offline node gave away, and to whom', () => {
    expect(effectiveShareNote(effective, (id) => id)).toBe(
      'agent-a cannot take sessions — its share goes to the others: hub 51%, mac 49%',
    )
    expect(
      effectiveShareNote(
        { ...effective, nodes: effective.nodes.map((n) => ({ ...n, eligible: true })) },
        (id) => id,
      ),
    ).toBeNull()
  })

  it('before any data, the stored sliders stay editable', () => {
    expect(shareSliderView(stored, undefined).readOnly).toBe(false)
  })

  it('benchmark is automatic too: computed shares, read-only', () => {
    expect(shareSliderView(stored, { ...effective, source: 'benchmark' }).readOnly).toBe(true)
  })

  it('under benchmark, names every node that fell back to hardware and why', () => {
    const view: EffectiveShares = {
      ...effective,
      source: 'benchmark',
      nodes: effective.nodes.map((n) =>
        n.nodeId === 'mac'
          ? n
          : {
              ...n,
              capacitySource: 'hardware' as const,
              capacityFallback: 'no-benchmark-results' as const,
            },
      ),
    }
    expect(benchmarkFallbackNote(view, (id) => id)).toBe(
      'hub: no benchmark results yet — sized from hardware · agent-a: no benchmark results yet — sized from hardware',
    )
    expect(benchmarkFallbackNote(effective, (id) => id)).toBeNull()
  })

  it('offers the three sources in order: Hardware, Benchmark, Manual', () => {
    expect(SHARE_SOURCE_OPTIONS.map((o) => o.label)).toEqual(['Hardware', 'Benchmark', 'Manual'])
  })
})
