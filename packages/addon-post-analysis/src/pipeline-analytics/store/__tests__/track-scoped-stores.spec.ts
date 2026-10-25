import { FACE_ARCFACE_INDEX } from '../../store/embedding-vector-index.js'
/**
 * Per-store `deleteByTracks` unit tests — track-centric retention cascade
 * (STORE layer). Each store that holds track-scoped rows implements the
 * `TrackScopedStore` contract (`deleteByTracks(ids)`); these specs assert:
 *
 *  - eventStore: deletes the tracks' object events AND folds in the deletion of
 *    their event-owned media (via the injected media deleter); paged; per-track
 *    isolated.
 *  - mediaStore: deletes `ownerKind:'track'` + `ownerKind:'face'` crops of the
 *    tracks, NEVER `ownerKind:'identity'` (enrolled). Plate crops are deferred.
 *  - faceStore: deletes rows `WHERE trackId IN ids AND assigned = false` —
 *    ENROLLED (assigned) faces survive.
 *  - objectEmbeddingStore: deletes the per-track CLIP vector (id === trackId).
 *
 * CRITICAL invariants covered: enrolled/`assigned` faces are never deleted;
 * `identity`-owned media is never deleted; per-track failure is isolated.
 */

import {
  eventStoreLedgers,
  type FakeRecords,
  kindRows,
  makeAnalyticsRecords,
  seedLedgerRows,
} from '../../__tests__/fake-records.js'
import type { SettingsStoreClient } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testFaceSeedRow } from '../../../__tests__/support/face-seed.js'
import {
  makeFakeEmbeddingIndex,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeFakeVectorStore,
  makeSilentLogger,
  type FakeSettingsStore,
  type FakeStorageProvider,
} from '../../__tests__/test-helpers.js'
import {
  type EventOwnedMediaDeleter,
  EventStore,
  OBJECT_EVENTS_COLLECTION,
} from '../event-store.js'
import type { EventLedgerCollection } from '../event-ledger-collection.js'
import { wireFaceLedger } from '../event-ledger-wiring.js'
import { FaceStore } from '../face-store.js'
import {
  FACE_MEDIA_OWNER_PREFIX,
  MEDIA_COLLECTION,
  MediaStore,
  PLATE_MEDIA_OWNER_PREFIX,
} from '../media-store.js'
import { ObjectEmbeddingStore } from '../object-embedding-store.js'
import { testClipRegistry } from '../../__tests__/fixtures/clip-test-registry.js'

// ── Raw record builders ─────────────────────────────────────────────

interface RawRecord {
  id: string
  data: Record<string, unknown>
}

function rawObjectForTrack(id: string, trackId: string): RawRecord {
  return {
    id,
    data: {
      deviceId: 1,
      timestamp: 1000,
      trackId,
      className: 'person',
      confidence: 0.9,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      zones: [],
      state: 'new',
    },
  }
}

function rawMedia(id: string, ownerKind: string, ownerId: string, path: string): RawRecord {
  return {
    id,
    data: {
      deviceId: 1,
      ownerKind,
      ownerId,
      kind: 'crop',
      timestamp: 1000,
      path,
      sizeBytes: 3,
    },
  }
}

function rawFace(id: string, trackId: string, assigned: boolean): RawRecord {
  return testFaceSeedRow(id, { deviceId: 1, trackId, timestamp: 1000, assigned })
}

// ── EventStore.deleteByTracks ────────────────────────────────────────

describe('EventStore.deleteByTracks', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let mediaCalls: string[][]
  let mediaDeleter: EventOwnedMediaDeleter
  let store: EventStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    world = await makeAnalyticsRecords()
    mediaCalls = []
    mediaDeleter = {
      deleteForEvents: async (ids) => {
        const objectIds = ids.object ?? []
        mediaCalls.push([...objectIds])
        return objectIds.length
      },
    }
    store = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(world.records),
      media: mediaDeleter,
    })
    await EventStore.declareObjectCollection(fake.client)
  })

  it('deletes the events of ALL given tracks and folds in their event-owned media', async () => {
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      rawObjectForTrack('e1', 't-1'),
      rawObjectForTrack('e2', 't-1'),
      rawObjectForTrack('e3', 't-2'),
      rawObjectForTrack('keep', 't-9'),
    ])

    await store.deleteByTracks(['t-1', 't-2'])

    // Only t-9's event survives.
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(1)
    // Media deletion folded in with the evicted event ids.
    expect(mediaCalls).toHaveLength(1)
    expect(new Set(mediaCalls[0])).toEqual(new Set(['e1', 'e2', 'e3']))
  })

  it('does not call the media deleter when no events matched', async () => {
    fake.seed(OBJECT_EVENTS_COLLECTION, [rawObjectForTrack('keep', 't-9')])

    await store.deleteByTracks(['t-missing'])

    expect(mediaCalls).toHaveLength(0)
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(1)
  })

  it('works without a media deleter (media fold-in optional)', async () => {
    const noMedia = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(world.records),
    })
    fake.seed(OBJECT_EVENTS_COLLECTION, [rawObjectForTrack('e1', 't-1')])

    await noMedia.deleteByTracks(['t-1'])

    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(0)
  })

  it('isolates a per-track failure — one bad track never aborts the batch', async () => {
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      rawObjectForTrack('e1', 't-good'),
      rawObjectForTrack('e2', 't-other'),
    ])
    // Wrap query so a query for the poisoned track throws.
    const originalQuery = fake.client.query.query.bind(fake.client.query)
    const poisoned: SettingsStoreClient = {
      ...fake.client,
      query: {
        query: async (input: Parameters<typeof originalQuery>[0]) => {
          const where = input.filter?.where as { trackId?: string } | undefined
          if (where?.trackId === 't-bad') throw new Error('boom')
          return originalQuery(input)
        },
      },
    } as unknown as SettingsStoreClient
    const poisonedStore = new EventStore({
      store: poisoned,
      logger: makeSilentLogger(),
      media: mediaDeleter,
      ...eventStoreLedgers(world.records),
    })

    await poisonedStore.deleteByTracks(['t-bad', 't-good', 't-other'])

    // The good tracks were still deleted despite t-bad throwing.
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(0)
    expect(new Set(mediaCalls[0])).toEqual(new Set(['e1', 'e2']))
  })
})

// ── MediaStore.deleteByTracks ────────────────────────────────────────

describe('MediaStore.deleteByTracks', () => {
  let fake: FakeSettingsStore
  let storage: FakeStorageProvider
  let store: MediaStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    storage = makeFakeStorageProvider()
    store = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
    await MediaStore.declare(fake.client)
  })

  it('deletes track + unassigned face/plate crops but NEVER identity/vehicle-owned media', async () => {
    // face/plate crop owner for a track is `<prefix><trackId>` (one per track).
    fake.seed(MEDIA_COLLECTION, [
      rawMedia('m-track', 'track', 't-1', 'p/track.jpg'),
      rawMedia('m-face', 'face', `${FACE_MEDIA_OWNER_PREFIX}t-1`, 'p/face.jpg'),
      rawMedia('m-plate', 'plate', `${PLATE_MEDIA_OWNER_PREFIX}t-1`, 'p/plate.jpg'),
      rawMedia('m-identity', 'identity', 'id-1', 'p/identity.jpg'),
      rawMedia('m-vehicle', 'vehicle', 'veh-1', 'p/vehicle.jpg'),
      rawMedia('m-other-track', 'track', 't-9', 'p/other.jpg'),
    ])
    storage.files.set('eventMedia:p/track.jpg', Buffer.from('a'))
    storage.files.set('eventMedia:p/face.jpg', Buffer.from('b'))
    storage.files.set('eventMedia:p/plate.jpg', Buffer.from('e'))
    storage.files.set('eventMedia:p/identity.jpg', Buffer.from('c'))
    storage.files.set('eventMedia:p/vehicle.jpg', Buffer.from('f'))
    storage.files.set('eventMedia:p/other.jpg', Buffer.from('d'))

    await store.deleteByTracks(['t-1'])

    // Track + face + plate crops of t-1 gone; identity + vehicle + other-track survive.
    const remaining = await fake.client.query.query({ collection: MEDIA_COLLECTION, filter: {} })
    expect(new Set(remaining.map((r) => r.id))).toEqual(
      new Set(['m-identity', 'm-vehicle', 'm-other-track']),
    )
    // Durable enrolled blobs are untouched on disk.
    expect(storage.files.has('eventMedia:p/identity.jpg')).toBe(true)
    expect(storage.files.has('eventMedia:p/vehicle.jpg')).toBe(true)
    expect(storage.files.has('eventMedia:p/track.jpg')).toBe(false)
    expect(storage.files.has('eventMedia:p/face.jpg')).toBe(false)
    expect(storage.files.has('eventMedia:p/plate.jpg')).toBe(false)
  })

  it('handles multiple tracks and derives the face owner per track', async () => {
    fake.seed(MEDIA_COLLECTION, [
      rawMedia('t1', 'track', 't-1', 'p/t1.jpg'),
      rawMedia('t2', 'track', 't-2', 'p/t2.jpg'),
      rawMedia('f1', 'face', `${FACE_MEDIA_OWNER_PREFIX}t-1`, 'p/f1.jpg'),
      rawMedia('f2', 'face', `${FACE_MEDIA_OWNER_PREFIX}t-2`, 'p/f2.jpg'),
    ])

    await store.deleteByTracks(['t-1', 't-2'])

    expect(fake.size(MEDIA_COLLECTION)).toBe(0)
  })
})

// ── FaceStore.deleteByTracks ─────────────────────────────────────────

describe('FaceStore.deleteByTracks', () => {
  let world: FakeRecords
  let faces: EventLedgerCollection
  let store: FaceStore

  beforeEach(async () => {
    world = await makeAnalyticsRecords()
    faces = wireFaceLedger({ records: world.records })
    store = new FaceStore({
      vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
      logger: makeSilentLogger(),
      faceLedger: faces,
    })
  })

  it('deletes UNassigned face rows but EXEMPTS assigned (enrolled) faces', async () => {
    await seedLedgerRows(faces, [
      rawFace('face-t-1', 't-1', false), // unassigned → deleted
      rawFace('face-t-2', 't-2', true), // ASSIGNED (enrolled) → survives
      rawFace('face-t-3', 't-3', false), // unassigned → deleted
      rawFace('face-t-9', 't-9', false), // different track → survives
    ])

    await store.deleteByTracks(['t-1', 't-2', 't-3'])

    const remaining = kindRows(world, 'faces')
    // The enrolled face of t-2 and the untargeted t-9 remain.
    expect(new Set(remaining.map((r) => r.id))).toEqual(new Set(['face-t-2', 'face-t-9']))
  })

  it('isolates a per-track failure', async () => {
    await seedLedgerRows(faces, [
      rawFace('face-t-good', 't-good', false),
      rawFace('face-t-other', 't-other', false),
    ])
    // A ledger whose read for the poisoned track throws.
    const poisoned = wireFaceLedger({ records: world.records })
    const originalQuery = poisoned.query.bind(poisoned)
    vi.spyOn(poisoned, 'query').mockImplementation(async (filter, columns) => {
      const where = filter['where'] as { trackId?: string } | undefined
      if (where?.trackId === 't-bad') throw new Error('boom')
      return originalQuery(filter, columns)
    })
    const poisonedStore = new FaceStore({
      vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
      logger: makeSilentLogger(),
      faceLedger: poisoned,
    })

    await poisonedStore.deleteByTracks(['t-bad', 't-good', 't-other'])

    expect(kindRows(world, 'faces')).toHaveLength(0)
  })
})

// ── ObjectEmbeddingStore.deleteByTracks ──────────────────────────────

describe('ObjectEmbeddingStore.deleteByTracks', () => {
  let vectors: ReturnType<typeof makeFakeVectorStore>
  let store: ObjectEmbeddingStore

  const seed = async (trackId: string): Promise<void> => {
    await store.upsertIfBetter({
      trackId,
      deviceId: 7,
      timestamp: 1000,
      className: 'person',
      embedding: [0.1, 0.2, 0.3],
      modelId: 'mobileclip-s1',
      confidence: 0.9,
    })
  }

  beforeEach(async () => {
    vectors = makeFakeVectorStore()
    store = new ObjectEmbeddingStore({
      vectorStore: vectors.client,
      logger: makeSilentLogger(),
      clipModels: testClipRegistry(3),
    })
  })

  it('deletes the per-track CLIP vector by trackId (id === trackId)', async () => {
    await seed('t-1')
    await seed('t-2')
    await seed('t-9')

    await store.deleteByTracks(['t-1', 't-2'])

    const remaining = [...(vectors.rows.get('object-clip')?.keys() ?? [])]
    expect(remaining).toEqual(['t-9'])
  })

  it('swallows a delete failure rather than aborting the cascade', async () => {
    // The cascade deletes across several stores; one failing leg must not take
    // the others with it.
    await seed('t-good')
    const poisoned = {
      ...vectors.client,
      deleteByIds: {
        mutate: async (): Promise<{ deleted: number }> => {
          throw new Error('boom')
        },
      },
    }
    const poisonedStore = new ObjectEmbeddingStore({
      vectorStore: poisoned,
      logger: makeSilentLogger(),
      clipModels: testClipRegistry(3),
    })

    // It reports ZERO removed, not the request size: the vectors are still
    // there, and a count that assumes the delete landed is the structural lie
    // this contract was widened to remove (D161).
    await expect(poisonedStore.deleteByTracks(['t-good'])).resolves.toEqual([
      { family: 'embeddings', rows: 0, bytes: 0 },
    ])
  })
})
