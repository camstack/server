/**
 * `handleStoreCensusAction` is what `debug.storeCensus` dispatches to — kept
 * as a pure function (census + logger + input in, response out) so it is
 * testable without booting `RecorderV2Addon`'s full `onInitialize`.
 */
import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { handleStoreCensusAction, MAX_CENSUS_SITES } from '../debug-actions.js'
import { StoreReadCensus } from '../store/read-census.js'

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  return logger as unknown as IScopedLogger
}

describe('handleStoreCensusAction', () => {
  it('arms the census and returns an empty, unmeasured response', () => {
    const census = new StoreReadCensus()
    const result = handleStoreCensusAction(census, silentLogger(), { armMs: 60_000 })
    expect(result).toEqual({ armed: true, elapsedMs: 0, sites: 0, calls: 0, rows: [] })
    expect(census.armed).toBe(true)
  })

  it('armMs omitted READS the window instead of re-arming (which would clear it)', () => {
    const clock = { t: 1_000 }
    const now = (): number => clock.t
    const census = new StoreReadCensus(now)
    census.arm(60_000)
    const read = (): void => {
      census.record('get', census.siteOf(read), null)
    }
    read()
    clock.t += 30_000

    const result = handleStoreCensusAction(census, silentLogger(), {})

    expect(result.armed).toBe(true)
    expect(result.sites).toBe(1)
    expect(result.calls).toBe(1)
    expect(result.rows[0]).toMatchObject({ op: 'get', calls: 1, rows: 0 })
    // perMin extrapolated from the 30s elapsed, not from CENSUS_MAX_WINDOW_MS.
    expect(result.rows[0]?.perMin).toBe(2)
  })

  it('armMs: 0 also reads rather than re-arming', () => {
    const census = new StoreReadCensus()
    census.arm(60_000)
    const read = (): void => {
      census.record('get', census.siteOf(read), [1])
    }
    read()
    const result = handleStoreCensusAction(census, silentLogger(), { armMs: 0 })
    expect(result.calls).toBe(1)
  })

  it('caps the returned rows at `limit`, defaulting to MAX_CENSUS_SITES', () => {
    const census = new StoreReadCensus()
    census.arm(60_000)
    for (let i = 0; i < 3; i += 1) {
      const read = (): void => {
        census.record('get', `site-${i}`, null)
      }
      read()
    }
    const result = handleStoreCensusAction(census, silentLogger(), { limit: 2 })
    expect(result.rows).toHaveLength(2)
    expect(result.sites).toBe(3)
  })

  it('a disarmed census with no prior window reads as zero, not an error', () => {
    const census = new StoreReadCensus()
    const result = handleStoreCensusAction(census, silentLogger(), {})
    expect(result).toEqual({ armed: false, elapsedMs: 0, sites: 0, calls: 0, rows: [] })
    expect(MAX_CENSUS_SITES).toBeGreaterThan(0)
  })
})
