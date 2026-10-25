/**
 * `pipeline-analytics` arms the stall monitor that already existed.
 *
 * This is ONE process serving every camera, and it goes silent for 10+ s about
 * three times an hour (2026-09-09). The prior investigation established that
 * the event loop is not blocked WHOLESALE — the 5-minute `[mem]` timer fired at
 * dt = 300020 / 300066 / 299991 ms straight through the silences — but "the
 * loop is not blocked for five minutes" is not "the loop is never blocked for
 * ten seconds", and the 5 s scale is precisely where a `[mem]` heartbeat cannot
 * see. `startEventLoopStallMonitor` is a 1 s tick that can, and it also says
 * whether GC owned the freeze.
 *
 * It is the corroborating half of `frame-lag-logging.spec.ts`: the lag line
 * says the events were on time, this one says the loop was blocked anyway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootAnalytics, type Booted } from './boot-analytics.js'

/**
 * Freeze the loop for `ms` WITHOUT running the timers that would have fired in
 * between — what a stop-the-world looks like from inside the process. Same
 * device as `recorder-stall-monitor.spec.ts`, deliberately.
 */
function freezeLoopFor(ms: number): void {
  vi.setSystemTime(Date.now() + ms)
  vi.advanceTimersByTime(1_000)
}

describe('pipeline-analytics arms the stall monitor', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
    vi.useRealTimers()
  })

  it('attributes a 10 s freeze, with the GC fields the verdict needs', async () => {
    // Fake timers BEFORE boot: the monitor's interval has to be created on the
    // fake clock, or `advanceTimersByTime` drives nothing. `shouldAdvanceTime`
    // keeps the addon's own awaits from deadlocking during boot.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    booted = await bootAnalytics(102, async () => null)

    freezeLoopFor(10_000)

    const stall = booted.logs.find((l) => l.message === 'event loop stalled')
    expect(stall).toBeDefined()
    const meta = (stall?.extras as { meta?: Record<string, unknown> } | undefined)?.meta
    expect(meta).toBeDefined()
    // The reason to arm THIS monitor and not read `loopMax`: it says whether
    // the freeze was garbage collection, and for how long.
    expect(meta).toHaveProperty('cause')
    expect(meta).toHaveProperty('gcMs')
    expect(meta).toHaveProperty('heapUsedMb')
  })

  it('comes down with the addon — a 1 s timer that outlives a respawn is a leak', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    booted = await bootAnalytics(102, async () => null)
    await booted.addon.shutdown()
    const before = booted.logs.length
    freezeLoopFor(10_000)
    expect(booted.logs.length).toBe(before)
    booted = undefined
  })
})
