/**
 * Benchmark mode (D791) — the pure rules the orchestrator applies while one
 * node is under test: who is still a detection candidate, which pins are
 * ignored, which cameras move and which cannot, what the run will take, and
 * why it may not start.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyCamerasForBenchmark,
  eligibleUnderBenchmark,
  estimateNodeBenchmarkDurationMs,
  nodeBenchmarkRefusals,
  pinUnderBenchmark,
} from '../benchmark-mode.js'
import { NodeBenchmarkPlanSchema } from '../schemas.js'

describe('eligibleUnderBenchmark', () => {
  it('drops the node under test', () => {
    expect(eligibleUnderBenchmark(['hub', 'mac', 'n100'], 'mac')).toEqual(['hub', 'n100'])
  })
  it('keeps the list unchanged when no benchmark runs', () => {
    expect(eligibleUnderBenchmark(['hub', 'mac'], null)).toEqual(['hub', 'mac'])
  })
  it('keeps the node when it is the only frame source — the camera stays, never blind', () => {
    expect(eligibleUnderBenchmark(['mac'], 'mac')).toEqual(['mac'])
  })
})

describe('pinUnderBenchmark', () => {
  it('ignores a node pin naming the node under test when another node can take the camera', () => {
    expect(pinUnderBenchmark('mac', 'mac', ['hub', 'mac'])).toBeNull()
  })
  it('keeps a pin naming another node', () => {
    expect(pinUnderBenchmark('hub', 'mac', ['hub', 'mac'])).toBe('hub')
  })
  it('keeps the pin when the node under test is the only frame source', () => {
    expect(pinUnderBenchmark('mac', 'mac', ['mac'])).toBe('mac')
  })
  it('is the identity outside benchmark mode', () => {
    expect(pinUnderBenchmark('mac', null, ['hub', 'mac'])).toBe('mac')
    expect(pinUnderBenchmark(null, 'mac', ['hub', 'mac'])).toBeNull()
  })
})

describe('classifyCamerasForBenchmark', () => {
  it('splits cameras into moving (placed or pinned) and staying (only source)', () => {
    const out = classifyCamerasForBenchmark('mac', [
      { deviceId: 1, placedNodeId: 'mac', nodePin: null, frameSourceNodes: ['hub', 'mac'] },
      { deviceId: 2, placedNodeId: null, nodePin: 'mac', frameSourceNodes: ['hub', 'mac'] },
      { deviceId: 3, placedNodeId: 'hub', nodePin: null, frameSourceNodes: ['hub', 'mac'] },
      { deviceId: 4, placedNodeId: 'mac', nodePin: 'mac', frameSourceNodes: ['mac'] },
    ])
    expect(out.moving).toEqual([
      { deviceId: 1, placedOnNode: true, pinnedToNode: false },
      { deviceId: 2, placedOnNode: false, pinnedToNode: true },
    ])
    expect(out.staying).toEqual([{ deviceId: 4, reason: 'only-frame-source' }])
  })
  it('a camera neither placed on nor pinned to the node is not listed', () => {
    const out = classifyCamerasForBenchmark('mac', [
      { deviceId: 9, placedNodeId: 'hub', nodePin: 'hub', frameSourceNodes: ['mac'] },
    ])
    expect(out).toEqual({ moving: [], staying: [] })
  })
})

describe('estimateNodeBenchmarkDurationMs', () => {
  it('grows with devices × candidates and with the pipeline measurement, and never exceeds the budget', () => {
    const one = NodeBenchmarkPlanSchema.parse({
      nodeId: 'mac',
      devices: [{ deviceKey: 'coreml:all', modelIds: ['a'] }],
      phases: ['device'],
    })
    const more = NodeBenchmarkPlanSchema.parse({
      nodeId: 'mac',
      devices: [{ deviceKey: 'coreml:all', modelIds: ['a', 'b'] }],
      phases: ['device', 'pipeline'],
    })
    const a = estimateNodeBenchmarkDurationMs(one)
    const b = estimateNodeBenchmarkDurationMs(more)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    const tight = NodeBenchmarkPlanSchema.parse({
      nodeId: 'mac',
      devices: [{ deviceKey: 'x', modelIds: ['a', 'b', 'c', 'd', 'e', 'f'] }],
      budgetMinutes: 10,
    })
    expect(estimateNodeBenchmarkDurationMs(tight)).toBe(10 * 60_000)
  })
})

describe('nodeBenchmarkRefusals', () => {
  const plan = NodeBenchmarkPlanSchema.parse({
    nodeId: 'mac',
    devices: [{ deviceKey: 'coreml:all', modelIds: ['a'] }],
  })
  const base = {
    plan,
    activeRunNodeId: null,
    online: true,
    knownDeviceKeys: ['coreml:all'],
    sessionsNow: 2,
    otherNodesCapacitySessions: 5,
  }
  it('starts when nothing is wrong', () => {
    expect(nodeBenchmarkRefusals(base)).toEqual([])
  })
  it('one benchmark at a time, cluster-wide', () => {
    expect(nodeBenchmarkRefusals({ ...base, activeRunNodeId: 'hub' }).map((r) => r.kind)).toEqual([
      'benchmark-active',
    ])
  })
  it('refuses an offline node and an unknown device', () => {
    const kinds = nodeBenchmarkRefusals({
      ...base,
      online: false,
      knownDeviceKeys: [],
    }).map((r) => r.kind)
    expect(kinds).toEqual(['node-offline', 'unknown-device'])
  })
  it('insufficient headroom refuses unless the plan accepts it', () => {
    const tight = { ...base, sessionsNow: 6, otherNodesCapacitySessions: 3 }
    const refusal = nodeBenchmarkRefusals(tight)
    expect(refusal).toEqual([
      expect.objectContaining({ kind: 'insufficient-headroom', overridable: true }),
    ])
    expect(
      nodeBenchmarkRefusals({ ...tight, plan: { ...plan, acceptInsufficientHeadroom: true } }),
    ).toEqual([])
  })
  it('an unknown capacity never refuses on headroom', () => {
    expect(
      nodeBenchmarkRefusals({ ...base, otherNodesCapacitySessions: null, sessionsNow: 50 }),
    ).toEqual([])
  })
})
