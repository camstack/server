import { describe, expect, it } from 'vitest'
import {
  type NodeStressVerdict,
  planStressFailover,
  type StressFailoverCandidate,
} from '../node-stress.js'

function verdict(
  nodeId: string,
  state: NodeStressVerdict['state'],
  score: number,
): NodeStressVerdict {
  return {
    nodeId,
    state,
    changed: false,
    signals: {
      queuePressure: score,
      dropRatio: 0,
      fpsDeficit: score,
      deficitCorroborated: score > 0,
      score,
    },
    memory: { state, since: 0, pendingSince: null, pending: null },
  }
}

function candidate(over: Partial<StressFailoverCandidate> = {}): StressFailoverCandidate {
  return {
    deviceId: 102,
    nodeId: 'agent-a',
    pinned: false,
    active: true,
    configuredFps: 10,
    eligibleNodes: ['agent-a', 'hub', 'mac'],
    ...over,
  }
}

describe('stress failover under share placement (D750)', () => {
  it('targets the healthy node with the largest share deficit, not the quietest one', () => {
    const plan = planStressFailover(
      {
        verdicts: [
          verdict('agent-a', 'saturated', 0.9),
          verdict('hub', 'ok', 0.3),
          verdict('mac', 'ok', 0.05),
        ],
        candidates: [candidate()],
        history: [],
        // hub owes most: 46 % of 8 parallel = 3.68, runs 1 → deficit 2.68;
        // mac: 45 % of 8 = 3.6, runs 3 → 0.6 (the quieter node by score).
        attachedByNode: { 'agent-a': 4, hub: 1, mac: 3 },
        shares: { hub: 46, 'agent-a': 9, mac: 45 },
      },
      0,
    )
    expect(plan).toMatchObject({ kind: 'move', deviceId: 102, toNodeId: 'hub' })
  })

  it('never moves onto a stressed node, even the one that owes the most', () => {
    const plan = planStressFailover(
      {
        verdicts: [
          verdict('agent-a', 'saturated', 0.9),
          verdict('hub', 'stressed', 0.6),
          verdict('mac', 'ok', 0.1),
        ],
        candidates: [candidate()],
        history: [],
        attachedByNode: { 'agent-a': 2, hub: 0, mac: 1 },
        shares: { hub: 46, 'agent-a': 9, mac: 45 },
      },
      0,
    )
    expect(plan).toMatchObject({ kind: 'move', toNodeId: 'mac' })
  })

  it('holds — naming the camera — when no healthy node is below its share', () => {
    const plan = planStressFailover(
      {
        verdicts: [verdict('agent-a', 'saturated', 0.9), verdict('mac', 'ok', 0.1)],
        candidates: [candidate({ eligibleNodes: ['agent-a', 'mac'] })],
        history: [],
        // mac 45 / (45+9) of 6 = 5, runs 5 → deficit 0; agent-a owes nothing either.
        attachedByNode: { 'agent-a': 1, mac: 5 },
        shares: { 'agent-a': 9, mac: 45 },
      },
      0,
    )
    expect(plan).toEqual({
      kind: 'hold',
      reason: 'no-target',
      nodeId: 'agent-a',
      deviceId: 102,
    })
  })
})
