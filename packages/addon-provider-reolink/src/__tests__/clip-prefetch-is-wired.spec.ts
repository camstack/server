/**
 * The prefetch is CALLED, by the catalog refresh, and only where it is free.
 *
 * D549-16 designed the whole thing — a bound, a second queue lane, a
 * sulking-host rule, a headroom that forbids eviction — and D574 found that
 * nothing outside a test ever called it. Every assertion below therefore
 * starts COLD and reads a SEQUENCE of ticks: "never runs" and "runs for ever"
 * are the two defects, and a single tick sees neither.
 *
 * The topology rule is the refresh's own (D562), because the cost is:
 *
 * | shape | what one still costs | measured 2026-09-21 |
 * | --- | --- | --- |
 * | mains standalone (107) | the camera's own socket | 194–212 ms per still |
 * | hub child (3628) | the PARENT's one shared session | 212–522 ms per still |
 * | standalone battery (106, 4263) | **a wake** | never asked |
 *
 * A standalone battery camera is refused in BOTH of its modes, by two
 * different mechanisms. `mark-stale` read no catalog at all, so the timer
 * returns before the prefetch is even a question — and `ClipPrefetchMode`
 * excludes it, so no clause pretends to handle it. `forced-wake` DID read one,
 * but it bought exactly one wake for the CATALOG: the operator's own switch
 * text says "one interval buys exactly one wake", and sixty CoverPreviews on
 * top of it is a second meaning for a knob that already names what it buys
 * (D62).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  ClipCatalogRefreshScheduler,
  type ClipCatalogRefreshDeps,
  type ClipRefreshTarget,
} from '../clips/clip-refresh.js'
import {
  decideClipPrefetch,
  prefetchQuietMs,
  PREFETCH_QUIET_MAX_MS,
  type ClipPrefetchOutcome,
} from '../clips/clip-prefetch.js'
import { createRecordingLogger } from './clip-test-logger.js'

const NOW = Date.parse('2026-09-21T12:00:00Z')
const MINUTE = 60_000

const MAINS_STANDALONE: ClipRefreshTarget = {
  deviceId: 107,
  hostKey: '192.168.10.161',
  isHubChild: false,
  isBattery: false,
  forcedWake: false,
  intervalMinutes: 30,
}
const HUB_CHILD: ClipRefreshTarget = {
  deviceId: 3628,
  hostKey: '192.168.10.170',
  isHubChild: true,
  isBattery: true,
  forcedWake: false,
  intervalMinutes: 30,
}
const BATTERY_STANDALONE: ClipRefreshTarget = {
  deviceId: 106,
  hostKey: '192.168.10.181',
  isHubChild: false,
  isBattery: true,
  forcedWake: false,
  intervalMinutes: 30,
}
const BATTERY_FORCED: ClipRefreshTarget = { ...BATTERY_STANDALONE, forcedWake: true }

function landed(minted: number): ClipPrefetchOutcome {
  return { minted, scanned: minted, alreadyHeld: 0, stop: 'rows-exhausted', refusal: null }
}

function refused(): ClipPrefetchOutcome {
  return {
    minted: 0,
    scanned: 1,
    alreadyHeld: 0,
    stop: 'refused',
    refusal: { code: 'camera-refused', disposition: 'final', clipKey: 'abc123' },
  }
}

interface HarnessOptions {
  readonly targets?: readonly ClipRefreshTarget[]
  readonly busyHosts?: ReadonlySet<string>
  readonly refreshFails?: boolean
  readonly prefetch?: (deviceId: number) => ClipPrefetchOutcome
  readonly prefetchThrows?: boolean
}

function harness(options: HarnessOptions = {}) {
  let now = NOW
  /** Every dep call, in order — the sequence the assertions read. */
  const trace: string[] = []
  const refresh = vi.fn(async (deviceId: number) => {
    trace.push(`refresh:${String(deviceId)}`)
    if (options.refreshFails === true) throw new Error('Baichuan socket closed')
  })
  const prefetchStills = vi.fn(async (deviceId: number): Promise<ClipPrefetchOutcome> => {
    trace.push(`prefetch:${String(deviceId)}`)
    if (options.prefetchThrows === true) throw new Error('the still lane is gone')
    return options.prefetch?.(deviceId) ?? landed(3)
  })
  const wake = vi.fn(async (deviceId: number) => {
    trace.push(`wake:${String(deviceId)}`)
  })
  const markStale = vi.fn((deviceId: number) => {
    trace.push(`markStale:${String(deviceId)}`)
  })
  const logger = createRecordingLogger()
  const deps: ClipCatalogRefreshDeps = {
    now: () => now,
    listTargets: () => options.targets ?? [MAINS_STANDALONE],
    refresh,
    wake,
    markStale,
    prefetchStills,
    hostBusy: (hostKey) => options.busyHosts?.has(hostKey) ?? false,
    logger,
  }
  return {
    scheduler: new ClipCatalogRefreshScheduler(deps),
    trace,
    refresh,
    prefetchStills,
    markStale,
    logger,
    advance: (ms: number) => {
      now += ms
    },
  }
}

// ── the pure rule ─────────────────────────────────────────────────────────

describe('decideClipPrefetch — where a still is free, and where it is a wake', () => {
  it('runs on the two shapes the refresh really read', () => {
    expect(decideClipPrefetch({ mode: 'direct', hostBusy: false, quiet: false })).toEqual({
      kind: 'run',
    })
    expect(decideClipPrefetch({ mode: 'via-hub', hostBusy: false, quiet: false })).toEqual({
      kind: 'run',
    })
  })

  it('refuses a standalone battery camera even when the operator paid for the wake', () => {
    // `mark-stale` — the other half of a standalone battery camera — is not in
    // this function's domain at all: the timer returns before it, and the type
    // says so (`ClipPrefetchMode`). The scheduler test below is what proves it
    // never arrives, across four ticks.
    expect(decideClipPrefetch({ mode: 'forced-wake', hostBusy: false, quiet: false })).toEqual({
      kind: 'skip',
      reason: 'battery-wake-cost',
    })
  })

  it('yields to interactive work, and stays quiet after a refusal', () => {
    expect(decideClipPrefetch({ mode: 'direct', hostBusy: true, quiet: false })).toEqual({
      kind: 'skip',
      reason: 'host-busy',
    })
    expect(decideClipPrefetch({ mode: 'direct', hostBusy: false, quiet: true })).toEqual({
      kind: 'skip',
      reason: 'quiet-after-refusal',
    })
  })

  it('doubles the quiet period in INTERVALS, and caps it', () => {
    const interval = 30 * MINUTE
    expect([1, 2, 3, 4].map((n) => prefetchQuietMs(n, interval) / interval)).toEqual([2, 4, 8, 16])
    expect(prefetchQuietMs(40, interval)).toBe(PREFETCH_QUIET_MAX_MS)
  })
})

// ── the wiring ────────────────────────────────────────────────────────────

describe('the catalog refresh prefetches the stills for what it just read', () => {
  it('prefetches AFTER the refresh landed, on every tick, on a mains standalone', async () => {
    const h = harness()

    await h.scheduler.tick()
    h.advance(31 * MINUTE)
    await h.scheduler.tick()
    h.advance(31 * MINUTE)
    await h.scheduler.tick()

    // The order is load-bearing: a prefetch before the refresh would mint
    // stills for the catalog as it was, and the newest clips are the point.
    expect(h.trace).toEqual([
      'refresh:107',
      'prefetch:107',
      'refresh:107',
      'prefetch:107',
      'refresh:107',
      'prefetch:107',
    ])
  })

  it('prefetches a hub child too — the parent already has the socket open', async () => {
    const h = harness({ targets: [HUB_CHILD] })

    await h.scheduler.tick()

    expect(h.trace).toEqual(['refresh:3628', 'prefetch:3628'])
    const line = h.logger.infos.find((i) => i.message.includes('stills prefetched'))
    expect(line?.extras.tags).toEqual({ deviceId: 3628 })
    expect(line?.extras.meta?.mode).toBe('via-hub')
  })

  it('never asks a standalone battery camera, tick after tick after tick', async () => {
    const h = harness({ targets: [BATTERY_STANDALONE] })

    for (let i = 0; i < 4; i += 1) {
      await h.scheduler.tick()
      h.advance(31 * MINUTE)
    }

    // Four marks, zero reads, zero stills. A still is a login and a login is
    // the wake.
    expect(h.trace).toEqual(['markStale:106', 'markStale:106', 'markStale:106', 'markStale:106'])
    expect(h.prefetchStills).not.toHaveBeenCalled()
  })

  it('does not ride an authorised wake either — that wake bought the catalog', async () => {
    const h = harness({ targets: [BATTERY_FORCED] })

    await h.scheduler.tick()

    expect(h.trace).toEqual(['wake:106', 'refresh:106'])
    const line = h.logger.infos.find((i) => i.message.includes('prefetch skipped'))
    expect(line?.extras.tags).toEqual({ deviceId: 106 })
    expect(line?.extras.meta?.branch).toBe('prefetch-battery-wake-cost')
  })

  it('never prefetches against a catalog that could not be read', async () => {
    const h = harness({ refreshFails: true })

    await h.scheduler.tick()
    h.advance(31 * MINUTE)
    await h.scheduler.tick()

    expect(h.trace).toEqual(['refresh:107', 'markStale:107', 'refresh:107', 'markStale:107'])
    expect(h.prefetchStills).not.toHaveBeenCalled()
  })

  it('yields the lane to an operator who took it while the refresh ran', async () => {
    // The refresh itself passed the busy gate; the host went busy during it.
    // The decision is re-taken, because the refresh is not instantaneous.
    const busy = new Set<string>()
    const h = harness({
      busyHosts: busy,
      prefetch: () => landed(3),
    })
    // Deliberately not busy at the refresh gate, busy by the prefetch gate.
    const scheduler = h.scheduler
    h.refresh.mockImplementation(async (deviceId: number) => {
      h.trace.push(`refresh:${String(deviceId)}`)
      busy.add(MAINS_STANDALONE.hostKey)
    })

    await scheduler.tick()

    expect(h.trace).toEqual(['refresh:107'])
    const line = h.logger.infos.find((i) => i.message.includes('prefetch skipped'))
    expect(line?.extras.meta?.branch).toBe('prefetch-host-busy')
  })
})

// ── the thing the backoff exists to prevent ───────────────────────────────

describe('a prefetch that keeps meeting a refusing host backs away from it', () => {
  it('attempts on a DOUBLING ladder, not on every tick', async () => {
    // 618's real shape: every still times out after 30 s and answers
    // `camera-refused`, which is a timeout rather than a `400 rejected`, so
    // ClipThumbQueue's host backoff never arms. Without a ladder this is 16
    // attempts in 16 ticks, each 30 minutes of the host's lane, for ever.
    const h = harness({ prefetch: () => refused() })

    const attemptedAtTick: number[] = []
    for (let tick = 0; tick < 16; tick += 1) {
      const before = h.prefetchStills.mock.calls.length
      await h.scheduler.tick()
      if (h.prefetchStills.mock.calls.length > before) attemptedAtTick.push(tick)
      h.advance(31 * MINUTE)
    }

    // Tick 0, then a gap of 2 intervals, then 4, then 8 — four attempts in
    // sixteen ticks, and the refresh itself ran all sixteen times.
    expect(attemptedAtTick).toEqual([0, 2, 6, 14])
    expect(h.refresh).toHaveBeenCalledTimes(16)
    const warned = h.logger.warns.filter((w) => w.message.includes('prefetch stopped'))
    expect(warned.length).toBe(4)
    expect(warned[0]?.extras.tags).toEqual({ deviceId: 107 })
    expect(warned[0]?.extras.meta?.branch).toBe('prefetch-refused')
    expect(warned[0]?.extras.meta?.code).toBe('camera-refused')
  })

  it('forgets the ladder the moment a pass lands', async () => {
    let refuse = true
    const h = harness({ prefetch: () => (refuse ? refused() : landed(5)) })

    await h.scheduler.tick() // tick 0: refused, quiet for 2 intervals
    h.advance(31 * MINUTE)
    await h.scheduler.tick() // tick 1: quiet
    h.advance(31 * MINUTE)
    refuse = false
    await h.scheduler.tick() // tick 2: attempted, lands
    h.advance(31 * MINUTE)
    await h.scheduler.tick() // tick 3: attempted again — the ladder is gone
    h.advance(31 * MINUTE)
    await h.scheduler.tick() // tick 4

    expect(h.prefetchStills).toHaveBeenCalledTimes(4)
    expect(h.trace.filter((t) => t.startsWith('prefetch')).length).toBe(4)
  })

  it('treats a prefetch that THREW exactly as one that was refused', async () => {
    const h = harness({ prefetchThrows: true })

    const attemptedAtTick: number[] = []
    for (let tick = 0; tick < 8; tick += 1) {
      const before = h.prefetchStills.mock.calls.length
      await h.scheduler.tick()
      if (h.prefetchStills.mock.calls.length > before) attemptedAtTick.push(tick)
      h.advance(31 * MINUTE)
    }

    expect(attemptedAtTick).toEqual([0, 2, 6])
    expect(h.refresh).toHaveBeenCalledTimes(8)
    const line = h.logger.warns.find((w) => w.extras.meta?.branch === 'prefetch-failed')
    expect(line?.extras.tags).toEqual({ deviceId: 107 })
    expect(line?.extras.meta?.error).toBe('the still lane is gone')
  })
})
