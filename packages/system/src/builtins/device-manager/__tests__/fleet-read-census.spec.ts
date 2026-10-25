/**
 * Who reads the whole fleet 4 149 times in a 66-second boot?
 *
 * The live profiler names `query device-manager:devices` with the shape
 * `SELECT … ORDER BY "deviceId" ASC LIMIT ?` — 4 149 calls, 4 219 533 rows, in
 * one boot window on 2026-08-25. The comment in `device-queries.ts` has said
 * "~3 000 for a 974-device boot" for weeks and names nobody.
 *
 * Two callers were read and EXCLUDED by hand (`device-manager.addon.ts`'s
 * `idToAddonId` warm and `device-bindings-store.ts`'s `getAllBindings`): both
 * are one-shots. That leaves the cap, and this repo has twice spent half a day
 * on an attribution deduced from the shape of the code and been wrong both
 * times. So: measure.
 *
 * ## Why an env var and not a debug action
 *
 * `pipeline-analytics`'s `StoreReadCensus` is armed through a `debug.*` custom
 * action, which is right for a steady-state mystery. It is useless here: the
 * storm happens DURING boot, and an action cannot be called before the process
 * that would answer it has started. The window therefore opens at construction,
 * from `CAMSTACK_FLEET_READ_CENSUS_MS`, and closes itself.
 *
 * ## Why it reports through the logger
 *
 * The hub's in-memory log ring holds ~35 minutes. A boot measurement read an
 * hour later is gone. Logging puts it in Loki, which carries 12 h+ — the same
 * correction that turned Task 0.2 from UNKNOWN into an answer.
 */
import { describe, expect, it, vi } from 'vitest'
import { FleetReadCensus } from '../fleet-read-census.js'

describe('FleetReadCensus — armed by construction, closes itself', () => {
  it('records nothing when the env var is absent', () => {
    const census = new FleetReadCensus(undefined, 1_000)

    expect(census.armed).toBe(false)
    census.record(census.siteOf(undefined, 1_100), 1_017)
    expect(census.rows()).toEqual([])
  })

  it('counts two reads from the SAME caller as one site with calls: 2', () => {
    const census = new FleetReadCensus('60000', 1_000)

    const readTwice = (): void => {
      census.record(census.siteOf(undefined, 1_100), 1_017)
      census.record(census.siteOf(undefined, 1_100), 1_017)
    }
    readTwice()

    const rows = census.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.calls).toBe(2)
    expect(rows[0]?.rows).toBe(2_034)
  })

  it('separates callers — that is the entire point', () => {
    const census = new FleetReadCensus('60000', 1_000)

    const callerA = (): void => census.record(census.siteOf(undefined, 1_100), 10)
    const callerB = (): void => census.record(census.siteOf(undefined, 1_100), 20)
    callerA()
    callerB()

    const sites = new Set(census.rows().map((r) => r.site))
    expect(sites.size).toBe(2)
  })

  it('a read issued while armed is kept even if the window closes first', () => {
    // The site is captured when the call STARTS. A read that began inside the
    // window belongs to it — otherwise a slow read at the edge would be
    // attributed to nobody, and the slow ones are the interesting ones.
    const census = new FleetReadCensus('60000', 1_000)
    const site = census.siteOf(undefined, 1_100)

    census.closeAt(61_001)
    census.record(site, 5)

    expect(census.rows()).toHaveLength(1)
  })

  it('refuses a window longer than the cap — a diagnostic left on is a tax', () => {
    const census = new FleetReadCensus(String(24 * 3_600_000), 1_000)

    expect(census.windowMs).toBeLessThanOrEqual(FleetReadCensus.MAX_WINDOW_MS)
  })

  it('a non-numeric env value disarms rather than defaulting to on', () => {
    // Fail closed: an env var someone fat-fingered must not silently install a
    // stack capture on the fleet read path forever.
    expect(new FleetReadCensus('yes please', 1_000).armed).toBe(false)
    expect(new FleetReadCensus('0', 1_000).armed).toBe(false)
    expect(new FleetReadCensus('-5', 1_000).armed).toBe(false)
  })

  it('reports sorted by call count, busiest first', () => {
    const census = new FleetReadCensus('60000', 1_000)
    const quiet = (): void => census.record(census.siteOf(undefined, 1_100), 1)
    const loud = (): void => {
      for (let i = 0; i < 5; i++) census.record(census.siteOf(undefined, 1_100), 1)
    }
    quiet()
    loud()

    const rows = census.rows()
    expect(rows[0]?.calls).toBe(5)
  })

  it('logs the report once when asked, with the per-minute rate', () => {
    const census = new FleetReadCensus('60000', 1_000)
    const busy = (): void => census.record(census.siteOf(undefined, 1_100), 1_017)
    busy()

    const info = vi.fn()
    census.report({ info } as unknown as Parameters<typeof census.report>[0], 31_000)

    expect(info).toHaveBeenCalledTimes(1)
    const meta = info.mock.calls[0]?.[1] as { meta?: { rows?: unknown[] } }
    expect(meta.meta?.rows).toHaveLength(1)
  })
})

describe('the site is captured before any await', () => {
  // The 2026-08-26 boot census named `listAll` and could not name its caller,
  // because `siteOf()` sat below an `await`. An await severs the synchronous
  // stack: everything above it collapses into `processTicksAndRejections`, and
  // the one frame that answers the question is the one that disappears.
  it('never reports a microtask frame as the caller', async () => {
    const census = new FleetReadCensus('60000', 1_000)

    const realCaller = async (): Promise<void> => {
      const site = census.siteOf(undefined, 1_100)
      await Promise.resolve()
      census.record(site, 1)
    }
    await realCaller()

    const site = census.rows()[0]?.site ?? ''
    expect(site).not.toContain('processTicksAndRejections')
    expect(site).toContain('realCaller')
  })
})

describe('an explicit site wins over the stack — the cap-channel caller', () => {
  // The 5 001-call, nothing-above-`listAll` row in the 2026-08-26 boot census
  // is not a stack-depth problem: every frame between the UDS socket read and
  // `DeviceRowStore.list` is the SAME generic dispatcher code
  // (`onUnownedCall`, `dispatch`, `invoke`) no matter which addon called, so
  // deeper capture would never name it. The caller's identity is DATA
  // (`CapCallInput.callerAddonId`, captured off the registered `childId` at
  // `LocalChildRegistry`) and travels as an explicit string, not a frame.
  it('formats the caller id as `addon:<id>` instead of walking the stack', () => {
    const census = new FleetReadCensus('60000', 1_000)

    // A generic dispatcher function — its OWN name must never leak into the
    // attribution when a caller id is supplied, proving the stack walk was
    // skipped entirely rather than merely outscored.
    const genericCapDispatcher = (): string | null => census.siteOf('pipeline-analytics', 1_100)

    const site = genericCapDispatcher()
    expect(site).toBe('addon:pipeline-analytics')
  })

  it('still returns null while disarmed, even with a caller id supplied', () => {
    // Constraint 1: armed=false must cost nothing and record nothing —
    // passing a caller id must not bypass the window check, and the
    // `addon:` template must never be built while disarmed.
    const census = new FleetReadCensus(undefined, 1_000)

    expect(census.siteOf('pipeline-analytics', 1_100)).toBeNull()
  })
})
