/**
 * D904 — a Reolink camera that cannot be reached for a sustained window goes
 * offline; one failed probe never flips it (D49). Incident 2026-10-22: camera
 * 618 lost power for 2 h 15 m and stayed `online`, because offline came ONLY
 * from a firmware push a powerless camera cannot send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isConnectivityFailure,
  REACHABILITY_OFFLINE_WINDOW_MS,
  REACHABILITY_RECOVERY_PROBE_MS,
  type ReachabilityOfflineInfo,
  ReachabilityOfflineTracker,
  type ReachabilityOnlineInfo,
  type ReachabilityProbeResult,
} from '../reachability-offline.js'

interface Harness {
  readonly tracker: ReachabilityOfflineTracker
  readonly offline: ReachabilityOfflineInfo[]
  readonly online: ReachabilityOnlineInfo[]
  readonly probes: { count: number }
  setProbe(result: ReachabilityProbeResult): void
}

function harness(): Harness {
  const offline: ReachabilityOfflineInfo[] = []
  const online: ReachabilityOnlineInfo[] = []
  const probes = { count: 0 }
  let next: ReachabilityProbeResult = 'unreachable'
  const tracker = new ReachabilityOfflineTracker({
    probe: async () => {
      probes.count += 1
      return next
    },
    onOffline: (info) => offline.push(info),
    onOnline: (info) => online.push(info),
  })
  return {
    tracker,
    offline,
    online,
    probes,
    setProbe: (result) => {
      next = result
    },
  }
}

describe('ReachabilityOfflineTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays online when the camera answers again inside the window', async () => {
    const h = harness()
    h.tracker.noteFailure('close')
    await vi.advanceTimersByTimeAsync(REACHABILITY_OFFLINE_WINDOW_MS - 1_000)
    h.tracker.noteFailure('EHOSTUNREACH')
    h.tracker.noteReachable()
    await vi.advanceTimersByTimeAsync(REACHABILITY_OFFLINE_WINDOW_MS * 3)

    expect(h.offline).toEqual([])
    expect(h.online).toEqual([])
    expect(h.tracker.state).toBe('reachable')
  })

  it('is not offline before the window has passed, however many attempts fail', async () => {
    const h = harness()
    h.tracker.noteFailure('close')
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000)
      h.tracker.noteFailure('EHOSTUNREACH')
    }
    expect(h.offline).toEqual([])
    expect(h.tracker.state).toBe('failing')
  })

  it('goes offline ONCE after a sustained window, confirmed by one fresh probe', async () => {
    const h = harness()
    h.tracker.noteFailure('close')
    h.tracker.noteFailure('EHOSTUNREACH')
    await vi.advanceTimersByTimeAsync(REACHABILITY_OFFLINE_WINDOW_MS)

    expect(h.probes.count).toBe(1)
    expect(h.offline).toEqual([{ since: 1_000_000, failures: 2, lastReason: 'EHOSTUNREACH' }])
    expect(h.tracker.state).toBe('offline')

    // More failures and several recovery probes later: still exactly one verdict.
    h.tracker.noteFailure('EHOSTUNREACH')
    await vi.advanceTimersByTimeAsync(REACHABILITY_RECOVERY_PROBE_MS * 4)
    expect(h.offline).toHaveLength(1)
    expect(h.probes.count).toBe(5)
  })

  it('one failed probe never flips state: the confirmation probe answering keeps it online', async () => {
    const h = harness()
    h.tracker.noteFailure('close')
    h.setProbe('reachable')
    await vi.advanceTimersByTimeAsync(REACHABILITY_OFFLINE_WINDOW_MS)

    expect(h.offline).toEqual([])
    expect(h.online).toEqual([])
    expect(h.tracker.state).toBe('reachable')
  })

  it('comes back online ONCE on the first success after the outage', async () => {
    const h = harness()
    h.tracker.noteFailure('close')
    await vi.advanceTimersByTimeAsync(REACHABILITY_OFFLINE_WINDOW_MS)
    expect(h.offline).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    h.tracker.noteReachable()
    h.tracker.noteReachable()
    expect(h.online).toEqual([{ offlineForMs: 60_000 }])
    expect(h.tracker.state).toBe('reachable')
  })

  it('a recovery probe that answers ends the outage when nobody else dials the camera', async () => {
    const h = harness()
    h.tracker.noteFailure('close')
    await vi.advanceTimersByTimeAsync(REACHABILITY_OFFLINE_WINDOW_MS)
    h.setProbe('reachable')
    await vi.advanceTimersByTimeAsync(REACHABILITY_RECOVERY_PROBE_MS)

    expect(h.online).toEqual([{ offlineForMs: REACHABILITY_RECOVERY_PROBE_MS }])
    await vi.advanceTimersByTimeAsync(REACHABILITY_RECOVERY_PROBE_MS * 4)
    expect(h.online).toHaveLength(1)
  })

  it('a firmware push resets the verdict without emitting', async () => {
    const h = harness()
    h.tracker.noteFailure('close')
    await vi.advanceTimersByTimeAsync(REACHABILITY_OFFLINE_WINDOW_MS)
    h.tracker.reset()
    await vi.advanceTimersByTimeAsync(REACHABILITY_RECOVERY_PROBE_MS * 4)

    expect(h.online).toEqual([])
    expect(h.tracker.state).toBe('reachable')
  })
})

describe('isConnectivityFailure', () => {
  it('reads the socket error code the prod logs carried', () => {
    const err = Object.assign(new Error('connect EHOSTUNREACH 192.0.2.10:9000'), {
      code: 'EHOSTUNREACH',
    })
    expect(isConnectivityFailure(err)).toBe(true)
    expect(isConnectivityFailure(new Error('connect ECONNREFUSED 192.0.2.10:9000'))).toBe(true)
    expect(isConnectivityFailure(new Error('Baichuan timeout cmdId=1 msgNum=0'))).toBe(true)
  })

  it('an answer from the camera is not unreachability', () => {
    expect(isConnectivityFailure(new Error('Authentication failed'))).toBe(false)
    expect(isConnectivityFailure(new Error('responseCode 400'))).toBe(false)
  })
})
