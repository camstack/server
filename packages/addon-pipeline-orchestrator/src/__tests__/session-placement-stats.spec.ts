import { describe, expect, it } from 'vitest'
import { SessionPlacementStats } from '../session-placement-stats.js'

const MIN = 60_000

describe('SessionPlacementStats', () => {
  it('time-weights the share of PARALLEL sessions per node over the window', () => {
    let now = 0
    const stats = new SessionPlacementStats(() => now)
    // 0–10 min: mac 3 / hub 1. 10–20 min: mac 1 / hub 1.
    stats.noteSessions([
      { nodeId: 'mac', deviceKey: 'coreml:all' },
      { nodeId: 'mac', deviceKey: 'coreml:all' },
      { nodeId: 'mac', deviceKey: 'coreml:all' },
      { nodeId: 'hub', deviceKey: 'openvino:npu' },
    ])
    now = 10 * MIN
    stats.noteSessions([
      { nodeId: 'mac', deviceKey: 'coreml:all' },
      { nodeId: 'hub', deviceKey: 'openvino:npu' },
    ])
    now = 20 * MIN
    const snap = stats.snapshot(60 * MIN)
    const mac = snap.nodes.find((n) => n.nodeId === 'mac')!
    const hub = snap.nodes.find((n) => n.nodeId === 'hub')!
    // mac: (3×10 + 1×10) / (4×10 + 2×10) = 40/60.
    expect(mac.observedShare).toBeCloseTo(40 / 60, 5)
    expect(hub.observedShare).toBeCloseTo(20 / 60, 5)
    expect(mac.peakSessions).toBe(3)
    expect(mac.sessionsNow).toBe(1)
    expect(snap.clusterPeakSessions).toBe(4)
    expect(snap.sessionsNow).toBe(2)
    expect(snap.observedForMs).toBe(20 * MIN)
  })

  it('counts starts and yields inside the window only', () => {
    let now = 0
    const stats = new SessionPlacementStats(() => now)
    stats.noteStart('hub', 'openvino:npu')
    stats.noteYield('n100')
    now = 90 * MIN
    stats.noteStart('hub', 'openvino:gpu')
    const snap = stats.snapshot(60 * MIN)
    const hub = snap.nodes.find((n) => n.nodeId === 'hub')!
    expect(hub.sessionsStarted).toBe(1)
    expect(hub.devices.map((d) => [d.deviceKey, d.sessionsStarted])).toEqual([['openvino:gpu', 1]])
    expect(snap.nodes.find((n) => n.nodeId === 'n100')).toBeUndefined()
  })

  it('a node with no session in the window has no observed share (null, not 0)', () => {
    let now = 0
    const stats = new SessionPlacementStats(() => now)
    stats.noteStart('hub', 'openvino:npu')
    stats.noteSessions([])
    now = 5 * MIN
    const hub = stats.snapshot(60 * MIN).nodes.find((n) => n.nodeId === 'hub')!
    expect(hub.observedShare).toBeNull()
  })

  it('reports the device share within its node', () => {
    let now = 0
    const stats = new SessionPlacementStats(() => now)
    stats.noteSessions([
      { nodeId: 'hub', deviceKey: 'openvino:npu' },
      { nodeId: 'hub', deviceKey: 'openvino:gpu' },
      { nodeId: 'hub', deviceKey: 'openvino:gpu' },
      { nodeId: 'hub', deviceKey: 'openvino:gpu' },
    ])
    now = MIN
    const hub = stats.snapshot(60 * MIN).nodes.find((n) => n.nodeId === 'hub')!
    expect(hub.devices.map((d) => [d.deviceKey, d.observedShare])).toEqual([
      ['openvino:gpu', 0.75],
      ['openvino:npu', 0.25],
    ])
  })

  it('drops segments older than 24 h', () => {
    let now = 0
    const stats = new SessionPlacementStats(() => now)
    stats.noteSessions([{ nodeId: 'hub', deviceKey: '' }])
    now = MIN
    stats.noteSessions([])
    now = 25 * 60 * MIN
    stats.noteSessions([{ nodeId: 'hub', deviceKey: '' }])
    // The 0-min segment ended before the 24 h floor; the 1-min one still covers it.
    expect(stats.segmentCount()).toBe(2)
  })
})
