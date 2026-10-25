/**
 * Deterministic order for a tied `updatedAt` (D681, fix round 1 L3). The
 * store's `orderBy` names only `updatedAt`; two rows written in the same
 * millisecond can come back in whatever order the engine happens to give
 * them, and the tracking-bench export (`bundle.ts`) needs the SAME bytes for
 * an unchanged store. `id` is the tiebreak.
 *
 * Disarm: drop the `.toSorted(...)` tiebreak from `listFor` (return `out`
 * unsorted) — this test must fail, since it seeds the tied rows in the
 * REVERSE of id order.
 */
import { describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { TrackRelationsStore } from '../track-relations-store.js'

function relation(
  id: string,
  updatedAt: number,
): Parameters<TrackRelationsStore['putRelation']>[0] {
  return {
    id,
    deviceId: 101,
    leftTrackId: `left-${id}`,
    rightTrackId: `right-${id}`,
    leftSide: null,
    rightSide: null,
    relation: 'same-subject',
    presence: null,
    leftStartedAt: null,
    rightStartedAt: null,
    createdAt: updatedAt,
    updatedAt,
    author: null,
  }
}

describe('TrackRelationsStore — tied updatedAt', () => {
  it('breaks a tie on updatedAt by id, regardless of insertion order', async () => {
    const { ledgers } = await makeAnalyticsWorld()
    const store = new TrackRelationsStore({
      logger: makeSilentLogger(),
      relationsLedger: ledgers.trackRelations,
      purityLedger: ledgers.trackPurity,
    })
    // Inserted in DESCENDING id order, same `updatedAt`: only an explicit
    // tiebreak puts them back in ascending order.
    await store.putRelation(relation('r-zzz', 1_000))
    await store.putRelation(relation('r-aaa', 1_000))
    const relations = await store.relationsForDevice(101, 10)
    expect(relations.map((r) => r.id)).toEqual(['r-aaa', 'r-zzz'])
  })
})
