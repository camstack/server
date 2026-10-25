/**
 * The cache behind the `deviceState` gate.
 *
 * Every test here is about a failure that would be SILENT in production: a rule
 * that keeps firing because a state went stale, or stops firing because one
 * transient read failed. The gate's whole value is that the operator can trust
 * what it says, so the cache has to be explicit about when it does not know.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { MAX_AGE_MS, NcDeviceStateCache } from '../device-state-cache.js'

const T0 = 1_800_000_000_000

function makeCache(
  readStates: (ids: readonly number[]) => Promise<ReadonlyMap<number, string>>,
  clock: { now: number },
): NcDeviceStateCache {
  return new NcDeviceStateCache({
    logger: makeSilentLogger(),
    readStates,
    now: () => clock.now,
  })
}

describe('NcDeviceStateCache', () => {
  it('a COLD cache knows nothing — a gated rule does not fire before the first read', async () => {
    const clock = { now: T0 }
    const cache = makeCache(async () => new Map([[42, 'armed_away']]), clock)
    cache.setWatched([42])
    expect(cache.get(42)).toBeUndefined()
  })

  it('serves the state after a refresh', async () => {
    const clock = { now: T0 }
    const cache = makeCache(async () => new Map([[42, 'armed_away']]), clock)
    cache.setWatched([42])
    await cache.refresh()
    expect(cache.get(42)).toBe('armed_away')
  })

  it('a device that DISAPPEARS reads undefined, not its previous value', async () => {
    // Keeping the last-known state would let a rule stay armed by an alarm that
    // has been gone for hours.
    const clock = { now: T0 }
    let answer = new Map([[42, 'armed_away']])
    const cache = makeCache(async () => answer, clock)
    cache.setWatched([42])
    await cache.refresh()
    expect(cache.get(42)).toBe('armed_away')

    answer = new Map()
    await cache.refresh()
    expect(cache.get(42)).toBeUndefined()
  })

  it('a FAILED refresh keeps the previous states — one transient must not un-gate everything', async () => {
    const clock = { now: T0 }
    let fail = false
    const cache = makeCache(async () => {
      if (fail) throw new Error('node unreachable')
      return new Map([[42, 'armed_away']])
    }, clock)
    cache.setWatched([42])
    await cache.refresh()

    fail = true
    await cache.refresh()
    expect(cache.get(42)).toBe('armed_away')
  })

  it('…but a SUSTAINED failure ages out — states stop counting past MAX_AGE_MS', async () => {
    // The other half of the trade: keeping them forever is the silent failure.
    const clock = { now: T0 }
    const cache = makeCache(async () => new Map([[42, 'armed_away']]), clock)
    cache.setWatched([42])
    await cache.refresh()
    expect(cache.get(42)).toBe('armed_away')

    clock.now = T0 + MAX_AGE_MS + 1
    expect(cache.get(42)).toBeUndefined()
  })

  it('never throws out of refresh — the evaluation tick must survive a bad read', async () => {
    const clock = { now: T0 }
    const cache = makeCache(async () => {
      throw new Error('boom')
    }, clock)
    cache.setWatched([42])
    await expect(cache.refresh()).resolves.toBeUndefined()
  })

  it('watches only what some rule references, deduped and sorted', () => {
    const clock = { now: T0 }
    const cache = makeCache(async () => new Map(), clock)
    cache.setWatched([9, 3, 9, 3, 7])
    expect(cache.watched()).toEqual([3, 7, 9])
  })

  it('reads nothing at all when no rule is gated', async () => {
    const clock = { now: T0 }
    const readStates = vi.fn(async () => new Map<number, string>())
    const cache = makeCache(readStates, clock)
    cache.setWatched([])
    await cache.refresh()
    expect(readStates).not.toHaveBeenCalled()
  })

  /**
   * The 30-second gate lag. The panel is in THIS process; the refresh tick is
   * not the fastest thing that knows what it did.
   */
  describe('an in-process note', () => {
    it('answers IMMEDIATELY, before any refresh has ever run', () => {
      const clock = { now: T0 }
      const cache = makeCache(async () => new Map(), clock)
      cache.setWatched([1023])
      cache.note(1023, 'disarmed')
      expect(cache.get(1023)).toBe('disarmed')
    })

    it('outranks a refreshed state that has gone stale in the meantime', async () => {
      const clock = { now: T0 }
      const cache = makeCache(async () => new Map([[1023, 'armed_away']]), clock)
      cache.setWatched([1023])
      await cache.refresh()
      expect(cache.get(1023)).toBe('armed_away')
      // The operator disarms. No tick has run; the gate must already agree.
      cache.note(1023, 'disarmed')
      expect(cache.get(1023)).toBe('disarmed')
    })

    it('ages out on the same window, so a silent panel falls back to the tick', async () => {
      const clock = { now: T0 }
      const cache = makeCache(async () => new Map([[1023, 'armed_away']]), clock)
      cache.setWatched([1023])
      cache.note(1023, 'disarmed')
      clock.now = T0 + MAX_AGE_MS + 1
      await cache.refresh()
      expect(cache.get(1023)).toBe('armed_away')
    })
  })
})
