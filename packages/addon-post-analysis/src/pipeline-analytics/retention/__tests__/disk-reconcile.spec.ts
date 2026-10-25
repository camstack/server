/**
 * Disk-wins reconcile — after a recordings wipe the SQLite index still holds
 * ghost tracks/events/media. The track is the primary index: a row whose
 * blobs are gone is deleted, including favourited and staging pins (those
 * pins are against age retention, not against a missing file).
 *
 * Enrolled gallery media (`identity` / `vehicle` / `scene`) is never probed.
 */
import { describe, expect, it } from 'vitest'
import { FACE_MEDIA_OWNER_PREFIX, PLATE_MEDIA_OWNER_PREFIX } from '../../store/media-store.js'
import {
  emptyEventIds,
  eventMediaKey,
  emptyTrackIds,
  reconcileDeviceFromDisk,
  shouldProbeMediaRow,
  trackIdFromMediaOwner,
  type DiskReconcileDeps,
  type MediaIndexRow,
} from '../disk-reconcile.js'

describe('shouldProbeMediaRow', () => {
  it('skips enrolled gallery owner kinds', () => {
    expect(shouldProbeMediaRow('identity')).toBe(false)
    expect(shouldProbeMediaRow('vehicle')).toBe(false)
    expect(shouldProbeMediaRow('scene')).toBe(false)
  })

  it('probes track / motion / object / audio / face / plate rows', () => {
    expect(shouldProbeMediaRow('track')).toBe(true)
    expect(shouldProbeMediaRow('motion')).toBe(true)
    expect(shouldProbeMediaRow('object')).toBe(true)
    expect(shouldProbeMediaRow('audio')).toBe(true)
    expect(shouldProbeMediaRow('face')).toBe(true)
    expect(shouldProbeMediaRow('plate')).toBe(true)
  })
})

describe('trackIdFromMediaOwner', () => {
  it('maps track / face / plate owners back to a track id', () => {
    expect(trackIdFromMediaOwner('track', 't-1')).toBe('t-1')
    expect(trackIdFromMediaOwner('face', `${FACE_MEDIA_OWNER_PREFIX}t-1`)).toBe('t-1')
    expect(trackIdFromMediaOwner('plate', `${PLATE_MEDIA_OWNER_PREFIX}t-1`)).toBe('t-1')
  })

  it('does not treat event or gallery owners as tracks', () => {
    expect(trackIdFromMediaOwner('motion', 'e-1')).toBeNull()
    expect(trackIdFromMediaOwner('identity', 'id-1')).toBeNull()
  })
})

describe('emptyTrackIds', () => {
  it('includes favourited and staging tracks that have no remaining files', () => {
    expect(emptyTrackIds(['fav', 'staging', 'live'], new Set(['live']))).toEqual(['fav', 'staging'])
  })

  it('keeps a track that still has a blob', () => {
    expect(emptyTrackIds(['t-1'], new Set(['t-1']))).toEqual([])
  })
})

describe('emptyEventIds', () => {
  it('drops trackless events with no remaining file, including those that never had media', () => {
    expect(
      emptyEventIds(
        [
          { table: 'motion', id: 'lost' },
          { table: 'audio', id: 'never' },
        ],
        new Set(),
      ),
    ).toEqual([
      { table: 'motion', id: 'lost' },
      { table: 'audio', id: 'never' },
    ])
  })

  it('keeps a trackless event whose snapshot is still on disk', () => {
    expect(
      emptyEventIds(
        [
          { table: 'motion', id: 'kept' },
          { table: 'motion', id: 'gone' },
        ],
        new Set([eventMediaKey('motion', 'kept')]),
      ),
    ).toEqual([{ table: 'motion', id: 'gone' }])
  })

  it('is keyed by (ownerKind, ownerId) — a motion blob does not speak for an audio row', () => {
    // D474 made event ids per-table rowid aliases, so `audio:5` and
    // `motion:5` are different rows. Keyed by id alone, one surviving motion
    // blob kept every same-numbered audio event alive (D480).
    expect(
      emptyEventIds([{ table: 'audio', id: '5' }], new Set([eventMediaKey('motion', '5')])),
    ).toEqual([{ table: 'audio', id: '5' }])
  })
})

// A media row's own id is a rowid (D482) — arbitrary and unrelated to owner
// or kind. `path` defaults from it purely for readability in these fixtures.
function row(over: Partial<MediaIndexRow> & Pick<MediaIndexRow, 'mediaId'>): MediaIndexRow {
  return {
    ownerKind: 'track',
    ownerId: 't-1',
    path: `${over.mediaId}.jpg`,
    location: 'eventMedia',
    ...over,
  }
}

function engine(input: {
  rows: readonly MediaIndexRow[]
  existing: readonly string[]
  trackIds: readonly string[]
  motionIds?: readonly string[]
  audioIds?: readonly string[]
}): {
  deps: DiskReconcileDeps
  deletedMediaIds: number[]
  deletedTracks: string[]
  deletedEvents: string[]
} {
  const deletedMediaIds: number[] = []
  const deletedTracks: string[] = []
  const deletedEvents: string[] = []
  const existing = new Set(input.existing)
  const remaining = () => input.rows.filter((r) => !deletedMediaIds.includes(r.mediaId))
  const deps: DiskReconcileDeps = {
    pageMedia: async (_deviceId, offset, limit) => remaining().slice(offset, offset + limit),
    blobExists: async (location, relativePath) => existing.has(`${location}:${relativePath}`),
    deleteMediaId: async (mediaId) => {
      deletedMediaIds.push(mediaId)
    },
    listTrackIds: async () => input.trackIds,
    listTracklessEventIds: async () => ({
      motion: input.motionIds ?? [],
      audio: input.audioIds ?? [],
    }),
    deleteTracks: async (ids) => {
      deletedTracks.push(...ids)
      return { deleted: ids.length }
    },
    deleteEvents: async (refs) => {
      deletedEvents.push(...refs.map((r) => `${r.table}:${r.id}`))
    },
  }
  return { deps, deletedMediaIds, deletedTracks, deletedEvents }
}

describe('reconcileDeviceFromDisk', () => {
  it('drops missing media rows and cascades tracks that have no files left, including favourited', async () => {
    const { deps, deletedMediaIds, deletedTracks } = engine({
      rows: [
        row({ mediaId: 201, ownerId: 'fav' }),
        row({ mediaId: 202, ownerId: 'live', path: 'live.jpg' }),
        row({
          mediaId: 203,
          ownerKind: 'identity',
          ownerId: 'person-1',
          path: 'missing-identity.jpg',
        }),
      ],
      existing: ['eventMedia:live.jpg'],
      trackIds: ['fav', 'live'],
    })

    const counts = await reconcileDeviceFromDisk(deps, 108)

    expect(deletedMediaIds).toEqual([201])
    expect(deletedTracks).toEqual(['fav'])
    expect(counts).toEqual({ mediaDropped: 1, tracks: 1, events: 0 })
  })

  it('does not probe enrolled gallery blobs even when the file is gone', async () => {
    const { deps, deletedMediaIds, deletedTracks } = engine({
      rows: [
        row({
          mediaId: 301,
          ownerKind: 'scene',
          ownerId: 's-1',
          path: 'gone-scene.jpg',
        }),
      ],
      existing: [],
      trackIds: [],
    })

    await reconcileDeviceFromDisk(deps, 1)
    expect(deletedMediaIds).toEqual([])
    expect(deletedTracks).toEqual([])
  })

  it('deletes trackless motion/audio with no file on disk, including rows that never owned media', async () => {
    const { deps, deletedMediaIds, deletedEvents } = engine({
      rows: [row({ mediaId: 401, ownerKind: 'motion', ownerId: 'm-lost', path: 'm-lost.jpg' })],
      existing: [],
      trackIds: [],
      motionIds: ['m-lost', 'm-never'],
      audioIds: ['a-never'],
    })

    const counts = await reconcileDeviceFromDisk(deps, 7)
    // Media by INTEGER id (D482); events carry the TABLE they belong to
    // (D480) — post-D474 every audio id is also a motion id, so an event ref
    // without its table deleted an unrelated episode next door.
    expect(deletedMediaIds).toEqual([401])
    expect(deletedEvents).toEqual(['motion:m-lost', 'motion:m-never', 'audio:a-never'])
    expect(counts.events).toBe(3)
  })

  it('keeps a trackless event whose snapshot blob is still on disk', async () => {
    const { deps, deletedEvents } = engine({
      rows: [row({ mediaId: 501, ownerKind: 'motion', ownerId: 'm-keep', path: 'm-keep.jpg' })],
      existing: ['eventMedia:m-keep.jpg'],
      trackIds: [],
      motionIds: ['m-keep', 'm-never'],
    })

    const counts = await reconcileDeviceFromDisk(deps, 7)
    expect(deletedEvents).toEqual(['motion:m-never'])
    expect(counts.events).toBe(1)
  })

  it('keeps a track that still has a face crop on disk', async () => {
    const { deps, deletedTracks } = engine({
      rows: [
        row({
          mediaId: 601,
          ownerKind: 'face',
          ownerId: `${FACE_MEDIA_OWNER_PREFIX}t-1`,
          path: 'face.jpg',
        }),
      ],
      existing: ['eventMedia:face.jpg'],
      trackIds: ['t-1'],
    })

    await reconcileDeviceFromDisk(deps, 1)
    expect(deletedTracks).toEqual([])
  })
})
