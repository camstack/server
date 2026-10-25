/**
 * D916 — per-camera affinity. On-motion sessions are short and never overlap,
 * so every election saw nothing running and the recency memory rotated the
 * camera on purpose: 3835 moved node on 11 of 14 sessions in ten minutes. A
 * camera now keeps its previous node/device while that one is within ONE
 * session of the turn holder — and the cumulative split still follows the
 * shares.
 */
import type { RunnerLocalLoad } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { pickInferenceDevice, selectedDeviceKey } from '../device-balancer.js'
import { SessionAffinityMemory, SESSION_AFFINITY_TTL_MS } from '../session-affinity.js'
import { electNodeByShareWithAffinity } from '../session-share-placement.js'
import { ShareElectionHistory } from '../share-election-history.js'

function load(nodeId: string): RunnerLocalLoad {
  return {
    nodeId,
    attachedCameras: 0,
    activeCameras: 0,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    queueDepthTotal: 0,
    devices: [],
    hardware: { hasGpu: false },
  }
}

const NODES = ['agent-b', 'hub', 'agent-a', 'mac']

/** Deterministic PRNG (mulberry32): the same session trace on every run. */
function prng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface SimResult {
  readonly perNode: Record<string, number>
  readonly movesPerCamera: readonly number[]
  readonly sessionsPerCamera: readonly number[]
}

/**
 * Sequential sessions of several cameras, uneven rates (a busy doorway and
 * quiet corners), one every ~40 s — the production shape: nothing is running
 * at any election.
 */
function simulate(opts: {
  readonly affinity: boolean
  readonly sessions: number
  readonly weights: Record<string, number>
}): SimResult {
  let now = 0
  const history = new ShareElectionHistory(() => now)
  const memory = new SessionAffinityMemory(() => now)
  const rates = [8, 5, 3, 2, 1, 1]
  const totalRate = rates.reduce((s, r) => s + r, 0)
  const rnd = prng(42)
  const perNode: Record<string, number> = {}
  const moves = rates.map(() => 0)
  const count = rates.map(() => 0)
  const last: (string | null)[] = rates.map(() => null)
  for (let i = 0; i < opts.sessions; i++) {
    now += 40_000
    let pick = rnd() * totalRate
    let cam = 0
    while (pick >= rates[cam]!) {
      pick -= rates[cam]!
      cam++
    }
    const out = electNodeByShareWithAffinity({
      loads: NODES.map(load),
      eligible: NODES,
      weights: opts.weights,
      caps: {},
      runningByNode: new Map(),
      history,
      previousNodeId: opts.affinity ? (memory.previous(cam)?.nodeId ?? null) : null,
    })
    if (out.election.kind !== 'elected') throw new Error('nothing elected')
    const node = out.election.key
    memory.note(cam, node, null)
    perNode[node] = (perNode[node] ?? 0) + 1
    if (last[cam] !== null && last[cam] !== node) moves[cam]! += 1
    last[cam] = node
    count[cam]! += 1
  }
  return { perNode, movesPerCamera: moves, sessionsPerCamera: count }
}

function totalMoves(r: SimResult): number {
  return r.movesPerCamera.reduce((s, m) => s + m, 0)
}

describe('session affinity (D916)', () => {
  const equal = { 'agent-b': 1, hub: 1, 'agent-a': 1, mac: 1 }

  it('without affinity a camera hops node on most sessions (the observed 11 of 14)', () => {
    const r = simulate({ affinity: false, sessions: 400, weights: equal })
    // Most of the 400 sessions (less one first session per camera) are a move.
    expect(totalMoves(r)).toBeGreaterThan(0.6 * 400)
  })

  it('with affinity a camera moves rarely, and equal weights still get equal sessions', () => {
    const plain = simulate({ affinity: false, sessions: 400, weights: equal })
    const r = simulate({ affinity: true, sessions: 400, weights: equal })
    // A third of the moves at most. The busiest camera raises 40% of the
    // cluster's sessions against a 25% node share, so it MUST move some —
    // within one session, it keeps its node for most of its sessions.
    expect(totalMoves(r)).toBeLessThan(0.4 * totalMoves(plain))
    expect(totalMoves(r)).toBeLessThan(0.35 * 400)
    expect(r.movesPerCamera[0]!).toBeLessThan(0.4 * r.sessionsPerCamera[0]!)
    // The quiet cameras barely move.
    expect(r.movesPerCamera[4]!).toBeLessThan(0.4 * r.sessionsPerCamera[4]!)
    for (const node of NODES) {
      expect(r.perNode[node] ?? 0).toBeGreaterThanOrEqual(400 * 0.25 * 0.85)
      expect(r.perNode[node] ?? 0).toBeLessThanOrEqual(400 * 0.25 * 1.15)
    }
  })

  it('unequal weights converge on their shares with affinity on', () => {
    const weights = { 'agent-b': 1, hub: 2, 'agent-a': 1, mac: 4 }
    const r = simulate({ affinity: true, sessions: 800, weights })
    for (const [node, w] of Object.entries(weights)) {
      const target = (800 * w) / 8
      expect(r.perNode[node] ?? 0).toBeGreaterThanOrEqual(target * 0.85)
      expect(r.perNode[node] ?? 0).toBeLessThanOrEqual(target * 1.15)
    }
    const plain = simulate({ affinity: false, sessions: 800, weights })
    expect(totalMoves(r)).toBeLessThan(0.5 * totalMoves(plain))
  })

  it('a remembered placement expires with the election memory', () => {
    let now = 0
    const memory = new SessionAffinityMemory(() => now)
    memory.note(7, 'mac', 'coreml:all')
    expect(memory.previous(7)).toEqual({ nodeId: 'mac', deviceKey: 'coreml:all' })
    now += SESSION_AFFINITY_TTL_MS + 1
    expect(memory.previous(7)).toBeNull()
    memory.note(7, 'hub', null)
    memory.forget(7)
    expect(memory.previous(7)).toBeNull()
  })

  it('the device tier keeps the previous device within one session, and leaves one that is not offered', () => {
    const history = new ShareElectionHistory(() => 0)
    const eligible = { 'edgetpu:pci': 100, 'edgetpu:usb': 100 }
    const loads = Object.keys(eligible).map((deviceKey) => ({ deviceKey, attachedCameras: 0 }))
    const first = pickInferenceDevice({
      eligible,
      loads,
      policy: 'share',
      shareHistory: history,
      historyScope: 'amd',
    })
    const firstKey = selectedDeviceKey(first)
    expect(firstKey).toBeDefined()
    // Plain share would now rotate to the other Coral; affinity keeps it.
    const again = pickInferenceDevice({
      eligible,
      loads,
      policy: 'share',
      shareHistory: history,
      historyScope: 'amd',
      previousDeviceKey: firstKey ?? null,
    })
    expect(selectedDeviceKey(again)).toBe(firstKey)
    expect(again).toMatchObject({ affinity: { sticky: true, reason: 'within-one-session' } })
    // The previous device dropped out of the offer (backoff, disabled): re-elected.
    const other = firstKey === 'edgetpu:pci' ? 'edgetpu:usb' : 'edgetpu:pci'
    const gone = pickInferenceDevice({
      eligible: { [other]: 100, cpu: 1 },
      loads: [],
      policy: 'share',
      shareHistory: history,
      historyScope: 'amd',
      previousDeviceKey: firstKey ?? null,
    })
    expect(gone).toMatchObject({ affinity: { sticky: false, reason: 'previous-ineligible' } })
  })
})
