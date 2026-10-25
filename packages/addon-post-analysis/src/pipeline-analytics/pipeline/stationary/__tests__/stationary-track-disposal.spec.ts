/**
 * A parked object is an ENTITY, not a track (D547).
 *
 * The operator: "Le entità devono esistere, solo le tracce stazionarie
 * persistite come tracce non sono necessarie, abbiamo comunque l'occupancy
 * salvata." [The entities must exist, only the stationary tracks persisted as tracks are not needed, we have the saved occupancy anyway.] So when the ledger promotes a candidate, the ≤ 2 tracks that
 * carried its evidence go — row, events, snapshots, thumbnails, vector — and
 * the ONE thing the entry vouches for, its key frame, stays and still
 * resolves. A deleted media row behind a surviving entry would be D400's
 * "names the reason" defect in reverse: an entity vouching for bytes that are
 * not there. That is the load-bearing assertion below, over the real stores.
 *
 * Measured cost this removes on device 102: 3.29 MB per parked-car track,
 * 58 such tracks on 2026-09-19 (~191 MB), plus 91 motionless fragments at
 * 3.23 MB (~294 MB) — the `expireStale` half in `track-store.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  type FakeSettingsStore,
  type FakeStorageProvider,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
} from '../../../__tests__/test-helpers.js'
import { MediaStore } from '../../../store/media-store.js'
import { TrackStore } from '../../../store/track-store.js'
import {
  disposeStationaryTracks,
  planStationaryTrackDisposal,
} from '../stationary-track-disposal.js'

const DEVICE_ID = 102
const T0 = 1_789_850_000_000

describe('planStationaryTrackDisposal — what goes and what the entity keeps', () => {
  it('names the live track and the persisted source track once each, and spares the entry key frame', () => {
    const plan = planStationaryTrackDisposal({
      trackIds: ['live', 'earlier'],
      entryKeyFrameMediaId: 42,
    })
    expect(plan.trackIds).toEqual(['live', 'earlier'])
    expect([...plan.keepMediaIds]).toEqual([42])
  })

  it('a source that IS the live track is not listed twice, and no key frame spares nothing', () => {
    const plan = planStationaryTrackDisposal({ trackIds: ['live', 'live'] })
    expect(plan.trackIds).toEqual(['live'])
    expect(plan.keepMediaIds.size).toBe(0)
  })
})

describe('disposeStationaryTracks — the tracks go, the entry still resolves its key frame', () => {
  let fake: FakeSettingsStore
  let storage: FakeStorageProvider
  let media: MediaStore
  let tracks: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    storage = makeFakeStorageProvider()
    media = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
    tracks = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await MediaStore.declare(fake.client)
    await TrackStore.declare(fake.client)
  })

  function upsert(trackId: string, timestamp: number): void {
    tracks.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'vehicle',
      timestamp,
      position: { x: 3248, y: 548, timestamp, bbox: { x: 3026, y: 346, w: 445, h: 405 } },
      zones: [],
      state: 'idle',
    })
  }

  async function putFor(
    trackId: string,
    kind: 'keyFrame' | 'thumbnail' | 'snapshot',
  ): Promise<number> {
    return media.put({
      deviceId: DEVICE_ID,
      ownerKind: 'track',
      ownerId: trackId,
      kind,
      timestamp: T0,
      data: Buffer.alloc(4_096, 1),
    })
  }

  it('deletes both tracks and every other media row, keeps the key frame the entry points at', async () => {
    // Session 1's track: persisted on its TTL, owns a snapshot.
    upsert('s1', T0)
    await tracks.closeActive('s1', 'stationary-promotion')
    const s1Snapshot = await putFor('s1', 'snapshot')
    // Session 2's track: still live when the ledger tipped, owns the key frame
    // the entry was born from, plus a thumbnail.
    upsert('s2', T0 + 600_000)
    const keyFrame = await putFor('s2', 'keyFrame')
    const s2Thumb = await putFor('s2', 'thumbnail')

    const plan = planStationaryTrackDisposal({
      trackIds: ['s2', 's1'],
      entryKeyFrameMediaId: keyFrame,
    })
    const cleaned: string[] = []
    const result = await disposeStationaryTracks(
      {
        deviceId: DEVICE_ID,
        entryId: 'entry-1',
        leaves: [],
        media,
        trackStore: tracks,
        onTrackCleanup: (_deviceId, trackId) => {
          cleaned.push(trackId)
        },
        logger: makeSilentLogger(),
      },
      plan,
    )

    expect(result.failed).toEqual([])
    expect(cleaned).toEqual(['s2', 's1'])
    // No track row survives, in either state.
    expect(tracks.getActiveByTrack('s2')).toBeNull()
    expect(await tracks.queryHistorical({ deviceId: DEVICE_ID })).toHaveLength(0)
    // The tracks' own media is gone …
    expect(await media.getById(s1Snapshot)).toBeNull()
    expect(await media.getById(s2Thumb)).toBeNull()
    // … and the entry's key frame is not: row AND bytes.
    const kept = await media.getById(keyFrame)
    expect(kept).not.toBeNull()
    expect(kept?.base64.length).toBeGreaterThan(0)
    expect(await media.listByOwner('track', 's2')).toHaveLength(1)
    expect(storage.files.size).toBe(1)
  })

  it('drops EVERY listed track from RAM — a still-active source never lands later as an empty row', async () => {
    // D683 fix round 1: the disposed track may be the SOURCE while the live
    // one is kept; it used to be dropped only when listed first.
    upsert('kept-live', T0)
    upsert('still-active-source', T0)
    const plan = planStationaryTrackDisposal({ trackIds: ['still-active-source'] })
    await disposeStationaryTracks(
      {
        deviceId: DEVICE_ID,
        entryId: 'entry-2',
        leaves: [],
        media,
        trackStore: tracks,
        onTrackCleanup: () => {},
        logger: makeSilentLogger(),
      },
      plan,
    )
    expect(tracks.getActiveByTrack('still-active-source')).toBeNull()
    expect(tracks.getActiveByTrack('kept-live')).not.toBeNull()
  })

  it('runs the alias leg LAST, past the media-sparing swap, widened (review H2)', async () => {
    upsert('s1', T0)
    const order: string[] = []
    const plan = planStationaryTrackDisposal({ trackIds: ['s1'] })
    await disposeStationaryTracks(
      {
        deviceId: DEVICE_ID,
        entryId: 'entry-3',
        leaves: [
          {
            deleteByTracks: async (ids) => {
              order.push(`leaf:${ids.join(',')}`)
              return []
            },
          },
        ],
        media,
        aliasLeg: {
          deleteByTracks: async (ids) => {
            order.push(`alias:${ids.join(',')}`)
            return [{ family: 'aliases', rows: ids.length, bytes: 0 }]
          },
        },
        trackStore: tracks,
        onTrackCleanup: () => {},
        logger: makeSilentLogger(),
        expandLeafIdsGrouped: async (ids) =>
          new Map(ids.map((id): [string, readonly string[]] => [id, [`${id}-straggler`]])),
      },
      plan,
    )
    // leaf, then media (sparingMedia has no logging here, it is exercised by
    // the test above), then the alias leg — always last, always widened.
    expect(order).toEqual(['leaf:s1,s1-straggler', 'alias:s1,s1-straggler'])
  })

  it('disposes TWO different source tracks without cross-contaminating their aliases (review L-R2)', async () => {
    upsert('s1', T0)
    upsert('s2', T0)
    const seenByTrack: string[][] = []
    const plan = planStationaryTrackDisposal({ trackIds: ['s1', 's2'] })
    await disposeStationaryTracks(
      {
        deviceId: DEVICE_ID,
        entryId: 'entry-4',
        leaves: [
          {
            deleteByTracks: async (ids) => {
              seenByTrack.push([...ids])
              return []
            },
          },
        ],
        media,
        trackStore: tracks,
        onTrackCleanup: () => {},
        logger: makeSilentLogger(),
        // s1 and s2 are DIFFERENT subjects (`sameChainAsLive: false`) with
        // their OWN aliases — a flat union shared between them would hand
        // s1's leaf a straggler that belongs to s2, and vice versa.
        expandLeafIdsGrouped: async (ids) =>
          new Map(ids.map((id): [string, readonly string[]] => [id, [`${id}-alias`]])),
      },
      plan,
    )
    // Each track's own cascade call sees ONLY its own widened alias.
    expect(seenByTrack).toEqual([
      ['s1', 's1-alias'],
      ['s2', 's2-alias'],
    ])
  })
})
