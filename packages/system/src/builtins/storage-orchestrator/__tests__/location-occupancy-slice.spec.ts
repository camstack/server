/**
 * Per-location occupancy (D388) — and the one distinction the whole feature
 * exists to protect: a location nobody reports for is UNKNOWN, never zero.
 */
import type { IScopedLogger, IStorageOccupancyProvider } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { LocationOccupancySlice } from '../location-occupancy-slice.js'

function makeLogger(): IScopedLogger {
  const noop = (): void => undefined
  const logger = {
    debug: noop,
    info: noop,
    warn: vi.fn(),
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger as unknown as IScopedLogger
}

const IDS = ['recordings:default', 'eventMedia:default', 'backups:nas'] as const

function provider(
  reports: ReadonlyArray<{ locationId: string; ownedBytes: number; measuredAtMs: number }>,
): IStorageOccupancyProvider {
  return { getOccupancy: async () => Promise.resolve(reports) }
}

describe('unknown is not zero', () => {
  it('a location nobody reported for has NO figure at all', async () => {
    const slice = new LocationOccupancySlice({
      logger: makeLogger(),
      getProviders: () => [
        provider([{ locationId: 'recordings:default', ownedBytes: 900, measuredAtMs: 10 }]),
      ],
      locationIds: () => IDS,
      now: () => 100,
    })
    await slice.refresh()
    expect(slice.ownedFor('recordings:default')).toEqual({ bytes: 900, measuredAtMs: 10 })
    // Not `{ bytes: 0 }`. A UI must be able to omit the segment.
    expect(slice.ownedFor('eventMedia:default')).toBeUndefined()
    expect(slice.ownedFor('backups:nas')).toBeUndefined()
  })

  it('a provider that THROWS leaves its locations unknown, not empty', async () => {
    const logger = makeLogger()
    const failing: IStorageOccupancyProvider = {
      getOccupancy: async () => {
        throw new Error('addon is down')
      },
    }
    const slice = new LocationOccupancySlice({
      logger,
      getProviders: () => [
        failing,
        provider([{ locationId: 'backups:nas', ownedBytes: 42, measuredAtMs: 5 }]),
      ],
      locationIds: () => IDS,
      now: () => 100,
    })
    await slice.refresh()
    expect(slice.ownedFor('recordings:default')).toBeUndefined()
    // The healthy provider's answer survives the failing one.
    expect(slice.ownedFor('backups:nas')).toEqual({ bytes: 42, measuredAtMs: 5 })
    // A branch that DROPS work says so.
    expect(vi.mocked(logger.warn)).toHaveBeenCalled()
  })
})

describe('merging several owners of one location', () => {
  it('sums the bytes and reports the OLDEST measurement', async () => {
    const slice = new LocationOccupancySlice({
      logger: makeLogger(),
      getProviders: () => [
        provider([{ locationId: 'recordings:default', ownedBytes: 100, measuredAtMs: 900 }]),
        provider([{ locationId: 'recordings:default', ownedBytes: 25, measuredAtMs: 300 }]),
      ],
      locationIds: () => IDS,
      now: () => 1_000,
    })
    await slice.refresh()
    // The figure is only as fresh as its stalest part, and it says so.
    expect(slice.ownedFor('recordings:default')).toEqual({ bytes: 125, measuredAtMs: 300 })
  })
})

describe('serve-and-revalidate — a read never waits (D224)', () => {
  it('the first read answers EMPTY and kicks a refresh', async () => {
    let calls = 0
    const slice = new LocationOccupancySlice({
      logger: makeLogger(),
      getProviders: () => {
        calls += 1
        return [provider([{ locationId: 'recordings:default', ownedBytes: 7, measuredAtMs: 1 }])]
      },
      locationIds: () => IDS,
      now: () => 1_000,
    })
    // Unknown, immediately — no await, no fan-out in the caller's path.
    expect(slice.ownedFor('recordings:default')).toBeUndefined()
    slice.serveAndRevalidate()
    await slice.refresh()
    expect(calls).toBeGreaterThan(0)
    expect(slice.ownedFor('recordings:default')).toEqual({ bytes: 7, measuredAtMs: 1 })
  })

  it('a fresh slice is not refreshed again inside the window', async () => {
    let now = 1_000
    let calls = 0
    const slice = new LocationOccupancySlice({
      logger: makeLogger(),
      getProviders: () => {
        calls += 1
        return []
      },
      locationIds: () => IDS,
      now: () => now,
      staleAfterMs: 60_000,
    })
    await slice.refresh()
    const after = calls
    now = 1_500
    slice.serveAndRevalidate()
    slice.serveAndRevalidate()
    expect(calls).toBe(after)

    now = 100_000
    slice.serveAndRevalidate()
    await slice.refresh()
    expect(calls).toBeGreaterThan(after)
  })

  it('a read never JOINS a refresh in flight', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: IStorageOccupancyProvider = {
      getOccupancy: async () => {
        await gate
        return [{ locationId: 'recordings:default', ownedBytes: 3, measuredAtMs: 1 }]
      },
    }
    const slice = new LocationOccupancySlice({
      logger: makeLogger(),
      getProviders: () => [slow],
      locationIds: () => IDS,
      now: () => 1_000,
    })
    const inFlight = slice.refresh()
    // The read is answered from the slice — empty included — while the refresh
    // is still out. This is the property that keeps `listLocations` off the
    // critical path of a dead addon.
    expect(slice.ownedFor('recordings:default')).toBeUndefined()
    slice.serveAndRevalidate()
    release()
    await inFlight
    expect(slice.ownedFor('recordings:default')).toEqual({ bytes: 3, measuredAtMs: 1 })
  })
})
