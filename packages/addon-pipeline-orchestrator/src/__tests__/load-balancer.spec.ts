import type { RunnerLocalLoad } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { balance, capacityImprovement, computeCapacityScore } from '../load-balancer.js'

function load(over: Partial<RunnerLocalLoad> = {}): RunnerLocalLoad {
  return {
    nodeId: 'node-a',
    attachedCameras: 0,
    activeCameras: 0,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    queueDepthTotal: 0,
    devices: [],
    hardware: { hasGpu: false },
    ...over,
  }
}

describe('computeCapacityScore', () => {
  it('is zero for an idle runner', () => {
    expect(computeCapacityScore(load())).toBe(0)
  })

  it('penalises queue depth linearly', () => {
    expect(computeCapacityScore(load({ queueDepthTotal: 5 }))).toBe(5)
  })

  it('counts every attached camera as committed standing load', () => {
    // The primary signal is committed load (attachments), NOT current inference
    // activity — this is what makes the balancer honest about steady-state load.
    expect(computeCapacityScore(load({ attachedCameras: 3 }))).toBe(3)
  })

  it('counts IDLE on-motion cameras (the idle-blind fix)', () => {
    // A node carrying 20 attached on-motion cameras that are all idle
    // (avgInferenceFps 0) must NOT score as an empty node — the old
    // `attachedCameras * avgInferenceFps` product made it score 0, piling more
    // cameras onto an already-committed node until maxCameras bit.
    expect(computeCapacityScore(load({ attachedCameras: 20, avgInferenceFps: 0 }))).toBe(20)
  })

  it('ignores current inference activity (avgInferenceFps) entirely', () => {
    // Two nodes with the same attachments score the same regardless of how
    // busy their sessions happen to be right now.
    expect(computeCapacityScore(load({ attachedCameras: 2, avgInferenceFps: 30 }))).toBe(
      computeCapacityScore(load({ attachedCameras: 2, avgInferenceFps: 0 })),
    )
  })

  it('sums committed cameras with the queue backlog (real-time pressure)', () => {
    expect(computeCapacityScore(load({ attachedCameras: 2, queueDepthTotal: 3 }))).toBe(5)
  })

  it('clamps negative values from broken runners to zero', () => {
    expect(
      computeCapacityScore(
        load({ attachedCameras: -1, avgInferenceFps: -1, queueDepthTotal: -10 }),
      ),
    ).toBe(0)
  })
})

describe('capacityImprovement (auto-rebalance hysteresis)', () => {
  it('is the weighted-score gap: positive when target is less loaded', () => {
    expect(
      capacityImprovement(
        load({ nodeId: 'a', attachedCameras: 3 }),
        load({ nodeId: 'b', attachedCameras: 1 }),
        undefined,
      ),
    ).toBe(2)
  })

  it('is zero for equally-loaded nodes', () => {
    expect(
      capacityImprovement(
        load({ nodeId: 'a', attachedCameras: 2 }),
        load({ nodeId: 'b', attachedCameras: 2 }),
        undefined,
      ),
    ).toBe(0)
  })

  it('a 1-camera gap is below the default 1.5 margin (no churn)', () => {
    const gap = capacityImprovement(
      load({ nodeId: 'a', attachedCameras: 2 }),
      load({ nodeId: 'b', attachedCameras: 1 }),
      undefined,
    )
    expect(gap).toBeLessThan(1.5)
  })

  it('scales by weight — a heavy node carrying its fair share is balanced', () => {
    // 6 cams on weight-6 (weighted 1.0) vs 1 cam on weight-1 (weighted 1.0) → balanced.
    expect(
      capacityImprovement(
        load({ nodeId: 'heavy', attachedCameras: 6 }),
        load({ nodeId: 'light', attachedCameras: 1 }),
        { heavy: 6, light: 1 },
      ),
    ).toBe(0)
  })
})

describe('balance — L1 manual affinity', () => {
  it('returns the preferred agent when it is online', () => {
    const decision = balance({
      nodes: [load({ nodeId: 'a' }), load({ nodeId: 'b' })],
      preferredAgent: 'b',
    })
    expect(decision).toEqual({ kind: 'assigned', agentNodeId: 'b', reason: 'manual', score: 0 })
  })

  it('falls through to L2 when the preferred agent is offline', () => {
    const decision = balance({
      nodes: [load({ nodeId: 'a' })],
      preferredAgent: 'gone',
    })
    if (!decision || decision.kind !== 'assigned') throw new Error('expected assigned decision')
    expect(decision.agentNodeId).toBe('a')
    expect(decision.reason).toBe('capacity')
  })

  it('ignores empty preferredAgent strings', () => {
    const decision = balance({
      nodes: [load({ nodeId: 'a' })],
      preferredAgent: '',
    })
    if (!decision || decision.kind !== 'assigned') throw new Error('expected assigned decision')
    expect(decision.reason).toBe('capacity')
  })
})

describe('balance — L2 capacity', () => {
  it('picks the least-loaded runner', () => {
    const decision = balance({
      nodes: [
        load({ nodeId: 'busy', attachedCameras: 4, avgInferenceFps: 5 }),
        load({ nodeId: 'idle' }),
      ],
    })
    expect(decision).toEqual({
      kind: 'assigned',
      agentNodeId: 'idle',
      reason: 'capacity',
      score: 0,
    })
  })

  it('returns null when no runners are online', () => {
    expect(balance({ nodes: [] })).toBeNull()
  })

  it('skips runners with empty node ids (defensive)', () => {
    const decision = balance({
      nodes: [load({ nodeId: '' }), load({ nodeId: 'real' })],
    })
    if (!decision || decision.kind !== 'assigned') throw new Error('expected assigned decision')
    expect(decision.agentNodeId).toBe('real')
  })

  it('treats queue depth as a tie-breaker when camera counts match', () => {
    const decision = balance({
      nodes: [
        load({ nodeId: 'a', attachedCameras: 2, avgInferenceFps: 3, queueDepthTotal: 5 }),
        load({ nodeId: 'b', attachedCameras: 2, avgInferenceFps: 3, queueDepthTotal: 0 }),
      ],
    })
    if (!decision || decision.kind !== 'assigned') throw new Error('expected assigned decision')
    expect(decision.agentNodeId).toBe('b')
  })
})

// Helper used by the maxCameras suite — mirrors the brief fixture factory.
const node = (nodeId: string, attachedCameras: number): RunnerLocalLoad => ({
  nodeId,
  attachedCameras,
  activeCameras: attachedCameras,
  avgInferenceFps: 5,
  avgInferenceTimeMs: 50,
  queueDepthTotal: 0,
  devices: [],
  hardware: {} as never,
})

describe('balance — maxCameras cap', () => {
  it('skips a node at its cap and picks an eligible one', () => {
    const d = balance({
      nodes: [node('hub', 10), node('little', 1)],
      nodeCaps: { hub: 10, little: null },
    })
    expect(d).toEqual({
      kind: 'assigned',
      agentNodeId: 'little',
      reason: 'capacity',
      score: expect.any(Number),
    })
  })

  it('returns pending when every node is at/over cap', () => {
    const d = balance({ nodes: [node('hub', 10)], nodeCaps: { hub: 10 } })
    expect(d).toEqual({ kind: 'pending', reason: 'over-cap' })
  })

  it('a pin to an at-cap node yields pending (pins count toward the cap)', () => {
    const d = balance({
      nodes: [node('hub', 5), node('little', 3)],
      nodeCaps: { little: 3 },
      preferredAgent: 'little',
    })
    expect(d).toEqual({ kind: 'pending', reason: 'over-cap' })
  })

  it('honors a pin when the pinned node is under cap', () => {
    const d = balance({
      nodes: [node('hub', 5), node('little', 2)],
      nodeCaps: { little: 5 },
      preferredAgent: 'little',
    })
    expect(d).toEqual({
      kind: 'assigned',
      agentNodeId: 'little',
      reason: 'manual',
      score: expect.any(Number),
    })
  })

  it('unlimited (no cap entry) behaves as before', () => {
    const d = balance({ nodes: [node('hub', 100)] })
    expect(d).toEqual({
      kind: 'assigned',
      agentNodeId: 'hub',
      reason: 'capacity',
      score: expect.any(Number),
    })
  })

  it('returns null when no nodes are online', () => {
    expect(balance({ nodes: [] })).toBeNull()
  })
})

describe('balance — frame-source eligibility', () => {
  it('never assigns to a node outside eligibleNodes even when least loaded', () => {
    const decision = balance({
      nodes: [load({ nodeId: 'hub', queueDepthTotal: 50 }), load({ nodeId: 'agent' })],
      eligibleNodes: ['hub'],
    })
    expect(decision).toEqual({
      kind: 'assigned',
      agentNodeId: 'hub',
      reason: 'capacity',
      score: 50,
    })
  })
  it('a pin to an online but frames-unreachable node returns pending(no-frame-source), never falls through', () => {
    const decision = balance({
      nodes: [load({ nodeId: 'hub' }), load({ nodeId: 'agent' })],
      preferredAgent: 'agent',
      eligibleNodes: ['hub'],
    })
    expect(decision).toEqual({ kind: 'pending', reason: 'no-frame-source' })
  })
  it('all online nodes ineligible → pending(no-frame-source)', () => {
    expect(balance({ nodes: [load({ nodeId: 'agent' })], eligibleNodes: ['hub'] })).toEqual({
      kind: 'pending',
      reason: 'no-frame-source',
    })
  })
  it('absent eligibleNodes preserves legacy behaviour', () => {
    expect(balance({ nodes: [load({ nodeId: 'agent' })] })?.kind).toBe('assigned')
  })
  it('eligibility composes with nodeCaps: eligible-but-over-cap → pending(over-cap)', () => {
    const decision = balance({
      nodes: [load({ nodeId: 'hub', attachedCameras: 2 }), load({ nodeId: 'agent' })],
      eligibleNodes: ['hub'],
      nodeCaps: { hub: 2 },
    })
    expect(decision).toEqual({ kind: 'pending', reason: 'over-cap' })
  })
})

describe('balance — per-node weight (proportional detection share)', () => {
  it('prefers the higher-weight node when raw loads are equal', () => {
    const d = balance({
      nodes: [
        load({ nodeId: 'mac', attachedCameras: 1, avgInferenceFps: 5 }),
        load({ nodeId: 'hub', attachedCameras: 1, avgInferenceFps: 5 }),
      ],
      weights: { mac: 60, hub: 30 },
    })
    expect(d?.kind).toBe('assigned')
    expect(d && d.kind === 'assigned' && d.agentNodeId).toBe('mac')
  })

  it('distributes unpinned cameras proportionally to weight (60/30/10 → ~6/3/1 of 10)', () => {
    const counts: Record<string, number> = { mac: 0, hub: 0, n100: 0 }
    const weights = { mac: 60, hub: 30, n100: 10 }
    for (let i = 0; i < 10; i++) {
      const d = balance({
        nodes: [
          load({ nodeId: 'mac', attachedCameras: counts.mac, avgInferenceFps: 5 }),
          load({ nodeId: 'hub', attachedCameras: counts.hub, avgInferenceFps: 5 }),
          load({ nodeId: 'n100', attachedCameras: counts.n100, avgInferenceFps: 5 }),
        ],
        weights,
      })
      expect(d?.kind).toBe('assigned')
      if (d && d.kind === 'assigned') counts[d.agentNodeId]!++
    }
    // Proportional to 60/30/10 over 10 cameras.
    expect(counts.mac).toBe(6)
    expect(counts.hub).toBe(3)
    expect(counts.n100).toBe(1)
  })

  it('ceiling (maxCameras) clamps on top of weight — a heavy node at cap is skipped', () => {
    const d = balance({
      nodes: [
        load({ nodeId: 'mac', attachedCameras: 2, avgInferenceFps: 5 }),
        load({ nodeId: 'hub', attachedCameras: 5, avgInferenceFps: 5 }),
      ],
      weights: { mac: 60, hub: 30 },
      nodeCaps: { mac: 2 }, // mac at ceiling despite high weight
    })
    expect(d && d.kind === 'assigned' && d.agentNodeId).toBe('hub')
  })

  it('absent weights = equal (back-compat, score-only selection)', () => {
    const d = balance({
      nodes: [
        load({ nodeId: 'a', attachedCameras: 3, avgInferenceFps: 5 }),
        load({ nodeId: 'b', attachedCameras: 1, avgInferenceFps: 5 }),
      ],
    })
    expect(d && d.kind === 'assigned' && d.agentNodeId).toBe('b') // lower raw load wins
  })
})
