import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startReachabilityPoll,
  REACHABILITY_POLL_INTERVAL_MS,
  REACHABILITY_FAILURES_TO_OFFLINE,
} from '../device/reachability-poll.js'

/**
 * The poller uses `setInterval` + `setTimeout` (probe timeout). Fake timers
 * drive the cadence; each assertion flushes microtasks so the async `tick`
 * settles before we inspect `setOnline` calls.
 */
async function flush(): Promise<void> {
  // Drain the microtask chain of an in-flight `tick` (Promise.resolve →
  // probe → Promise.race → setOnline). The chain is a handful of hops deep;
  // loop generously so the assertion never races the settle.
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve()
  }
}

describe('startReachabilityPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('exposes the documented default constants', () => {
    expect(REACHABILITY_POLL_INTERVAL_MS).toBe(30_000)
    expect(REACHABILITY_FAILURES_TO_OFFLINE).toBe(3)
  })

  it('marks ONLINE on the first successful probe (runs immediately)', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const setOnline = vi.fn()
    const handle = startReachabilityPoll({ probe, setOnline })

    await flush()

    expect(probe).toHaveBeenCalledTimes(1)
    expect(setOnline).toHaveBeenCalledTimes(1)
    expect(setOnline).toHaveBeenCalledWith(true)
    handle.stop()
  })

  it('stays ONLINE through a single transient failure (below threshold)', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(true) // immediate
      .mockRejectedValueOnce(new Error('transient')) // 1 miss < 3
      .mockResolvedValue(true)
    const setOnline = vi.fn()
    const handle = startReachabilityPoll({
      probe,
      setOnline,
      failuresToOffline: 3,
    })

    await flush() // immediate → online
    expect(setOnline).toHaveBeenLastCalledWith(true)

    await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_INTERVAL_MS) // 1st miss
    await flush()

    // A single miss must NOT flip offline.
    expect(setOnline).not.toHaveBeenCalledWith(false)
    handle.stop()
  })

  it('goes OFFLINE only after N consecutive failures, then ONLINE again on recovery', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(true) // immediate → online
      .mockResolvedValueOnce(false) // miss 1
      .mockResolvedValueOnce(false) // miss 2
      .mockResolvedValueOnce(false) // miss 3 → offline
      .mockResolvedValue(true) // recovery → online
    const setOnline = vi.fn()
    const handle = startReachabilityPoll({
      probe,
      setOnline,
      failuresToOffline: 3,
    })

    await flush()
    expect(setOnline).toHaveBeenNthCalledWith(1, true)

    await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_INTERVAL_MS) // miss 1
    await flush()
    await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_INTERVAL_MS) // miss 2
    await flush()
    expect(setOnline).not.toHaveBeenCalledWith(false)

    await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_INTERVAL_MS) // miss 3 → offline
    await flush()
    expect(setOnline).toHaveBeenCalledWith(false)

    await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_INTERVAL_MS) // recovery
    await flush()
    expect(setOnline).toHaveBeenLastCalledWith(true)
    handle.stop()
  })

  it('resets the failure counter on an intervening success (non-consecutive misses never flip)', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(true) // online
      .mockResolvedValueOnce(false) // miss 1
      .mockResolvedValueOnce(false) // miss 2
      .mockResolvedValueOnce(true) // success → reset
      .mockResolvedValueOnce(false) // miss 1 again
      .mockResolvedValue(false) // miss 2 again (still < 3)
    const setOnline = vi.fn()
    const handle = startReachabilityPoll({ probe, setOnline, failuresToOffline: 3 })

    await flush()
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_INTERVAL_MS)
      await flush()
    }

    expect(setOnline).not.toHaveBeenCalledWith(false)
    handle.stop()
  })

  it('counts a hung probe as a failure via the probe timeout', async () => {
    // Probe that never resolves — the internal timeout must reject it.
    const probe = vi.fn().mockImplementation(() => new Promise<boolean>(() => {}))
    const setOnline = vi.fn()
    const handle = startReachabilityPoll({
      probe,
      setOnline,
      failuresToOffline: 1,
      probeTimeoutMs: 5_000,
      runImmediately: true,
    })

    await vi.advanceTimersByTimeAsync(5_000) // trip the probe timeout
    await flush()

    expect(setOnline).toHaveBeenCalledWith(false)
    handle.stop()
  })

  it('does not stack probes — a slow probe blocks the next tick', async () => {
    let resolveProbe: ((v: boolean) => void) | undefined
    const probe = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve
        }),
    )
    const setOnline = vi.fn()
    const handle = startReachabilityPoll({
      probe,
      setOnline,
      probeTimeoutMs: 60_000,
    })

    await flush() // immediate tick starts, probe in-flight (unresolved)
    expect(probe).toHaveBeenCalledTimes(1)

    // Interval fires again while the first probe is still running.
    await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_INTERVAL_MS)
    await flush()
    // Still only ONE probe — the running guard blocked the second.
    expect(probe).toHaveBeenCalledTimes(1)

    resolveProbe?.(true)
    await flush()
    handle.stop()
  })

  it('skips probing when isEnabled() returns false (disabled device)', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const setOnline = vi.fn()
    let enabled = false
    const handle = startReachabilityPoll({
      probe,
      setOnline,
      isEnabled: () => enabled,
    })

    await flush()
    expect(probe).not.toHaveBeenCalled()
    expect(setOnline).not.toHaveBeenCalled()

    enabled = true
    await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_INTERVAL_MS)
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(setOnline).toHaveBeenCalledWith(true)
    handle.stop()
  })

  it('honours runImmediately:false — first probe waits one interval', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const setOnline = vi.fn()
    const handle = startReachabilityPoll({
      probe,
      setOnline,
      runImmediately: false,
    })

    await flush()
    expect(probe).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_INTERVAL_MS)
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
    handle.stop()
  })

  it('stop() clears the timer and prevents further probes', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const setOnline = vi.fn()
    const handle = startReachabilityPoll({ probe, setOnline })

    await flush()
    expect(probe).toHaveBeenCalledTimes(1)

    handle.stop()
    const callsAfterStop = probe.mock.calls.length

    await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_INTERVAL_MS * 3)
    await flush()
    expect(probe).toHaveBeenCalledTimes(callsAfterStop)
  })

  it('stop() is idempotent', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const handle = startReachabilityPoll({ probe, setOnline: vi.fn() })
    await flush()
    expect(() => {
      handle.stop()
      handle.stop()
    }).not.toThrow()
  })

  it('a late-resolving probe after stop() does not drive setOnline', async () => {
    let resolveProbe: ((v: boolean) => void) | undefined
    const probe = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve
        }),
    )
    const setOnline = vi.fn()
    const handle = startReachabilityPoll({ probe, setOnline, probeTimeoutMs: 60_000 })

    await flush() // probe in-flight
    handle.stop()
    resolveProbe?.(true) // resolves AFTER stop
    await flush()

    expect(setOnline).not.toHaveBeenCalled()
  })
})
