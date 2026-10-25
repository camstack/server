/**
 * `node-stress.ts` — the signal, the hysteresis, and the anti-flap bounds.
 *
 * The tests that matter here are the NEGATIVE ones. A stress detector that
 * fires is easy; the ones that cost real time are the detector that fires on a
 * starved camera source, and the failover that walks a camera around the
 * cluster forever. Both have a test below that fails if the guard is removed.
 */
import { describe, expect, it } from 'vitest'
import {
  type CameraStressSample,
  DEFAULT_NODE_STRESS_THRESHOLDS,
  DEFAULT_STRESS_FAILOVER_GUARDS,
  evaluateNodeStress,
  initialNodeStressMemory,
  type NodeStressMemory,
  type NodeStressVerdict,
  planStressFailover,
  reduceNodeStress,
  type StressFailoverCandidate,
  type StressFailoverHistoryEntry,
  stepNodeStress,
} from '../node-stress.js'

const T = DEFAULT_NODE_STRESS_THRESHOLDS
const G = DEFAULT_STRESS_FAILOVER_GUARDS

function sample(over: Partial<CameraStressSample> = {}): CameraStressSample {
  return {
    deviceId: 101,
    active: true,
    configuredFps: 5,
    actualFps: 5,
    queueDepth: 0,
    droppedFrames: 0,
    previousDroppedFrames: 0,
    sinceMs: 10_000,
    ...over,
  }
}

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
    deviceId: 101,
    nodeId: 'macmini',
    pinned: false,
    active: true,
    configuredFps: 5,
    eligibleNodes: ['macmini', 'hub'],
    ...over,
  }
}

// ── The signal ────────────────────────────────────────────────────────

describe('reduceNodeStress', () => {
  it('an idle fleet scores 0 — an on-motion camera between events is not evidence', () => {
    const signals = reduceNodeStress([
      sample({ deviceId: 101, active: false, actualFps: 0 }),
      sample({ deviceId: 102, active: false, actualFps: 0 }),
    ])
    expect(signals.score).toBe(0)
    expect(signals.fpsDeficit).toBe(0)
  })

  it('a starved SOURCE does not read as node stress — the corroboration rule', () => {
    // 2 of 5 fps delivered, but nothing queued and nothing dropped: the camera
    // is not producing, the node is not behind. Without this rule the planner
    // would tour this camera around the cluster forever.
    const signals = reduceNodeStress([sample({ actualFps: 2, queueDepth: 0 })])
    expect(signals.fpsDeficit).toBeCloseTo(0.6, 5)
    expect(signals.deficitCorroborated).toBe(false)
    expect(signals.score).toBe(0)
  })

  it('the same deficit WITH drops is stress, and the deficit then drives the score', () => {
    const signals = reduceNodeStress([
      sample({ actualFps: 2, droppedFrames: 10, previousDroppedFrames: 9, sinceMs: 10_000 }),
    ])
    expect(signals.deficitCorroborated).toBe(true)
    // dropRatio = 0.1 drop/s ÷ 5 demanded = 0.02; the deficit is the max.
    expect(signals.score).toBeCloseTo(0.6, 5)
  })

  it('queue depth alone saturates the score', () => {
    const signals = reduceNodeStress([
      sample({ queueDepth: 4 }),
      sample({ deviceId: 102, queueDepth: 4 }),
    ])
    expect(signals.queuePressure).toBe(1)
    expect(signals.score).toBe(1)
  })

  it('a dropped-frame counter that went BACKWARDS is a restart, not a spike', () => {
    const signals = reduceNodeStress([sample({ droppedFrames: 3, previousDroppedFrames: 900 })])
    expect(signals.dropRatio).toBe(0)
    expect(signals.score).toBe(0)
  })

  it('the composite is a MAX — two half signals never fake a full one', () => {
    const signals = reduceNodeStress([
      sample({
        queueDepth: 2, // pressure 0.5
        actualFps: 2.5, // deficit 0.5
      }),
    ])
    expect(signals.score).toBeCloseTo(0.5, 5)
  })
})

// ── The hysteresis ────────────────────────────────────────────────────

describe('stepNodeStress', () => {
  it('a node cannot jump ok → saturated; it serves the stressed dwell first', () => {
    let m: NodeStressMemory = initialNodeStressMemory(0)
    m = stepNodeStress(m, 1, 0)
    expect(m.state).toBe('ok')
    m = stepNodeStress(m, 1, T.enterDwellMs)
    expect(m.state).toBe('stressed')
    // Still stressed the instant it arrived — the saturate dwell starts now.
    m = stepNodeStress(m, 1, T.enterDwellMs)
    expect(m.state).toBe('stressed')
    m = stepNodeStress(m, 1, T.enterDwellMs + T.saturateDwellMs)
    expect(m.state).toBe('saturated')
  })

  it('one disagreeing sample resets the dwell clock completely', () => {
    let m: NodeStressMemory = initialNodeStressMemory(0)
    m = stepNodeStress(m, 0.9, 0)
    m = stepNodeStress(m, 0.9, T.enterDwellMs - 1_000)
    expect(m.state).toBe('ok')
    // One quiet sample — the node was not continuously stressed.
    m = stepNodeStress(m, 0.1, T.enterDwellMs - 500)
    m = stepNodeStress(m, 0.9, T.enterDwellMs + 1_000)
    expect(m.state).toBe('ok')
    expect(m.pendingSince).toBe(T.enterDwellMs + 1_000)
  })

  it('the middle band keeps a node where it is — this IS the hysteresis', () => {
    let m: NodeStressMemory = { state: 'saturated', since: 0, pendingSince: null, pending: null }
    // Between exit (0.35) and enter (0.60): better, but not convincingly.
    for (let t = 0; t <= T.exitDwellMs * 3; t += 10_000) m = stepNodeStress(m, 0.5, t)
    expect(m.state).toBe('saturated')
  })

  it('leaving takes the LONG dwell, and one relapse restarts it', () => {
    let m: NodeStressMemory = { state: 'saturated', since: 0, pendingSince: null, pending: null }
    m = stepNodeStress(m, 0.1, 0)
    m = stepNodeStress(m, 0.1, T.enterDwellMs * 2)
    expect(m.state).toBe('saturated')
    m = stepNodeStress(m, 0.9, T.exitDwellMs - 1_000)
    m = stepNodeStress(m, 0.1, T.exitDwellMs)
    expect(m.state).toBe('saturated')
    m = stepNodeStress(m, 0.1, T.exitDwellMs * 2 + 1)
    expect(m.state).toBe('ok')
  })
})

describe('evaluateNodeStress', () => {
  it('a node missing from this tick keeps its memory — a failed read is not a recovery', () => {
    const memories = new Map<string, NodeStressMemory>([
      ['macmini', { state: 'saturated', since: 0, pendingSince: null, pending: null }],
    ])
    const out = evaluateNodeStress(
      memories,
      [{ nodeId: 'hub', signals: reduceNodeStress([]) }],
      1_000,
    )
    expect(out.map((v) => v.nodeId)).toEqual(['hub'])
    expect(memories.get('macmini')?.state).toBe('saturated')
  })

  it('reports `changed` only on the tick the state actually flips', () => {
    const memories = new Map<string, NodeStressMemory>([
      ['macmini', { state: 'ok', since: 0, pendingSince: 0, pending: 'stressed' }],
    ])
    const input = [{ nodeId: 'macmini', signals: reduceNodeStress([sample({ queueDepth: 4 })]) }]
    expect(evaluateNodeStress(memories, input, T.enterDwellMs - 1)[0]?.changed).toBe(false)
    const flipped = evaluateNodeStress(memories, input, T.enterDwellMs)[0]
    expect(flipped?.changed).toBe(true)
    expect(flipped?.state).toBe('stressed')
  })
})

// ── The action, and the bounds on it ──────────────────────────────────

describe('planStressFailover', () => {
  const attached = { macmini: 4, hub: 1 }

  it('holds when nothing is saturated', () => {
    const plan = planStressFailover(
      {
        verdicts: [verdict('macmini', 'stressed', 0.7), verdict('hub', 'ok', 0.1)],
        candidates: [candidate()],
        history: [],
        attachedByNode: attached,
      },
      0,
    )
    expect(plan).toEqual({ kind: 'hold', reason: 'no-saturated-node' })
  })

  it('moves the most expensive movable camera to the quietest ok node', () => {
    const plan = planStressFailover(
      {
        verdicts: [
          verdict('macmini', 'saturated', 0.9),
          verdict('hub', 'ok', 0.2),
          verdict('agent-a', 'ok', 0.05),
        ],
        candidates: [
          candidate({ deviceId: 101, configuredFps: 5 }),
          candidate({
            deviceId: 102,
            configuredFps: 10,
            eligibleNodes: ['macmini', 'hub', 'agent-a'],
          }),
        ],
        history: [],
        attachedByNode: { macmini: 4, hub: 1, 'agent-a': 1 },
      },
      0,
    )
    expect(plan).toMatchObject({ kind: 'move', deviceId: 102, toNodeId: 'agent-a' })
  })

  it('never targets a node that is merely LESS bad — a stressed target is refused', () => {
    const plan = planStressFailover(
      {
        verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'stressed', 0.65)],
        candidates: [candidate()],
        history: [],
        attachedByNode: attached,
      },
      0,
    )
    expect(plan).toEqual({ kind: 'hold', reason: 'no-target', nodeId: 'macmini' })
  })

  it('never moves a pinned camera, and never an idle one', () => {
    const plan = planStressFailover(
      {
        verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'ok', 0.1)],
        candidates: [
          candidate({ deviceId: 101, pinned: true }),
          candidate({ deviceId: 102, active: false }),
        ],
        history: [],
        attachedByNode: attached,
      },
      0,
    )
    expect(plan).toEqual({ kind: 'hold', reason: 'no-movable-camera', nodeId: 'macmini' })
  })

  it('respects the frame-source constraint', () => {
    const plan = planStressFailover(
      {
        verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'ok', 0.1)],
        candidates: [candidate({ eligibleNodes: ['macmini'] })],
        history: [],
        attachedByNode: attached,
      },
      0,
    )
    expect(plan).toEqual({ kind: 'hold', reason: 'no-target', nodeId: 'macmini' })
  })

  it('respects the node ceiling', () => {
    const plan = planStressFailover(
      {
        verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'ok', 0.1)],
        candidates: [candidate()],
        history: [],
        nodeCaps: { hub: 1 },
        attachedByNode: attached,
      },
      0,
    )
    expect(plan).toEqual({ kind: 'hold', reason: 'no-target', nodeId: 'macmini' })
  })

  it('refuses a target that already carries as much as the source', () => {
    const plan = planStressFailover(
      {
        verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'ok', 0.1)],
        candidates: [candidate()],
        history: [],
        attachedByNode: { macmini: 2, hub: 2 },
      },
      0,
    )
    expect(plan).toEqual({ kind: 'hold', reason: 'no-target', nodeId: 'macmini' })
  })

  // ── the two guards that make this better than nothing ──

  it('THE PING-PONG GUARD: a camera never returns to the node it was taken off', () => {
    const history: readonly StressFailoverHistoryEntry[] = [
      { deviceId: 101, fromNodeId: 'hub', at: 0 },
    ]
    // 101 was moved OFF the hub. The hub is now the only ok node and macmini is
    // saturated — the naive planner would send it straight back.
    const now = G.deviceCooldownMs + 1_000 // past its own cooldown, inside the ban
    const plan = planStressFailover(
      {
        verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'ok', 0.1)],
        candidates: [candidate({ deviceId: 101 })],
        history,
        attachedByNode: attached,
      },
      now,
    )
    expect(plan).toEqual({ kind: 'hold', reason: 'no-target', nodeId: 'macmini' })

    // Once the ban expires the move is allowed again.
    const later = planStressFailover(
      {
        verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'ok', 0.1)],
        candidates: [candidate({ deviceId: 101 })],
        history,
        attachedByNode: attached,
      },
      G.returnBanMs + 1,
    )
    expect(later).toMatchObject({ kind: 'move', deviceId: 101, toNodeId: 'hub' })
  })

  it('a device inside its own cooldown is not moved again', () => {
    const plan = planStressFailover(
      {
        verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'ok', 0.1)],
        candidates: [candidate({ deviceId: 101 })],
        history: [{ deviceId: 101, fromNodeId: 'agent-a', at: 0 }],
        attachedByNode: attached,
      },
      G.deviceCooldownMs - 1,
    )
    expect(plan).toEqual({ kind: 'hold', reason: 'no-movable-camera', nodeId: 'macmini' })
  })

  it('the cluster-wide rate bound stops the churn rather than looping', () => {
    const history: readonly StressFailoverHistoryEntry[] = Array.from(
      { length: G.maxMovesPerWindow },
      (_unused, i) => ({ deviceId: 900 + i, fromNodeId: 'hub', at: i * 1_000 }),
    )
    const plan = planStressFailover(
      {
        verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'ok', 0.1)],
        candidates: [candidate()],
        history,
        attachedByNode: attached,
      },
      10_000,
    )
    expect(plan).toEqual({ kind: 'hold', reason: 'rate-bounded', nodeId: 'macmini' })

    // Moves older than the window do not count against the budget.
    const afterWindow = planStressFailover(
      {
        verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'ok', 0.1)],
        candidates: [candidate()],
        history,
        attachedByNode: attached,
      },
      G.rateWindowMs + 10_000,
    )
    expect(afterWindow).toMatchObject({ kind: 'move' })
  })

  it('plans at most ONE move, and the same snapshot re-plans identically', () => {
    const input = {
      verdicts: [verdict('macmini', 'saturated', 0.9), verdict('hub', 'ok', 0.1)],
      candidates: [
        candidate({ deviceId: 101, configuredFps: 5 }),
        candidate({ deviceId: 102, configuredFps: 5 }),
      ],
      history: [],
      attachedByNode: attached,
    }
    const first = planStressFailover(input, 0)
    const second = planStressFailover(input, 0)
    expect(first).toEqual(second)
    // Equal cost ⇒ lowest deviceId, so a repeated run is idempotent.
    expect(first).toMatchObject({ kind: 'move', deviceId: 101 })
  })

  it('picks the WORST saturated node when several are', () => {
    const plan = planStressFailover(
      {
        verdicts: [
          verdict('macmini', 'saturated', 0.85),
          verdict('agent-a', 'saturated', 0.95),
          verdict('hub', 'ok', 0.1),
        ],
        candidates: [
          candidate({ deviceId: 101, nodeId: 'macmini' }),
          candidate({
            deviceId: 104,
            nodeId: 'agent-a',
            eligibleNodes: ['agent-a', 'hub'],
          }),
        ],
        history: [],
        attachedByNode: { macmini: 4, 'agent-a': 4, hub: 1 },
      },
      0,
    )
    expect(plan).toMatchObject({ kind: 'move', deviceId: 104, fromNodeId: 'agent-a' })
  })
})
