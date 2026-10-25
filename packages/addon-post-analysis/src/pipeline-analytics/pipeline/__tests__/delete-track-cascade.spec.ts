import { FACE_ARCFACE_INDEX } from '../../store/embedding-vector-index.js'
/**
 * Whole-track deletion cascade tests — track-centric retention cascade.
 *
 * Covers:
 *  - `cascadeDeleteTracks` (extensible registry form): every registered
 *    `TrackScopedStore` runs (with the full id list), in registry ORDER, and
 *    the track ROOT rows are deleted LAST.
 *  - `cascadeDeleteTrack` (shipped single-track form) delegates to the
 *    generalized cascade while preserving the exact legacy call order
 *    (events → their media → track media → track row).
 *  - Integration: the four REAL stores wired as the registry — ephemeral track
 *    footprint is wiped while an ENROLLED (assigned) face and `identity`-owned
 *    media SURVIVE, and the track root is deleted last.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { testFaceSeedRow } from '../../../__tests__/support/face-seed.js'
import {
  type AnalyticsWorld,
  kindRows,
  makeAnalyticsWorld,
  seedLedgerRows,
} from '../../__tests__/fake-records.js'
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
} from '../../store/event-store.js'
import { FaceStore } from '../../store/face-store.js'
import { FACE_MEDIA_OWNER_PREFIX, MEDIA_COLLECTION, MediaStore } from '../../store/media-store.js'
import { ObjectEmbeddingStore } from '../../store/object-embedding-store.js'
import { TRACKS_COLLECTION, TrackStore } from '../../store/track-store.js'
import {
  absentCascadeLegs,
  buildAnalyticsCascadeRegistry,
  cascadeDeleteTrack,
  cascadeDeleteTracks,
  type TrackDeletionStores,
  type TrackRootStore,
  type TrackScopedStore,
} from '../delete-track-cascade.js'
import type { TrackLeafStore } from '../track-fusion-leaf.js'
import { testClipRegistry } from '../../__tests__/fixtures/clip-test-registry.js'

// ── cascadeDeleteTracks — registry order + root last ─────────────────

describe('cascadeDeleteTracks', () => {
  it('runs every registered store in order, then deletes the track roots LAST', async () => {
    const order: string[] = []
    const makeStore = (label: string): TrackScopedStore => ({
      deleteByTracks: async (ids) => {
        order.push(`${label}:${ids.join(',')}`)
        return [{ family: 'events', rows: ids.length, bytes: 0 }]
      },
    })
    const registry: readonly TrackScopedStore[] = [
      makeStore('events'),
      makeStore('media'),
      makeStore('faces'),
      makeStore('embeddings'),
    ]
    const rootDeletes: string[] = []
    const trackStore: TrackRootStore = {
      deletePersisted: async (id) => {
        order.push(`root:${id}`)
        rootDeletes.push(id)
      },
    }

    await cascadeDeleteTracks(registry, trackStore, ['t-1', 't-2'])

    // Every leaf store called (with the full id list) BEFORE any root delete.
    expect(order).toEqual([
      'events:t-1,t-2',
      'media:t-1,t-2',
      'faces:t-1,t-2',
      'embeddings:t-1,t-2',
      'root:t-1',
      'root:t-2',
    ])
    expect(rootDeletes).toEqual(['t-1', 't-2'])
  })

  it('deletes the root even with an empty registry (no leaf stores)', async () => {
    const rootDeletes: string[] = []
    const trackStore: TrackRootStore = {
      deletePersisted: async (id) => {
        rootDeletes.push(id)
      },
    }

    await cascadeDeleteTracks([], trackStore, ['t-1'])

    expect(rootDeletes).toEqual(['t-1'])
  })
})

// ── cascadeDeleteTrack — legacy single-track delegation ──────────────

describe('cascadeDeleteTrack (shipped single-track path)', () => {
  it('preserves the legacy order: events → event media → track media → root', async () => {
    const order: string[] = []
    const stores: TrackDeletionStores = {
      eventStore: {
        deleteByTrack: async (trackId) => {
          order.push(`eventStore.deleteByTrack:${trackId}`)
          return ['e1', 'e2']
        },
      },
      mediaStore: {
        deleteForEvents: async (ids) => {
          const objectIds = ids.object ?? []
          order.push(`mediaStore.deleteForEvents:${objectIds.join(',')}`)
          return objectIds.length
        },
        deleteForTracks: async (ids) => {
          order.push(`mediaStore.deleteForTracks:${ids.join(',')}`)
          return ids.length
        },
      },
      trackStore: {
        deletePersisted: async (trackId) => {
          order.push(`trackStore.deletePersisted:${trackId}`)
        },
      },
    }

    await cascadeDeleteTrack(stores, 't-1')

    expect(order).toEqual([
      'eventStore.deleteByTrack:t-1',
      'mediaStore.deleteForEvents:e1,e2',
      'mediaStore.deleteForTracks:t-1',
      'trackStore.deletePersisted:t-1',
    ])
  })

  it('skips event-media deletion when the track had no events', async () => {
    const order: string[] = []
    const stores: TrackDeletionStores = {
      eventStore: { deleteByTrack: async () => [] },
      mediaStore: {
        deleteForEvents: async (ids) => {
          order.push(`deleteForEvents:${(ids.object ?? []).join(',')}`)
          return (ids.object ?? []).length
        },
        deleteForTracks: async (ids) => {
          order.push(`deleteForTracks:${ids.join(',')}`)
          return ids.length
        },
      },
      trackStore: { deletePersisted: async () => {} },
    }

    await cascadeDeleteTrack(stores, 't-1')

    // deleteForEvents NOT called (no event ids); track media still swept.
    expect(order).toEqual(['deleteForTracks:t-1'])
  })

  it('runs the alias leg LAST, widened — the zero-media suppression path (review H2)', async () => {
    const order: string[] = []
    const stores: TrackDeletionStores = {
      eventStore: { deleteByTrack: async () => [] },
      mediaStore: {
        deleteForEvents: async () => 0,
        deleteForTracks: async (ids) => {
          order.push(`deleteForTracks:${ids.join(',')}`)
          return ids.length
        },
      },
      trackStore: {
        deletePersisted: async (trackId) => {
          order.push(`deletePersisted:${trackId}`)
        },
      },
      aliasStore: {
        deleteByTracks: async (ids) => {
          order.push(`aliasStore.deleteByTracks:${ids.join(',')}`)
          return [{ family: 'aliases', rows: ids.length, bytes: 0 }]
        },
      },
    }

    const tally = await cascadeDeleteTrack(stores, 't-1', {
      expandLeafIds: async (ids) => ids.map((id) => `${id}-straggler`),
    })

    expect(order).toEqual([
      'deleteForTracks:t-1,t-1-straggler',
      'aliasStore.deleteByTracks:t-1,t-1-straggler',
      'deletePersisted:t-1',
    ])
    expect(tally.aliases).toBe(2)
  })
})

// ── Integration: real stores wired as the cascade registry ───────────

describe('cascadeDeleteTracks — real stores integration', () => {
  let fake: FakeSettingsStore
  let storage: FakeStorageProvider
  let eventStore: EventStore
  let mediaStore: MediaStore
  let faceStore: FaceStore
  let embeddingStore: ObjectEmbeddingStore
  let vectors: ReturnType<typeof makeFakeVectorStore>
  let trackStore: TrackStore
  let world: AnalyticsWorld

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    world = await makeAnalyticsWorld()
    storage = makeFakeStorageProvider()
    mediaStore = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
    const mediaDeleter: EventOwnedMediaDeleter = mediaStore
    eventStore = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      media: mediaDeleter,
      motionLedger: world.ledgers.motion,
      audioLedger: world.ledgers.audio,
    })
    faceStore = new FaceStore({
      vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
      logger: makeSilentLogger(),
      faceLedger: world.ledgers.faces,
    })
    vectors = makeFakeVectorStore()
    embeddingStore = new ObjectEmbeddingStore({
      vectorStore: vectors.client,
      logger: makeSilentLogger(),
      clipModels: testClipRegistry(2),
    })
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await EventStore.declareObjectCollection(fake.client)
    await MediaStore.declare(fake.client)
    await TrackStore.declare(fake.client)
  })

  it('wipes the ephemeral track footprint but keeps enrolled faces + identity media', async () => {
    const T = 't-1'
    // Object event for the track + its event-owned media.
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      {
        id: 'ev-1',
        data: {
          deviceId: 1,
          timestamp: 1000,
          trackId: T,
          className: 'person',
          confidence: 0.9,
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          zones: [],
          state: 'new',
        },
      },
    ])
    // Media: event-owned, track-owned, unassigned-face crop, AND an enrolled
    // identity crop (must survive).
    const seedMedia = (id: string, ownerKind: string, ownerId: string, path: string): void => {
      fake.seed(MEDIA_COLLECTION, [
        {
          id,
          data: {
            deviceId: 1,
            ownerKind,
            ownerId,
            kind: 'crop',
            timestamp: 1000,
            path,
            sizeBytes: 1,
          },
        },
      ])
      storage.files.set(`eventMedia:${path}`, Buffer.from('x'))
    }
    // D476: an object event's own media is owned by 'object', not 'event'.
    seedMedia('med-event', 'object', 'ev-1', 'p/event.jpg')
    seedMedia('med-track', 'track', T, 'p/track.jpg')
    seedMedia('med-face', 'face', `${FACE_MEDIA_OWNER_PREFIX}${T}`, 'p/face.jpg')
    seedMedia('med-identity', 'identity', 'id-1', 'p/identity.jpg')
    // Faces: one unassigned for the track (deleted) + one ENROLLED (survives).
    await seedLedgerRows(world.ledgers.faces, [
      testFaceSeedRow(`${FACE_MEDIA_OWNER_PREFIX}${T}`, {
        deviceId: 1,
        trackId: T,
        timestamp: 1000,
        embedding: [0.1],
        assigned: false,
      }),
      testFaceSeedRow(`enrolled-${T}`, {
        deviceId: 1,
        trackId: T,
        timestamp: 1000,
        embedding: [0.2],
        assigned: true,
      }),
    ])
    // Embedding (CLIP search vector) keyed by trackId, in the vector store.
    await embeddingStore.upsertIfBetter({
      trackId: T,
      deviceId: 1,
      timestamp: 1000,
      className: 'person',
      embedding: [0.1, 0.2],
      modelId: 'clip',
      confidence: 0.9,
    })
    // Track root row.
    fake.seed(TRACKS_COLLECTION, [
      { id: T, data: { deviceId: 1, className: 'person', firstSeen: 1, lastSeen: 2 } },
    ])

    const registry: readonly TrackScopedStore[] = [
      eventStore,
      mediaStore,
      faceStore,
      embeddingStore,
    ]
    await cascadeDeleteTracks(registry, trackStore, [T])

    // Object events gone.
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(0)
    // Embedding gone.
    expect(vectors.rows.get('object-clip')?.size ?? 0).toBe(0)
    // Track root gone (deleted last).
    expect(fake.size(TRACKS_COLLECTION)).toBe(0)
    // Media: only the identity-owned crop survives.
    const media = await fake.client.query.query({ collection: MEDIA_COLLECTION, filter: {} })
    expect(media.map((r) => r.id)).toEqual(['med-identity'])
    expect(storage.files.has('eventMedia:p/identity.jpg')).toBe(true)
    // Faces: only the ENROLLED (assigned) face survives.
    const faces = kindRows(world.world, 'faces')
    expect(faces.map((r) => r.id)).toEqual([`enrolled-${T}`])
  })
})

describe('absentCascadeLegs — an omitted leg is NAMED, never inferred from silence', () => {
  /**
   * `buildAnalyticsCascadeRegistry` pushes each optional store only `if` it is
   * there, and that `if` used to be silent. A hub whose `vector-store`
   * capability was unavailable at boot built an embedding-less cascade and then
   * pruned tracks with it for the whole life of the process — every CLIP vector
   * of every deleted track becoming unreachable by ownership — while the only
   * evidence was one warn at startup.
   */
  it('names every optional leg that is missing', () => {
    const leaf: TrackLeafStore = { deleteByTracks: async () => [], reassignTrack: async () => [] }
    expect(absentCascadeLegs({ eventStore: leaf, mediaStore: leaf })).toEqual([
      'faces',
      'plates',
      'embeddings',
      'aliases',
    ])
  })

  it('names ONLY the missing one when the rest are bound', () => {
    const leaf: TrackLeafStore = { deleteByTracks: async () => [], reassignTrack: async () => [] }
    expect(
      absentCascadeLegs({
        eventStore: leaf,
        mediaStore: leaf,
        faceStore: leaf,
        plateStore: leaf,
        objectEmbeddingStore: null,
        aliasStore: leaf,
      }),
    ).toEqual(['embeddings'])
  })

  it('is EMPTY for a complete registry — the two answers are visibly different', () => {
    const leaf: TrackLeafStore = { deleteByTracks: async () => [], reassignTrack: async () => [] }
    const complete = {
      eventStore: leaf,
      mediaStore: leaf,
      faceStore: leaf,
      plateStore: leaf,
      objectEmbeddingStore: leaf,
      aliasStore: leaf,
    }
    expect(absentCascadeLegs(complete)).toEqual([])
    // ...and the registry it builds really is longer than the degraded one.
    expect(buildAnalyticsCascadeRegistry(complete).length).toBe(6)
    expect(buildAnalyticsCascadeRegistry({ eventStore: leaf, mediaStore: leaf }).length).toBe(2)
  })
})
