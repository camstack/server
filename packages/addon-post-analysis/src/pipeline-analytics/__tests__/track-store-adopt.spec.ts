/**
 * Spec §6.2 step 3: two ACTIVE rows merge in RAM; every field of the row has
 * a declared merge rule, and the merge IS the table (review M7).
 *
 * Disarms (each alone, restored):
 *  - in `mergeActiveTracks`, skip one key of `TRACK_MERGE_KEYS` (e.g. `debugNote`):
 *    "the table drives the merge, field by field" fails;
 *  - drop `downsampleTrail` from the `positions` rule: "a merged trail is capped" fails;
 *  - make the `bestEventId` rule return the survivor's: "the best event follows the higher importance" fails;
 *  - let `adopt` accept a row whose `active` flag is false (`!survivor?.active`
 *    → `survivor === undefined`): "refuses a survivor mid-persist" fails
 *    (review M1 — `expireStale` sets `active = false` and holds the row in
 *    `this.active` for the whole `persistCompleted` await; a closed-and-
 *    REMOVED row is already caught by plain existence, which is what "never
 *    reopens a closed track" actually tests);
 *  - in `movedProbe`'s rule, drop the "either side moved" check: "the moved
 *    verdict wins" fails;
 *  - in `keptAtPromotion`'s rule, return the survivor's own value instead of
 *    "either kept": "kept if either piece was kept" fails;
 *  - (D683 Task 18, T16 L5) drop `gapDistance` from the `totalDistance` rule:
 *    "the distance walked across the gap…" fails.
 */
import type { SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { probeMoved } from '../pipeline/stationary/promotion-plan.js'
import { TRACK_MERGE_KEYS, TRACK_MERGE_RULES, mergeActiveTracks } from '../store/track-merge.js'
import { TrackStore } from '../store/track-store.js'
import { makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'
import {
  MOVED_PROBE,
  STILL_PROBE,
  buildTrackStoreForTest,
  fullRow,
  sighting,
} from './track-store-test-helpers.js'

const ctx = { maxPositionHistory: 300 }

describe('TrackStore.adopt', () => {
  it('every field of an active row has a merge rule', () => {
    const store = buildTrackStoreForTest()
    const row = store.upsert(sighting('A', 1000, 100))
    for (const key of Object.keys(row)) {
      expect([key, (TRACK_MERGE_KEYS as readonly string[]).includes(key)]).toEqual([key, true])
    }
  })

  it('the table drives the merge, field by field', () => {
    // Every optional field is populated on both rows, so a key the merge
    // forgets shows up as `undefined` against its rule's value.
    const a = fullRow('A', { importance: 3, debugNote: 'cane?' })
    const b = fullRow('B', { importance: 5, debugNote: 'gatto' })
    const merged = mergeActiveTracks(a, b, ctx)
    for (const key of TRACK_MERGE_KEYS) {
      expect([key, merged[key]]).toEqual([key, TRACK_MERGE_RULES[key](a, b, ctx)])
    }
    expect(merged.debugNote).toBe('cane? · gatto')
  })

  it('merges positions in time, widens the span, unions zones and classes', () => {
    const store = buildTrackStoreForTest()
    store.upsert(sighting('A', 1000, 100, { zones: ['Uscio'] }))
    store.upsert(sighting('A', 1100, 110))
    store.upsert(sighting('B', 7000, 130, { zones: ['Aiuola'] }))
    expect(store.adopt('A', 'B')).toBe(true)
    const a = store.getActiveByTrack('A')
    expect(a?.positions.map((p) => p.timestamp)).toEqual([1000, 1100, 7000])
    expect([a?.firstSeen, a?.lastSeen]).toEqual([1000, 7000])
    expect([...(a?.zonesVisited ?? [])].sort()).toEqual(['Aiuola', 'Uscio'])
    expect(store.getActiveByTrack('B')).toBeNull()
  })

  it('a merged trail is capped by the same rule as a live one', () => {
    const a = fullRow('A', { positionsAt: Array.from({ length: 200 }, (_, i) => i * 100) })
    const b = fullRow('B', { positionsAt: Array.from({ length: 200 }, (_, i) => 30_000 + i * 100) })
    const merged = mergeActiveTracks(a, b, ctx)
    expect(merged.positions.length).toBeLessThanOrEqual(300)
    expect(merged.positions.at(-1)?.timestamp).toBe(30_000 + 199 * 100)
  })

  it('the best event follows the higher importance, with its reason', () => {
    const a = fullRow('A', { importance: 2, bestEventId: 'ev-a', importanceReason: 'entered' })
    const b = fullRow('B', { importance: 7, bestEventId: 'ev-b', importanceReason: 'face' })
    const merged = mergeActiveTracks(a, b, ctx)
    expect([merged.importance, merged.bestEventId, merged.importanceReason]).toEqual([
      7,
      'ev-b',
      'face',
    ])
  })

  it('an identity on the absorbed piece reaches the survivor; a shared audio label sums its count', () => {
    const a = fullRow('A', {
      label: undefined,
      audio: { bark: { count: 2, peakScore: 0.6, firstAt: 100, lastAt: 900 } },
    })
    const b = fullRow('B', {
      label: 'Alice',
      audio: { bark: { count: 3, peakScore: 0.8, firstAt: 7000, lastAt: 8000 } },
    })
    const merged = mergeActiveTracks(a, b, ctx)
    expect(merged.label).toBe('Alice')
    expect(merged.audioLabels?.get('bark')).toEqual({
      count: 5,
      peakScore: 0.8,
      firstAt: 100,
      lastAt: 8000,
    })
  })

  it('the moved verdict wins — either piece having moved makes the merged subject moved', () => {
    const neverMoved = mergeActiveTracks(
      fullRow('A', { movedProbe: STILL_PROBE }),
      fullRow('B', { movedProbe: STILL_PROBE }),
      ctx,
    )
    expect(probeMoved(neverMoved.movedProbe)).toBe(false)

    const survivorMoved = mergeActiveTracks(
      fullRow('A', { movedProbe: MOVED_PROBE }),
      fullRow('B', { movedProbe: STILL_PROBE }),
      ctx,
    )
    expect(probeMoved(survivorMoved.movedProbe)).toBe(true)

    const absorbedMoved = mergeActiveTracks(
      fullRow('A', { movedProbe: STILL_PROBE }),
      fullRow('B', { movedProbe: MOVED_PROBE }),
      ctx,
    )
    expect(probeMoved(absorbedMoved.movedProbe)).toBe(true)
  })

  it('kept if either piece was kept at a stationary promotion', () => {
    const neither = mergeActiveTracks(fullRow('A', {}), fullRow('B', {}), ctx)
    expect(neither.keptAtPromotion).toBeUndefined()

    const survivorKept = mergeActiveTracks(
      fullRow('A', { keptAtPromotion: true }),
      fullRow('B', {}),
      ctx,
    )
    expect(survivorKept.keptAtPromotion).toBe(true)

    const absorbedKept = mergeActiveTracks(
      fullRow('A', {}),
      fullRow('B', { keptAtPromotion: true }),
      ctx,
    )
    expect(absorbedKept.keptAtPromotion).toBe(true)
  })

  it('the distance walked across the gap is part of the merged distance (T16 L5, D683 Task 18)', () => {
    // A's trail ends at x=100 (t=100); B's starts at x=5000 (t=5000). The
    // subject walked those 4900 px unseen — summing the two pieces alone
    // would say it never did.
    const a = fullRow('A', { positionsAt: [0, 100], totalDistance: 100 })
    const b = fullRow('B', { positionsAt: [5000, 5100], totalDistance: 100 })
    expect(mergeActiveTracks(a, b, ctx).totalDistance).toBe(100 + 100 + 4900)
    // Pieces that OVERLAP in time have no gap to add.
    const c = fullRow('C', { positionsAt: [50, 6000], totalDistance: 7 })
    expect(mergeActiveTracks(a, c, ctx).totalDistance).toBe(100 + 7)
  })

  it('never reopens a closed track', async () => {
    const store = buildTrackStoreForTest()
    store.upsert(sighting('A', 1000, 100))
    await store.expireStale(1000 + 60_000)
    store.upsert(sighting('B', 70_000, 100))
    expect(store.adopt('A', 'B')).toBe(false)
    expect(store.getActiveByTrack('B')).not.toBeNull()
  })

  it('refuses a survivor mid-persist — expireStale holds the row active:false while persistCompleted is in flight', async () => {
    // review M1: `expireStale` sets `t.active = false`, then AWAITS the
    // persisted write with the row STILL in `this.active` (deleted only once
    // the write settles). An `adopt` landing in that window would merge B
    // into a row about to be deleted out from under it — B dropped from the
    // map, its data lost, the persisted row never seeing it. Gate the fake
    // store's `set` so the window is observable.
    let releasePersist: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releasePersist = resolve
    })
    const fake = makeFakeSettingsStore()
    const gatedClient: SettingsStoreClient = {
      ...fake.client,
      set: {
        mutate: async (input: { collection: string; key: string; value: unknown }) => {
          await gate
          return fake.client.set.mutate(input)
        },
      },
    }
    const store = new TrackStore({ store: gatedClient, logger: makeSilentLogger() })
    store.upsert(sighting('A', 1000, 100))
    store.upsert(sighting('B', 70_000, 100))
    // Started, not awaited: runs synchronously up to the gated `set.mutate`,
    // then suspends there — `this.active.get('A')` is `active: false` but
    // still present.
    const expiring = store.expireStale(1000 + 60_000)
    expect(store.adopt('A', 'B')).toBe(false)
    releasePersist?.()
    await expiring
  })
})
