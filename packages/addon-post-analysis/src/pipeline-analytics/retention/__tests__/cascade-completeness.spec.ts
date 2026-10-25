import { testFaceSeedRow } from '../../../__tests__/support/face-seed.js'
import { FACE_ARCFACE_INDEX } from '../../store/embedding-vector-index.js'
/**
 * Cascade completeness — the test that fails when someone adds a track-owned
 * entity and forgets the cascade.
 *
 * ## What it does
 *
 * Builds the PRODUCTION cascade registry (`buildAnalyticsCascadeRegistry`, the
 * same function the addon calls) over real stores, seeds ONE row of EVERY
 * family in {@link TRACK_OWNED_FAMILIES} plus one of every family in
 * {@link RETENTION_EXEMPT_FAMILIES}, prunes the track, and asserts:
 *
 *   - nothing owned survives, and
 *   - everything exempt does.
 *
 * ## Why it is shaped this way
 *
 * The obvious version of this test hard-codes the entity list, and it passes
 * forever after somebody adds a ninth family. This one iterates the DECLARATION
 * in `retention-model.ts` and cross-checks that the seeder table covers it
 * exactly, in both directions. So adding a family to the declaration without a
 * seeder fails immediately, and adding a seeder whose family the cascade does
 * not reach fails on the survivor assertion.
 *
 * That is the failure mode that produced 5,598 orphaned `keyFrame` media rows:
 * an entity was reachable from a track, the cascade did not know about it, and
 * nothing anywhere said so.
 */
import { beforeEach, describe, expect, it } from 'vitest'
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
import { FACES_COLLECTION, FaceStore } from '../../store/face-store.js'
import { IDENTITY_SAMPLES_COLLECTION } from '../../store/identity-store.js'
import {
  FACE_MEDIA_OWNER_PREFIX,
  MEDIA_COLLECTION,
  MediaStore,
  type OwnerKind,
  PLATE_MEDIA_OWNER_PREFIX,
} from '../../store/media-store.js'
import { ObjectEmbeddingStore } from '../../store/object-embedding-store.js'
import { PLATES_COLLECTION, PlateStore } from '../../store/plate-store.js'
import { TRACKS_COLLECTION, TrackStore } from '../../store/track-store.js'
import { VEHICLE_SAMPLES_COLLECTION } from '../../store/vehicle-store.js'
import {
  buildAnalyticsCascadeRegistry,
  cascadeDeleteTracks,
} from '../../pipeline/delete-track-cascade.js'
import {
  RETENTION_EXEMPT_FAMILIES,
  type RetentionExemptFamilyId,
  TRACK_OWNED_FAMILIES,
  type TrackOwnedFamilyId,
} from '../retention-model.js'
import { testClipRegistry } from '../../__tests__/fixtures/clip-test-registry.js'

const TRACK_ID = 't-owned'
const DEVICE_ID = 101
const EVENT_ID = 'ev-owned'

interface Harness {
  readonly fake: FakeSettingsStore
  /** Faces, plates and the gallery samples are records kinds. */
  readonly world: AnalyticsWorld
  readonly storage: FakeStorageProvider
  readonly eventStore: EventStore
  readonly mediaStore: MediaStore
  readonly faceStore: FaceStore
  readonly plateStore: PlateStore
  readonly embeddingStore: ObjectEmbeddingStore
  readonly trackStore: TrackStore
  readonly vectors: ReturnType<typeof makeFakeVectorStore>
}

/** Seed one media row + its blob. Returns the row id. */
function seedMedia(
  h: Harness,
  id: string,
  ownerKind: OwnerKind,
  ownerId: string,
  kind: string,
): string {
  const path = `${DEVICE_ID}/events/${ownerKind}/${ownerId}/${kind}.jpg`
  h.fake.seed(MEDIA_COLLECTION, [
    {
      id,
      data: {
        deviceId: DEVICE_ID,
        ownerKind,
        ownerId,
        kind,
        timestamp: 1_000,
        path,
        sizeBytes: 7,
      },
    },
  ])
  h.storage.files.set(`eventMedia:${path}`, Buffer.from('bytes'))
  return id
}

async function countMedia(h: Harness, predicate: (row: Record<string, unknown>) => boolean) {
  const rows = await h.fake.client.query.query({ collection: MEDIA_COLLECTION, filter: {} })
  return rows.filter((r) => predicate(r.data as Record<string, unknown>)).length
}

/** The records kind behind each ledger collection this spec counts (absent = a table). */
const LEDGER_KIND: Readonly<Record<string, string>> = {
  [FACES_COLLECTION]: 'faces',
  [PLATES_COLLECTION]: 'plates',
  [IDENTITY_SAMPLES_COLLECTION]: 'identity-samples',
  [VEHICLE_SAMPLES_COLLECTION]: 'vehicle-samples',
}

async function countRows(
  h: Harness,
  collection: string,
  predicate: (row: Record<string, unknown>) => boolean,
) {
  const kind = LEDGER_KIND[collection]
  // A table that stays a table (object-events) is counted on the settings store.
  const rows =
    kind === undefined
      ? await h.fake.client.query.query({ collection, filter: {} })
      : kindRows(h.world.world, kind)
  return rows.filter((r) => predicate(r.data as Record<string, unknown>)).length
}

/**
 * One seeder + one survivor probe per owned family. The keys are typed as
 * {@link TrackOwnedFamilyId}, so a family added to the declaration without an
 * entry here is a COMPILE error as well as a test failure.
 */
const OWNED: Record<
  TrackOwnedFamilyId,
  { seed: (h: Harness) => Promise<void>; survivors: (h: Harness) => Promise<number> }
> = {
  'object-events': {
    seed: async (h) => {
      h.fake.seed(OBJECT_EVENTS_COLLECTION, [
        {
          id: EVENT_ID,
          data: {
            deviceId: DEVICE_ID,
            timestamp: 1_000,
            trackId: TRACK_ID,
            className: 'person',
            confidence: 0.9,
            bbox: { x: 0, y: 0, w: 10, h: 10 },
            zones: [],
            state: 'new',
          },
        },
      ])
    },
    survivors: (h) => countRows(h, OBJECT_EVENTS_COLLECTION, (d) => d['trackId'] === TRACK_ID),
  },
  'event-media': {
    seed: async (h) => {
      // D476: an object event's own media is owned by 'object', not 'event'.
      seedMedia(h, 'med-event-facecrop', 'object', EVENT_ID, 'faceCrop')
    },
    survivors: (h) =>
      countMedia(h, (d) => d['ownerKind'] === 'object' && d['ownerId'] === EVENT_ID),
  },
  'track-media': {
    seed: async (h) => {
      seedMedia(h, 'med-track-keyframe', 'track', TRACK_ID, 'keyFrame')
      seedMedia(h, 'med-track-thumb', 'track', TRACK_ID, 'thumbnail')
    },
    survivors: (h) => countMedia(h, (d) => d['ownerKind'] === 'track' && d['ownerId'] === TRACK_ID),
  },
  'face-rows': {
    seed: async (h) => {
      await seedLedgerRows(h.world.ledgers.faces, [
        testFaceSeedRow(`${FACE_MEDIA_OWNER_PREFIX}${TRACK_ID}`, {
          deviceId: DEVICE_ID,
          trackId: TRACK_ID,
          timestamp: 1_000,
          embedding: [0.1],
          assigned: false,
        }),
      ])
    },
    survivors: (h) =>
      countRows(h, FACES_COLLECTION, (d) => d['trackId'] === TRACK_ID && d['assigned'] !== true),
  },
  'face-media': {
    seed: async (h) => {
      seedMedia(h, 'med-face', 'face', `${FACE_MEDIA_OWNER_PREFIX}${TRACK_ID}`, 'faceCrop')
    },
    survivors: (h) =>
      countMedia(
        h,
        (d) =>
          d['ownerKind'] === 'face' && d['ownerId'] === `${FACE_MEDIA_OWNER_PREFIX}${TRACK_ID}`,
      ),
  },
  'plate-rows': {
    seed: async (h) => {
      await seedLedgerRows(h.world.ledgers.plates, [
        {
          id: `${PLATE_MEDIA_OWNER_PREFIX}${TRACK_ID}`,
          data: {
            deviceId: DEVICE_ID,
            trackId: TRACK_ID,
            timestamp: 1_000,
            text: 'AB123CD',
            assigned: false,
          },
        },
      ])
    },
    survivors: (h) =>
      countRows(h, PLATES_COLLECTION, (d) => d['trackId'] === TRACK_ID && d['assigned'] !== true),
  },
  'plate-media': {
    seed: async (h) => {
      seedMedia(h, 'med-plate', 'plate', `${PLATE_MEDIA_OWNER_PREFIX}${TRACK_ID}`, 'plateCrop')
    },
    survivors: (h) =>
      countMedia(
        h,
        (d) =>
          d['ownerKind'] === 'plate' && d['ownerId'] === `${PLATE_MEDIA_OWNER_PREFIX}${TRACK_ID}`,
      ),
  },
  'object-embeddings': {
    seed: async (h) => {
      await h.embeddingStore.upsertIfBetter({
        trackId: TRACK_ID,
        deviceId: DEVICE_ID,
        timestamp: 1_000,
        className: 'person',
        embedding: [0.1, 0.2],
        modelId: 'clip',
        confidence: 0.9,
      })
    },
    survivors: async (h) => h.vectors.rows.get('object-clip')?.size ?? 0,
  },
}

/** One seeder + one survivor probe per EXEMPT family — the mirror assertion. */
const EXEMPT: Record<
  RetentionExemptFamilyId,
  { seed: (h: Harness) => Promise<void>; survivors: (h: Harness) => Promise<number> }
> = {
  'identity-media': {
    seed: async (h) => {
      seedMedia(h, 'med-identity', 'identity', 'identity-1', 'faceCrop')
    },
    survivors: (h) => countMedia(h, (d) => d['ownerKind'] === 'identity'),
  },
  'vehicle-media': {
    seed: async (h) => {
      seedMedia(h, 'med-vehicle', 'vehicle', 'vehicle-1', 'plateCrop')
    },
    survivors: (h) => countMedia(h, (d) => d['ownerKind'] === 'vehicle'),
  },
  'enrolled-faces': {
    seed: async (h) => {
      await seedLedgerRows(h.world.ledgers.faces, [
        testFaceSeedRow(`enrolled-${TRACK_ID}`, {
          deviceId: DEVICE_ID,
          trackId: TRACK_ID,
          timestamp: 1_000,
          embedding: [0.2],
          assigned: true,
          recognizedIdentityId: 'identity-1',
        }),
      ])
    },
    survivors: (h) => countRows(h, FACES_COLLECTION, (d) => d['assigned'] === true),
  },
  'enrolled-plates': {
    seed: async (h) => {
      await seedLedgerRows(h.world.ledgers.plates, [
        {
          id: `enrolled-${TRACK_ID}`,
          data: {
            deviceId: DEVICE_ID,
            trackId: TRACK_ID,
            timestamp: 1_000,
            text: 'AB123CD',
            assigned: true,
            recognizedVehicleId: 'vehicle-1',
          },
        },
      ])
    },
    survivors: (h) => countRows(h, PLATES_COLLECTION, (d) => d['assigned'] === true),
  },
  'identity-samples': {
    seed: async (h) => {
      // A complete sample body: `addedAt` is the kind's clock, and the kind's
      // schema requires `source`, `modelId` and `dim` (the settings fake never
      // validated a body, so the old fixture omitted them).
      await seedLedgerRows(h.world.ledgers.identitySamples, [
        {
          id: 'sample-1',
          data: {
            identityId: 'identity-1',
            trackId: TRACK_ID,
            embedding: [0.3],
            timestamp: 1_000,
            addedAt: 1_000,
            source: 'detected',
            modelId: 'arcface-r100',
            dim: 1,
          },
        },
      ])
    },
    survivors: (h) => countRows(h, IDENTITY_SAMPLES_COLLECTION, () => true),
  },
  'vehicle-samples': {
    seed: async (h) => {
      await seedLedgerRows(h.world.ledgers.vehicleSamples, [
        {
          id: 'vsample-1',
          // `addedAt` (the clock) and `score` are required by the kind.
          data: {
            vehicleId: 'vehicle-1',
            trackId: TRACK_ID,
            text: 'AB123CD',
            score: 0.9,
            addedAt: 1_000,
          },
        },
      ])
    },
    survivors: (h) => countRows(h, VEHICLE_SAMPLES_COLLECTION, () => true),
  },
}

describe('track cascade completeness', () => {
  let h: Harness

  beforeEach(async () => {
    const fake = makeFakeSettingsStore()
    const world = await makeAnalyticsWorld()
    const storage = makeFakeStorageProvider()
    const mediaStore = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
    const mediaDeleter: EventOwnedMediaDeleter = mediaStore
    const vectors = makeFakeVectorStore()
    h = {
      fake,
      world,
      storage,
      mediaStore,
      eventStore: new EventStore({
        store: fake.client,
        logger: makeSilentLogger(),
        media: mediaDeleter,
        motionLedger: world.ledgers.motion,
        audioLedger: world.ledgers.audio,
      }),
      faceStore: new FaceStore({
        vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
        logger: makeSilentLogger(),
        faceLedger: world.ledgers.faces,
      }),
      plateStore: new PlateStore({ logger: makeSilentLogger(), plateLedger: world.ledgers.plates }),
      embeddingStore: new ObjectEmbeddingStore({
        vectorStore: vectors.client,
        logger: makeSilentLogger(),
        clipModels: testClipRegistry(2),
      }),
      trackStore: new TrackStore({ store: fake.client, logger: makeSilentLogger() }),
      vectors,
    }
    await EventStore.declareObjectCollection(fake.client)
    await MediaStore.declare(fake.client)
    await TrackStore.declare(fake.client)
  })

  it('the seeder table covers TRACK_OWNED_FAMILIES exactly — in both directions', () => {
    expect(Object.keys(OWNED).toSorted()).toEqual(TRACK_OWNED_FAMILIES.map((f) => f.id).toSorted())
  })

  it('the seeder table covers RETENTION_EXEMPT_FAMILIES exactly — in both directions', () => {
    expect(Object.keys(EXEMPT).toSorted()).toEqual(
      RETENTION_EXEMPT_FAMILIES.map((f) => f.id).toSorted(),
    )
  })

  it('pruning one track leaves NOTHING it owns, and everything exempt', async () => {
    for (const family of TRACK_OWNED_FAMILIES) await OWNED[family.id].seed(h)
    for (const family of RETENTION_EXEMPT_FAMILIES) await EXEMPT[family.id].seed(h)
    h.fake.seed(TRACKS_COLLECTION, [
      {
        id: TRACK_ID,
        data: { deviceId: DEVICE_ID, className: 'person', firstSeen: 1, lastSeen: 2 },
      },
    ])

    // Every family has something to lose BEFORE the cascade — otherwise a
    // seeder that silently wrote nothing would make the survivor assertion
    // vacuously true (the pre-seeding fake that hid a live bug, twice).
    for (const family of TRACK_OWNED_FAMILIES) {
      expect(await OWNED[family.id].survivors(h), `${family.id} was not seeded`).toBeGreaterThan(0)
    }
    for (const family of RETENTION_EXEMPT_FAMILIES) {
      expect(await EXEMPT[family.id].survivors(h), `${family.id} was not seeded`).toBeGreaterThan(0)
    }

    const registry = buildAnalyticsCascadeRegistry({
      eventStore: h.eventStore,
      mediaStore: h.mediaStore,
      faceStore: h.faceStore,
      plateStore: h.plateStore,
      objectEmbeddingStore: h.embeddingStore,
    })
    await cascadeDeleteTracks(registry, h.trackStore, [TRACK_ID])

    for (const family of TRACK_OWNED_FAMILIES) {
      expect(
        await OWNED[family.id].survivors(h),
        `${family.id} SURVIVED the cascade — ${family.cascadedBy} did not reach it`,
      ).toBe(0)
    }
    for (const family of RETENTION_EXEMPT_FAMILIES) {
      expect(
        await EXEMPT[family.id].survivors(h),
        `${family.id} was DELETED by the cascade — ${family.why}`,
      ).toBeGreaterThan(0)
    }
    // The root goes last and it does go.
    expect(h.fake.size(TRACKS_COLLECTION)).toBe(0)
    // And the blobs behind the owned media went with the rows.
    expect(
      h.storage.files.has(`eventMedia:${DEVICE_ID}/events/track/${TRACK_ID}/keyFrame.jpg`),
    ).toBe(false)
    expect(
      h.storage.files.has(`eventMedia:${DEVICE_ID}/events/identity/identity-1/faceCrop.jpg`),
    ).toBe(true)
  })

  it('the registry the addon builds omits nothing when every optional store is present', () => {
    const registry = buildAnalyticsCascadeRegistry({
      eventStore: h.eventStore,
      mediaStore: h.mediaStore,
      faceStore: h.faceStore,
      plateStore: h.plateStore,
      objectEmbeddingStore: h.embeddingStore,
    })
    expect(registry).toHaveLength(5)
    // Leaves first, and the media store after the event store — event-owned
    // media is deleted by the EVENT leg, which must run while the events exist.
    expect(registry[0]).toBe(h.eventStore)
    expect(registry[1]).toBe(h.mediaStore)
  })
})
