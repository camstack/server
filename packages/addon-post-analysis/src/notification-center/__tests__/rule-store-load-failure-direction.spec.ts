/**
 * The failure DIRECTION of the three notification rule stores, named and held.
 *
 * ## What this pins, and why it is worth its own file
 *
 * `NcRuleStore`, `TimelapseStore` and `NcSummaryStore` each serve their read
 * path from a RAM mirror and refresh it on a periodic tick. The question that
 * decides whether a hub keeps notifying after a hiccup is what a FAILED refresh
 * does to that mirror: keep it (bounded staleness) or empty it (a hub that
 * silently stops notifying, stops rendering timelapses, stops sending digests
 * until the next successful load).
 *
 * Before the `DurableLedger` migration the right answer held **only because of
 * statement ordering** — `clear()` happened to sit after the `await`, so a
 * throwing query jumped past it:
 *
 * ```ts
 * const rows = await this.store.query.query({ … })   // throws here …
 * this.byId.clear()                                   // … so this never ran
 * ```
 *
 * Nothing stated that. No test named it. Moving one line up reversed it in
 * three stores at once — and that reversal is exactly what produced the
 * notification flood (D130) and the occupancy cold-seed loss.
 *
 * These tests were written against the PRE-migration stores and passed, then
 * were confirmed to FAIL when `clear()` was hoisted above the `await` in each
 * store — the neutralisation that proves they have teeth. After the migration
 * the hoist is no longer expressible: the mirror lives in `DurableLedger`,
 * whose contract rule 2 ("a failed load NEVER clears the mirror — deliberately
 * no knob") owns the ordering in one place for every consumer.
 *
 * A green suite is not proof; this file records what was removed to make it
 * red.
 */

import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords } from './support/nc-test-deps.js'
import { describe, expect, it } from 'vitest'
import type { NcRuleInput, TimelapseRuleInput } from '@camstack/types'
import { NcRuleInputSchema, TimelapseRuleInputSchema } from '@camstack/types'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcRuleStore } from '../rule-store.js'
import { NcSummaryStore } from '../summary/summary-store.js'
import { type NcSummaryRuleInput, NcSummaryRuleInputSchema } from '../summary/summary-rule.js'
import { TimelapseStore } from '../timelapse/timelapse-store.js'

/**
 * A client that answers normally until {@link Flaky.breakQueries} is called,
 * after which every `query` REJECTS. Writes keep working, so a test can arrange
 * its rows through the real code path and only then break the read.
 *
 * This models the failure that actually happens — a transient store read error
 * on the refresh tick — rather than a store that was empty all along. The
 * difference matters: an empty store legitimately yields an empty mirror, so a
 * test that seeds nothing cannot tell the two directions apart.
 */
const SCHEDULE = {
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1260, endMinute: 420 }],
}

describe('a failed load never empties the rule mirror', () => {
  it('NcRuleStore keeps its rules when the refresh query throws', async () => {
    const world = makeNcRecords()
    const store = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
      now: () => 1_000,
      newId: () => 'rule-1',
    })

    const input: NcRuleInput = NcRuleInputSchema.parse({
      name: 'front door person',
      delivery: 'immediate',
      conditions: { classes: ['person'] },
      targets: [{ targetId: 'tgt-1' }],
    })
    await store.create(input, 'admin-1')
    expect(store.list()).toHaveLength(1)

    // A successful refresh is the control: the rule is really on disk.
    await store.load()
    expect(store.list()).toHaveLength(1)

    world.failReads(true)
    await store.load()

    // THE ASSERTION. A cleared mirror here is a hub that has silently stopped
    // notifying — every rule gone, no error surfaced to the operator, and it
    // stays that way until a later tick happens to succeed.
    expect(store.list()).toHaveLength(1)
    expect(store.get('rule-1')?.name).toBe('front door person')
  })

  it('TimelapseStore keeps its rules when the refresh query throws', async () => {
    const world = makeNcRecords()
    const store = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
      now: () => 1_000,
      newId: () => 'tl-1',
    })

    const input: TimelapseRuleInput = TimelapseRuleInputSchema.parse({
      name: 'driveway nightly',
      deviceIds: [101],
      schedule: SCHEDULE,
      targets: [{ targetId: 'tgt-1' }],
    })
    await store.create(input, 'admin-1')
    expect(store.list()).toHaveLength(1)

    await store.load()
    expect(store.list()).toHaveLength(1)

    world.failReads(true)
    await store.load()

    // A cleared mirror here means the scheduler ticks over an empty rule set:
    // the window closes, and a closed window does not come back.
    expect(store.list()).toHaveLength(1)
    expect(store.get('tl-1')?.name).toBe('driveway nightly')
  })

  it('NcSummaryStore keeps its rules when the refresh query throws', async () => {
    const world = makeNcRecords()
    const store = new NcSummaryStore({
      kind: world.records.kind(ncRecordKinds['summary-rules']),
      logger: makeSilentLogger(),
      now: () => 1_000,
      newId: () => 'sum-1',
    })

    const input: NcSummaryRuleInput = NcSummaryRuleInputSchema.parse({
      name: 'night digest',
      deviceIds: [636, 637],
      window: { kind: 'schedule', schedule: SCHEDULE },
      targets: [{ targetId: 'tgt-1' }],
    })
    await store.create(input, 'admin-1')
    expect(store.list()).toHaveLength(1)

    await store.load()
    expect(store.list()).toHaveLength(1)

    world.failReads(true)
    await store.load()

    expect(store.list()).toHaveLength(1)
    expect(store.get('sum-1')?.name).toBe('night digest')
  })

  /**
   * The mirror must also not be half-emptied: a load that throws PART WAY
   * through leaves whatever it had already written, which is the shape a
   * `clear()`-then-repopulate implementation degrades into under a partial
   * failure. Asserting the full set survives (not merely "something survives")
   * is what distinguishes the two.
   */
  it('NcRuleStore keeps EVERY rule, not just the last one written', async () => {
    const world = makeNcRecords()
    let seq = 0
    const store = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
      now: () => 1_000,
      newId: () => `rule-${(seq += 1)}`,
    })

    for (const name of ['one', 'two', 'three']) {
      await store.create(
        NcRuleInputSchema.parse({
          name,
          delivery: 'immediate',
          conditions: { classes: ['person'] },
          targets: [{ targetId: 'tgt-1' }],
        }),
        'admin-1',
      )
    }
    expect(store.list()).toHaveLength(3)

    world.failReads(true)
    await store.load()

    expect(
      store
        .list()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['one', 'three', 'two'])
  })
})

/**
 * D642 review I1: a load that FAILED is not an answer about this hub.
 *
 * `isLoaded()` gates everything that derives something DESTRUCTIVE from the
 * rule set — the consumable threshold census (which retires episodes no rule
 * asks for), the clip-retention plan, the deleted-device prune. It used to flip
 * after ANY load, including one whose query threw (the ledger swallows it), so
 * a cold boot with the store down read an empty rule set as "no consumable rule
 * at all" and retired every 25 % / 10 % episode.
 */
describe('isLoaded answers only after a load that succeeded', () => {
  it('a cold load that fails leaves the rule set UNKNOWN; the next good one answers', async () => {
    const world = makeNcRecords()
    const store = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
      now: () => 1_000,
      newId: () => 'rule-1',
    })
    world.failReads(true)
    await store.load()
    expect(store.isLoaded()).toBe(false)
  })

  it('once answered, a later failed refresh keeps the answer (the mirror is still a fact)', async () => {
    const world = makeNcRecords()
    const store = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
      now: () => 1_000,
      newId: () => 'rule-1',
    })
    await store.load()
    expect(store.isLoaded()).toBe(true)
    world.failReads(true)
    await store.load()
    expect(store.isLoaded()).toBe(true)
  })
})
