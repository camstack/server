/**
 * D683 review H2/H3/N3: every production cascade path widens through the
 * alias collection — a row still keyed by an absorbed id (`B`) is reached
 * when its SURVIVOR (`A`) is deleted, through the booted addon, not a
 * hand-built registry or a bare module call. Pinned here:
 *  - `deleteTracks`, `pruneTracksBefore`, `cascadeDiscardedTracks` (the
 *    brief's named "wherever" examples, plus the D547 discard path — the
 *    three callers that share `buildTrackCascadeRegistry` wholesale);
 *  - `disposePromotedTracks` → `disposeStationaryTracks` (review N3: the
 *    `index.ts` WIRING of `aliasLeg`/`expandLeafIdsGrouped` into the
 *    stationary disposal — `stationary-track-disposal.spec.ts` pins the
 *    FUNCTION, not this call site);
 *  - the `TrackCloser`'s zero-media suppression (review N3: the `index.ts`
 *    WIRING of `aliasStore`/`expandLeafIds` into the `TrackCloser` deps —
 *    `pipeline/__tests__/delete-track-cascade.spec.ts` pins `cascadeDeleteTrack`
 *    itself, not this call site).
 *
 * Disarms (each alone, restored — all in `index.ts`):
 *  - drop `aliasStore: this.trackAliasStore` from `buildTrackCascadeRegistry`'s
 *    `stores` (so the alias leg itself is absent from the registry) AND empty
 *    every `cascade.expandLeafIdsGrouped` spread (`deleteTracks`,
 *    `pruneTracksBefore`, `cascadeDiscardedTracks`): the first three tests
 *    fail — B's event/media rows survive the cascade;
 *  - drop `aliasLeg`/`expandLeafIdsGrouped` from the `disposeStationaryTracks`
 *    deps built in `disposePromotedTracks`: the disposal test fails;
 *  - drop `aliasStore`/`expandLeafIds` from the `TrackCloser` construction's
 *    deps (the zero-media path): the suppression test fails.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { StationaryEntry } from '../pipeline/stationary/stationary-types.js'
import { TrackCloser } from '../pipeline/track-close.js'
import { OBJECT_EVENTS_COLLECTION } from '../store/event-store.js'
import { MEDIA_COLLECTION } from '../store/media-store.js'
import { TrackAliasStore } from '../store/track-alias-store.js'
import { TRACKS_COLLECTION } from '../store/track-store.js'
import { bootAnalytics, type Booted } from './boot-analytics.js'

const DEVICE_ID = 933

function trackAliasStoreOf(booted: Booted): TrackAliasStore {
  const store: unknown = Reflect.get(booted.addon, 'trackAliasStore')
  if (!(store instanceof TrackAliasStore)) throw new Error('trackAliasStore not built')
  return store
}

/** Seed one event row and one media row owned by the ABSORBED id `B`, plus a
 *  persisted track row for the SURVIVOR `A`. */
function seedSurvivorAndAbsorbedRows(booted: Booted): void {
  booted.settings.seed(OBJECT_EVENTS_COLLECTION, [
    { id: 'ev-b', data: { trackId: 'B', deviceId: DEVICE_ID, timestamp: 1_000 } },
  ])
  booted.settings.seed(MEDIA_COLLECTION, [
    {
      id: 'm-b',
      data: {
        deviceId: DEVICE_ID,
        ownerKind: 'track',
        ownerId: 'B',
        kind: 'thumbnail',
        timestamp: 1_000,
        path: '',
        sizeBytes: 0,
      },
    },
  ])
  booted.settings.seed(TRACKS_COLLECTION, [
    {
      id: 'A',
      data: {
        deviceId: DEVICE_ID,
        className: 'person',
        firstSeen: 1_000,
        lastSeen: 1_000,
        retrainStatus: 'none',
      },
    },
  ])
}

function eventRowGone(booted: Booted): boolean {
  return !booted.settings.data.get(OBJECT_EVENTS_COLLECTION)?.has('ev-b')
}
function mediaRowGone(booted: Booted): boolean {
  return !booted.settings.data.get(MEDIA_COLLECTION)?.has('m-b')
}
function aliasRowGone(booted: Booted): boolean {
  // The alias is a `track-aliases` records kind on every node, not a table.
  return booted.records.tables.get('track-aliases')?.has('B') !== true
}

describe('every production cascade path reaches rows left under an absorbed id', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('deleteTracks(A) removes the event/media rows B left behind, and the alias itself', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    await trackAliasStoreOf(booted).record(DEVICE_ID, 'B', 'A', 1_000)
    seedSurvivorAndAbsorbedRows(booted)

    await booted.addon.deleteTracks({ deviceId: DEVICE_ID, trackIds: ['A'] })

    expect(eventRowGone(booted), 'event row owned by B').toBe(true)
    expect(mediaRowGone(booted), 'media row owned by B').toBe(true)
    expect(aliasRowGone(booted), 'the alias row itself').toBe(true)
  })

  it('pruneTracksBefore(A) removes the same straggler rows', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    await trackAliasStoreOf(booted).record(DEVICE_ID, 'B', 'A', 1_000)
    seedSurvivorAndAbsorbedRows(booted)

    await booted.addon.pruneTracksBefore({ deviceId: DEVICE_ID, cutoffMs: 2_000 })

    expect(eventRowGone(booted), 'event row owned by B').toBe(true)
    expect(mediaRowGone(booted), 'media row owned by B').toBe(true)
    expect(aliasRowGone(booted), 'the alias row itself').toBe(true)
  })

  it('cascadeDiscardedTracks(A) — the D547 scenery-discard path — removes the same straggler rows', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    await trackAliasStoreOf(booted).record(DEVICE_ID, 'B', 'A', 1_000)
    seedSurvivorAndAbsorbedRows(booted)

    const cascadeDiscardedTracks: unknown = Reflect.get(booted.addon, 'cascadeDiscardedTracks')
    if (typeof cascadeDiscardedTracks !== 'function') {
      throw new Error('cascadeDiscardedTracks not found')
    }
    await cascadeDiscardedTracks.call(booted.addon, [{ deviceId: DEVICE_ID, trackId: 'A' }])

    expect(eventRowGone(booted), 'event row owned by B').toBe(true)
    expect(mediaRowGone(booted), 'media row owned by B').toBe(true)
    expect(aliasRowGone(booted), 'the alias row itself').toBe(true)
  })

  it('disposePromotedTracks(A) — the D547 never-moved disposal path — removes the same straggler rows', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    await trackAliasStoreOf(booted).record(DEVICE_ID, 'B', 'A', 1_000)
    seedSurvivorAndAbsorbedRows(booted)

    const disposePromotedTracks: unknown = Reflect.get(booted.addon, 'disposePromotedTracks')
    if (typeof disposePromotedTracks !== 'function') {
      throw new Error('disposePromotedTracks not found')
    }
    const entry: StationaryEntry = {
      id: 'entry-1',
      deviceId: DEVICE_ID,
      className: 'person',
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      frameWidth: 640,
      frameHeight: 480,
      firstSeenAt: 1_000,
      becameStationaryAt: 1_000,
      lastConfirmedAt: 1_000,
    }
    await disposePromotedTracks.call(booted.addon, DEVICE_ID, entry, ['A'])

    expect(eventRowGone(booted), 'event row owned by B').toBe(true)
    expect(mediaRowGone(booted), 'media row owned by B').toBe(true)
    expect(aliasRowGone(booted), 'the alias row itself').toBe(true)
  })

  it("the TrackCloser's zero-media suppression of A removes the same straggler rows", async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    await trackAliasStoreOf(booted).record(DEVICE_ID, 'B', 'A', 1_000)
    seedSurvivorAndAbsorbedRows(booted)

    const closer: unknown = Reflect.get(booted.addon, 'trackCloser')
    if (!(closer instanceof TrackCloser)) throw new Error('trackCloser not built')
    await closer.suppressZeroMedia(DEVICE_ID, 'A')

    expect(eventRowGone(booted), 'event row owned by B').toBe(true)
    expect(mediaRowGone(booted), 'media row owned by B').toBe(true)
    expect(aliasRowGone(booted), 'the alias row itself').toBe(true)
  })
})
