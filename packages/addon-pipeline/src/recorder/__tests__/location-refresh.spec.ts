/**
 * `LocationRefresher` — when the recorder re-resolves its storage locations.
 *
 * The failure it exists to end (D387): an operator added a second `recordings`
 * location in the admin UI and the recorder never noticed, because
 * `refreshLocations()` was reachable only from boot, the storage-migration
 * path and a hand-called `rescanStorage`.
 *
 * Two properties, and the second is the one that matters:
 *
 *   - a burst of doorbells spends ONE refresh (a bulk edit rings once per row,
 *     and a refresh is a `listLocations` plus a `resolve` per location);
 *   - a doorbell that is never delivered costs LATENCY, never blindness. The
 *     event is telemetry and may be dropped (D8/D11), so the backstop converges
 *     with no events at all.
 */
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocationRefresher } from '../addon/location-refresh.js'

function makeLogger(): IScopedLogger {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  logger.withTags.mockReturnValue(logger)
  // Documented type boundary: the refresher calls only `info` and `warn`.
  return logger as unknown as IScopedLogger
}

interface Harness {
  readonly refresher: LocationRefresher
  readonly logger: IScopedLogger
  readonly refreshes: () => number
  advance: (ms: number) => void
}

function makeHarness(refresh?: () => Promise<void>): Harness {
  let clock = 1_000_000
  let calls = 0
  const logger = makeLogger()
  const refresher = new LocationRefresher({
    logger,
    now: () => clock,
    debounceMs: 2_000,
    backstopMs: 300_000,
    refresh: async () => {
      calls += 1
      if (refresh) await refresh()
    },
  })
  return {
    refresher,
    logger,
    refreshes: () => calls,
    advance: (ms: number) => {
      clock += ms
      vi.advanceTimersByTime(ms)
    },
  }
}

describe('LocationRefresher — the doorbell', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-resolves once a location change is announced', async () => {
    const h = makeHarness()
    h.refresher.ring('recordings:recordings-high-4tb', 'upsert')
    expect(h.refreshes()).toBe(0)

    h.advance(2_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(h.refreshes()).toBe(1)
  })

  it('COALESCES a bulk change: ten doorbells spend one refresh, not ten', async () => {
    const h = makeHarness()
    for (let i = 0; i < 10; i += 1) h.refresher.ring(`recordings:disk-${String(i)}`, 'upsert')

    h.advance(2_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(h.refreshes()).toBe(1)
  })

  it('a refresh that FAILS is announced and does not wedge the next one', async () => {
    let fail = true
    const h = makeHarness(async () => {
      if (fail) throw new Error('listLocations timed out')
    })
    h.refresher.ring('recordings:default', 'upsert')
    h.advance(2_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(h.logger.warn).toHaveBeenCalled()

    fail = false
    h.refresher.ring('recordings:default', 'upsert')
    h.advance(2_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(h.refreshes()).toBe(2)
  })

  it('says so out loud — a silent re-resolve reads as "nothing happened"', () => {
    const h = makeHarness()
    h.refresher.ring('recordings:recordings-high-4tb', 'upsert')
    expect(h.logger.info).toHaveBeenCalled()
  })
})

describe('LocationRefresher — the backstop converges without any event (D8/D11)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes on the periodic path when NO doorbell ever arrives', async () => {
    const h = makeHarness()
    // The very first convergence check refreshes: nothing has been resolved by
    // this object yet, and "unknown" must not be served as "current".
    await h.refresher.convergeIfDue()
    expect(h.refreshes()).toBe(1)

    // Well inside the window: the pass runs every 30 s and must not re-resolve
    // on every one of them.
    h.advance(30_000)
    await h.refresher.convergeIfDue()
    expect(h.refreshes()).toBe(1)

    h.advance(300_000)
    await h.refresher.convergeIfDue()
    expect(h.refreshes()).toBe(2)
  })

  it('a doorbell resets the backstop clock — the two paths never both pay', async () => {
    const h = makeHarness()
    h.refresher.ring('recordings:default', 'upsert')
    h.advance(2_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.refreshes()).toBe(1)

    h.advance(60_000)
    await h.refresher.convergeIfDue()
    expect(h.refreshes()).toBe(1)
  })

  it('stops ringing once disposed', async () => {
    const h = makeHarness()
    h.refresher.ring('recordings:default', 'upsert')
    h.refresher.dispose()
    h.advance(2_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.refreshes()).toBe(0)

    h.advance(600_000)
    await h.refresher.convergeIfDue()
    expect(h.refreshes()).toBe(0)
  })
})
