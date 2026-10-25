/**
 * A track that MOVED and was then promoted CLOSES and is KEPT (D683 round 4,
 * operator 2026-09-30) — through the REAL track store and the close-time
 * predicate the addon wires (`isKnownParked` = `bboxMatchesParkedEntry` over
 * the registry's live entries), with the promotion executor the addon calls.
 *
 * Review C1: the kept track stops receiving upserts (the registry suppresses
 * its subject), and at its TTL its last box IS the box the entry was born
 * from — so D547's close-time "known parked" discard cascaded it 30 s later,
 * and without a discard sink it was stamped `stationary-promotion` and hidden
 * from the feed. Neither is "closes normally".
 *
 * Review M1 (why the store keeps the judgement incrementally): the stored
 * trail is downsampled, and after a long dwell a whole walk-in survives in it
 * as ONE box — the trail alone can no longer tell it from a truncated first box.
 *
 * Disarms (each alone, restored):
 *  - in `TrackStore.expireStale`, ignore `keptAtPromotion`: "a walker that sat
 *    down is persisted at its TTL, never discarded as parked" and "…never
 *    stamped" fail;
 *  - in `executePromotionEffects`, skip `markKept`: the same two tests fail;
 *  - in `TrackStore.upsert`, stop stepping the probe on a matched sighting:
 *    "the store remembers a walk-in the downsampled trail has forgotten" fails;
 *  - in `TrackStore.promotionPlanOf`, answer from the trail
 *    (`planPromotion(positions)`): the same test fails.
 *
 * Fix round 2 (review R2) — a PERSISTED source keeps its verdict:
 *  - in `cloneTrack`, drop `moved`: "a source persisted after a long dwell
 *    still says it moved" fails;
 *  - in `rowToTrack`, read an absent `moved` as `false`: "a row from before
 *    the verdict is left alone" fails;
 *  - in `planForPersistedSource`, judge the row's trail
 *    (`planPromotion(positions)`): "a source persisted after a long dwell"
 *    fails;
 *  - read an absent verdict as never-moved: "a row from before the verdict
 *    is left alone" fails.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Track } from '@camstack/types'

import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../../__tests__/test-helpers.js'
import { TRACKS_COLLECTION, TrackStore } from '../../../store/track-store.js'
import {
  executePromotionEffects,
  planForPersistedSource,
  planPromotion,
  planPromotionEffects,
} from '../promotion-plan.js'
import { bboxMatchesParkedEntry } from '../stationary-match.js'

const DEVICE_ID = 103
const T0 = 1_790_000_000_000
const SEAT = { x: 416, y: 1112, w: 1014, h: 565 }
const ENTRY = { className: 'person', bbox: SEAT, frameWidth: 3840, frameHeight: 2160 }

describe('a promoted track that moved closes normally', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  function sight(trackId: string, i: number, bbox: typeof SEAT): void {
    const timestamp = T0 + i * 150
    store.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'person',
      timestamp,
      position: { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2, timestamp, bbox },
      zones: [],
      state: 'moving',
    })
  }

  /** 103: the operator walks in from the door (10 boxes), then sits (n boxes). */
  function walkThenSit(trackId: string, seated: number): number {
    for (let i = 0; i < 10; i++) sight(trackId, i, { ...SEAT, x: 2400 - i * 200 })
    for (let i = 10; i < 10 + seated; i++) sight(trackId, i, SEAT)
    return T0 + (10 + seated) * 150
  }

  function sitThroughout(trackId: string, n: number): number {
    for (let i = 0; i < n; i++) sight(trackId, i, SEAT)
    return T0 + n * 150
  }

  /** The promotion, as the addon runs it for a live track and no source. */
  async function promote(trackId: string, markKept = true): Promise<void> {
    const live = store.promotionPlanOf(trackId)
    if (live === null) throw new Error('no active row')
    await executePromotionEffects(planPromotionEffects({ liveTrackId: trackId, live }), {
      markKept: (id) => {
        if (markKept) store.markKeptAtPromotion(id)
      },
      beforeDispose: Promise.resolve(),
      dispose: async () => {},
    })
  }

  const isKnownParked = (t: Pick<Track, 'positions' | 'className'>): boolean => {
    const last = t.positions.at(-1)?.bbox
    return last !== undefined && bboxMatchesParkedEntry(last, t.className, [ENTRY])
  }

  it('a walker that sat down is persisted at its TTL, never discarded as parked', async () => {
    const lastSeen = walkThenSit('walker', 120)
    expect(store.promotionPlanOf('walker')?.dropReason).toBe('stationary')
    await promote('walker')
    const discarded: string[] = []

    const expired = await store.expireStale(lastSeen + 60_000, {
      isKnownParked,
      onDiscard: (t) => {
        discarded.push(t.trackId)
      },
    })

    expect(discarded).toEqual([])
    expect(expired.map((t) => t.trackId)).toEqual(['walker'])
    const rows = await store.queryHistorical({ deviceId: DEVICE_ID })
    expect(rows.map((r) => r.trackId)).toEqual(['walker'])
    // Closed normally: no early-close marker, so the feed and the digest see it.
    expect(rows[0]?.closedReason).toBeUndefined()
  })

  it('…and a caller without a discard sink does not stamp it stationary-promotion', async () => {
    const lastSeen = walkThenSit('walker', 120)
    await promote('walker')

    await store.expireStale(lastSeen + 60_000, { isKnownParked })

    const rows = await store.queryHistorical({ deviceId: DEVICE_ID })
    expect(rows[0]?.closedReason).toBeUndefined()
  })

  it('premise: the same walker NOT marked kept is discarded as a parked re-sighting', async () => {
    const lastSeen = walkThenSit('walker', 120)
    await promote('walker', false)
    const discarded: string[] = []

    const expired = await store.expireStale(lastSeen + 60_000, {
      isKnownParked,
      onDiscard: (t) => {
        discarded.push(t.trackId)
      },
    })

    expect(expired).toEqual([])
    expect(discarded).toEqual(['walker'])
  })

  it('a subject sitting there from its first box is not kept — D547 disposes it', async () => {
    sitThroughout('sitter', 130)
    expect(store.promotionPlanOf('sitter')).toEqual({
      dropReason: 'dropped',
      disposeLiveTrack: true,
    })
  })

  it('the store remembers a walk-in the downsampled trail has forgotten', () => {
    // A long dwell: the trail fills and halves its older part again and again.
    walkThenSit('long-dwell', 3_000)
    const trail = store.getActiveByTrack('long-dwell')?.positions ?? []
    const walkInLeft = trail.filter((p) => p.bbox.x !== SEAT.x).length
    // The walk-in is down to its first box — the trail alone says "never moved" …
    expect(walkInLeft).toBeLessThan(3)
    expect(planPromotion(trail.map((p) => p.bbox)).dropReason).toBe('dropped')
    // … the store, which judged every box as it arrived, still knows it moved.
    expect(store.promotionPlanOf('long-dwell')?.dropReason).toBe('stationary')
  })

  it('an unknown or expired track has no plan', () => {
    expect(store.promotionPlanOf('nobody')).toBeNull()
    expect(store.markKeptAtPromotion('nobody')).toBe(false)
  })

  it('a source persisted after a long dwell still says it moved — and is kept', async () => {
    const lastSeen = walkThenSit('source', 3_000)
    await store.expireStale(lastSeen + 60_000)
    const full = await store.getPersistedByTrackId('source')
    expect(full?.moved).toBe(true)
    // The trail it carries has forgotten the walk-in …
    expect(planPromotion((full?.positions ?? []).map((p) => p.bbox)).dropReason).toBe('dropped')
    // … the verdict has not: a promotion keeps it.
    expect(planForPersistedSource(full)).toEqual({
      dropReason: 'stationary',
      disposeLiveTrack: false,
    })
    const slim = await store.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim[0]?.moved).toBe(true)
  })

  it('a source that sat there throughout is persisted as not moved — and disposed', async () => {
    const lastSeen = sitThroughout('sitter', 40)
    // No discard sink is passed: the row lands.
    await store.expireStale(lastSeen + 60_000)
    const row = await store.getPersistedByTrackId('sitter')
    expect(row?.moved).toBe(false)
    expect(planForPersistedSource(row)?.disposeLiveTrack).toBe(true)
  })

  it('a row from before the verdict is left alone — never disposed as "never moved"', async () => {
    await fake.client.set.mutate({
      collection: TRACKS_COLLECTION,
      key: 'legacy',
      value: { deviceId: DEVICE_ID, className: 'person', firstSeen: T0, lastSeen: T0 + 1 },
    })
    const row = await store.getPersistedByTrackId('legacy')
    expect(row).not.toBeNull()
    expect(row?.moved).toBeUndefined()
    expect(planForPersistedSource(row)).toBeNull()
  })

  it('a source with no row at all is disposed as before (its leftovers go)', () => {
    expect(planForPersistedSource(null)?.disposeLiveTrack).toBe(true)
  })
})
