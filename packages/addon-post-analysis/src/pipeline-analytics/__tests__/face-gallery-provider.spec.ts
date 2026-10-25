import { FACE_ARCFACE_INDEX, IDENTITY_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
/**
 * FaceGalleryProvider — Task 5 + Task 6 tests
 *
 * Task 5: createIdentity→listIdentities; listIdentitySamples inlines base64;
 * removeSample deletes durable media; deleteIdentity cascades sample media.
 *
 * Task 6: listRecentFaces, getFaceByTrack, getFaceMedia, assignFace, unassignFace.
 */

import type { PipelineAnalyticsFaceGalleryChangedPayload } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { FaceGalleryProvider } from '../face-gallery-provider.js'
import { SCRFD_V2_ALIGNMENT_SINCE_MS } from '../face-alignment-version.js'
import { EventStore } from '../store/event-store.js'
import { FaceStore } from '../store/face-store.js'
import { IdentityStore } from '../store/identity-store.js'
import { MediaStore } from '../store/media-store.js'
import { TrackStore } from '../store/track-store.js'
import {
  type FakeSettingsStore,
  type FakeStorageProvider,
  makeFakeEmbeddingIndex,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
  testFaceGalleryModelPins,
} from './test-helpers.js'
import { makeAnalyticsWorld } from './fake-records.js'

/** The data-plane base the fake provider reports; assertions build expected
 *  `cropUrl`s from it. */
const EVENT_MEDIA_BASE = '/addon/pipeline-analytics/event-media'

/** Recording fake for the `emitFaceGalleryChanged` dep — local style mirrors
 *  the `refreshGallery: vi.fn()` recording pattern already used below. */
function makeFakeFaceGalleryEmit(): {
  readonly emitted: PipelineAnalyticsFaceGalleryChangedPayload[]
  emitFaceGalleryChanged: (payload: PipelineAnalyticsFaceGalleryChangedPayload) => void
} {
  const emitted: PipelineAnalyticsFaceGalleryChangedPayload[] = []
  return {
    emitted,
    emitFaceGalleryChanged: (payload) => emitted.push(payload),
  }
}

// ── harness (Task 5 — no real label stores) ──────────────────────────

async function makeProvider() {
  const fake: FakeSettingsStore = makeFakeSettingsStore()
  const storage: FakeStorageProvider = makeFakeStorageProvider()
  const logger = makeSilentLogger()
  const { ledgers } = await makeAnalyticsWorld()

  const identityStore = new IdentityStore({
    identityLedger: ledgers.identities,
    sampleLedger: ledgers.identitySamples,
    vectors: makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX).vectors,
    logger,
  })
  const mediaStore = new MediaStore({ storage, store: fake.client, logger })
  const faceStore = new FaceStore({
    faceLedger: ledgers.faces,
    vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
    logger,
  })
  await MediaStore.declare(fake.client)

  const emitFake = makeFakeFaceGalleryEmit()

  const provider = new FaceGalleryProvider({
    identityStore,
    faceStore,
    mediaStore,
    trackStore: null as unknown as never,
    eventStore: null as unknown as never,
    logger,
    refreshGallery: () => {},
    eventMediaBaseUrl: () => EVENT_MEDIA_BASE,
    eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
    emitFaceGalleryChanged: emitFake.emitFaceGalleryChanged,
    ...testFaceGalleryModelPins,
  })

  return { provider, identityStore, mediaStore, faceStore, fake, storage, emitFake }
}

// ── harness (Task 6 — real label stores with spies) ──────────────────

async function makeProviderWithSpies() {
  const fake: FakeSettingsStore = makeFakeSettingsStore()
  const storage: FakeStorageProvider = makeFakeStorageProvider()
  const logger = makeSilentLogger()
  const { ledgers } = await makeAnalyticsWorld()

  const identityStore = new IdentityStore({
    identityLedger: ledgers.identities,
    sampleLedger: ledgers.identitySamples,
    vectors: makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX).vectors,
    logger,
  })
  const mediaStore = new MediaStore({ storage, store: fake.client, logger })
  const faceStore = new FaceStore({
    faceLedger: ledgers.faces,
    vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
    logger,
  })
  const trackStore = new TrackStore({ store: fake.client, logger })
  const eventStore = new EventStore({
    store: fake.client,
    logger,
    motionLedger: ledgers.motion,
    audioLedger: ledgers.audio,
  })
  await MediaStore.declare(fake.client)
  await TrackStore.declare(fake.client)
  await EventStore.declareObjectCollection(fake.client)

  // Spy on label-propagation methods
  const trackSetLabelSpy = vi.spyOn(trackStore, 'applyLabelCandidate')
  const eventSetLabelSpy = vi.spyOn(eventStore, 'projectTrackLabel')
  const trackClearLabelSpy = vi.spyOn(trackStore, 'clearLabel')
  const eventClearLabelSpy = vi.spyOn(eventStore, 'clearLabelForTrack')

  const refreshGallery = vi.fn()
  const emitFake = makeFakeFaceGalleryEmit()

  const provider = new FaceGalleryProvider({
    identityStore,
    faceStore,
    mediaStore,
    trackStore,
    eventStore,
    logger,
    refreshGallery,
    eventMediaBaseUrl: () => EVENT_MEDIA_BASE,
    eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
    emitFaceGalleryChanged: emitFake.emitFaceGalleryChanged,
    ...testFaceGalleryModelPins,
  })

  return {
    provider,
    identityStore,
    mediaStore,
    faceStore,
    trackStore,
    eventStore,
    trackSetLabelSpy,
    eventSetLabelSpy,
    trackClearLabelSpy,
    eventClearLabelSpy,
    refreshGallery,
    fake,
    storage,
    emitFake,
  }
}

// ── Task 5 tests ─────────────────────────────────────────────────────

describe('FaceGalleryProvider — identity CRUD', () => {
  it('createIdentity then listIdentities returns the new person', async () => {
    const { provider } = await makeProvider()
    const id = await provider.createIdentity({ name: 'Alice' })
    expect(id.name).toBe('Alice')
    expect(id.sampleCount).toBe(0)
    expect(typeof id.id).toBe('string')

    const list = await provider.listIdentities()
    expect(list.find((i) => i.id === id.id)?.name).toBe('Alice')
  })

  it('renameIdentity updates the name', async () => {
    const { provider } = await makeProvider()
    const id = await provider.createIdentity({ name: 'Bob' })
    await provider.renameIdentity({ id: id.id, name: 'Robert' })
    const list = await provider.listIdentities()
    expect(list.find((i) => i.id === id.id)?.name).toBe('Robert')
  })

  it('renameIdentity invalidates every camera carrying that identity', async () => {
    const { provider, faceStore, emitFake } = await makeProvider()
    const identity = await provider.createIdentity({ name: 'Before' })
    await faceStore.insert({
      id: 'face-renamed',
      deviceId: 42,
      trackId: 'track-renamed',
      timestamp: 1_000,
      embedding: [0.1],
      assigned: true,
      recognizedIdentityId: identity.id,
    })

    await provider.renameIdentity({ id: identity.id, name: 'After' })

    expect(emitFake.emitted).toContainEqual({
      deviceId: 42,
      faceId: 'face-renamed',
      kind: 'identity-renamed',
    })
  })

  it('deleteIdentity removes the identity from listIdentities', async () => {
    const { provider } = await makeProvider()
    const id = await provider.createIdentity({ name: 'Charlie' })
    await provider.deleteIdentity({ id: id.id })
    const list = await provider.listIdentities()
    expect(list.find((i) => i.id === id.id)).toBeUndefined()
  })

  it('listIdentities names the cover by ID by default, and inlines it only on request', async () => {
    const { provider, identityStore, mediaStore } = await makeProvider()
    const id = await provider.createIdentity({ name: 'Grace' })
    // The first sample WITH a mediaId becomes the identity cover (identity-store).
    const mediaId = await mediaStore.put({
      deviceId: 99,
      ownerKind: 'identity',
      ownerId: id.id,
      kind: 'crop',
      timestamp: 1000,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    await identityStore.addSample({
      identityId: id.id,
      embedding: [0.1, 0.2],
      modelId: 'arcface-r100',
      source: 'detected',
      deviceId: 99,
      mediaId,
    })
    // DEFAULT: the id, never the bytes. The id is what stops this from being a
    // lost avatar — assert it on the same row that lost its base64, so the two
    // can never drift apart.
    const grace = (await provider.listIdentities()).find((i) => i.id === id.id)
    expect(grace?.coverMediaId).toBe(mediaId)
    expect(grace?.coverBase64).toBeUndefined()

    // OPT-IN: the bytes are still reachable by asking for them by name.
    const inlined = (await provider.listIdentities({ includeCrops: true })).find(
      (i) => i.id === id.id,
    )
    expect(inlined?.coverMediaId).toBe(mediaId)
    expect(typeof inlined?.coverBase64).toBe('string')
    expect((inlined?.coverBase64 ?? '').length).toBeGreaterThan(0)
  })

  it('deleteIdentity cascades and deletes sample media (ownerKind identity)', async () => {
    const { provider, identityStore, mediaStore } = await makeProvider()
    const id = await provider.createIdentity({ name: 'Dave' })
    // Add a sample with a media key
    const sample = await identityStore.addSample({
      identityId: id.id,
      embedding: [0.1, 0.2],
      modelId: 'arcface-r100',
      source: 'detected',
      deviceId: 99,
    })
    // Put the media under identity owner
    await mediaStore.put({
      deviceId: 99,
      ownerKind: 'identity',
      ownerId: id.id,
      kind: 'crop',
      timestamp: 1000,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })

    // deleteIdentity should remove the identity's media too
    await provider.deleteIdentity({ id: id.id })
    const list = await provider.listIdentities()
    expect(list.find((i) => i.id === id.id)).toBeUndefined()

    // Media for this identity should be gone
    const media = await mediaStore.listByOwner('identity', id.id)
    expect(media).toHaveLength(0)

    void sample
  })
})

describe('FaceGalleryProvider — listIdentitySamples', () => {
  it('returns an empty array for an identity with no samples', async () => {
    const { provider } = await makeProvider()
    const id = await provider.createIdentity({ name: 'Alice' })
    const samples = await provider.listIdentitySamples({ identityId: id.id })
    expect(samples).toHaveLength(0)
  })

  it('inlines base64 for a sample whose mediaId resolves to stored media', async () => {
    const { provider, identityStore, mediaStore } = await makeProvider()
    const id = await provider.createIdentity({ name: 'Eve' })
    const imageData = Buffer.from([0xff, 0xd8, 0xff, 0xe0])

    // Put the media under identity owner first so we know the id
    const mediaId = await mediaStore.put({
      deviceId: 7,
      ownerKind: 'identity',
      ownerId: id.id,
      kind: 'crop',
      timestamp: 2000,
      data: imageData,
    })

    // Add sample with the media id
    const sample = await identityStore.addSample({
      identityId: id.id,
      embedding: [0.1, 0.2],
      mediaId,
      modelId: 'arcface-r100',
      source: 'detected',
      deviceId: 7,
    })

    const samples = await provider.listIdentitySamples({ identityId: id.id })
    expect(samples).toHaveLength(1)
    expect(samples[0]!.id).toBe(sample.id)
    expect(samples[0]!.source).toBe('detected')
    expect(samples[0]!.deviceId).toBe(7)
    // base64 should be inlined
    expect(samples[0]!.base64).toBeDefined()
    expect(Buffer.from(samples[0]!.base64!, 'base64')).toEqual(imageData)
  })

  it('omits base64 when the media blob is missing', async () => {
    const { provider, identityStore } = await makeProvider()
    const id = await provider.createIdentity({ name: 'Frank' })

    // Add sample with a mediaId that doesn't correspond to actual storage
    await identityStore.addSample({
      identityId: id.id,
      embedding: [0.3, 0.4],
      mediaId: 9999,
      modelId: 'arcface-r100',
      source: 'detected',
    })

    const samples = await provider.listIdentitySamples({ identityId: id.id })
    expect(samples).toHaveLength(1)
    // base64 should be omitted (media id not found)
    expect(samples[0]!.base64).toBeUndefined()
  })
})

describe('FaceGalleryProvider — removeSample', () => {
  it('decrements sampleCount and deletes durable media for the sample', async () => {
    const { provider, identityStore, mediaStore } = await makeProvider()
    const id = await provider.createIdentity({ name: 'Grace' })
    const imageData = Buffer.from([0x01, 0x02, 0x03])

    // Add media under identity owner
    const mediaId = await mediaStore.put({
      deviceId: 5,
      ownerKind: 'identity',
      ownerId: id.id,
      kind: 'crop',
      timestamp: 3000,
      data: imageData,
    })

    // Add a sample with the mediaId
    const sample = await identityStore.addSample({
      identityId: id.id,
      embedding: [0.5, 0.6],
      mediaId,
      modelId: 'arcface-r100',
      source: 'detected',
      deviceId: 5,
    })

    // Should have 1 sample
    expect((await provider.listIdentities()).find((i) => i.id === id.id)?.sampleCount).toBe(1)

    await provider.removeSample({ identityId: id.id, sampleId: sample.id })

    // Count should be 0
    expect((await provider.listIdentities()).find((i) => i.id === id.id)?.sampleCount).toBe(0)

    // Media should be gone
    const media = await mediaStore.listByOwner('identity', id.id)
    expect(media).toHaveLength(0)
  })

  it('removeSample with no mediaId still decrements count without error', async () => {
    const { provider, identityStore } = await makeProvider()
    const id = await provider.createIdentity({ name: 'Heidi' })

    const sample = await identityStore.addSample({
      identityId: id.id,
      embedding: [0.7, 0.8],
      modelId: 'arcface-r100',
      source: 'photo',
    })

    await provider.removeSample({ identityId: id.id, sampleId: sample.id })
    expect((await provider.listIdentities()).find((i) => i.id === id.id)?.sampleCount).toBe(0)
  })
})

// ── Task 6 tests ─────────────────────────────────────────────────────

describe('FaceGalleryProvider — crop delivery', () => {
  /** A face row with a real crop blob behind it. */
  async function seedFaceWithCrop(
    faceStore: FaceStore,
    mediaStore: MediaStore,
  ): Promise<{ readonly mediaId: number }> {
    const mediaId = await mediaStore.put({
      deviceId: 10,
      ownerKind: 'face',
      ownerId: 'face-C1',
      kind: 'crop',
      timestamp: 1000,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    await faceStore.insert({
      id: 'face-C1',
      deviceId: 10,
      trackId: 'C1',
      timestamp: 1000,
      embedding: [0.1],
      assigned: false,
      mediaId,
    })
    return { mediaId }
  }

  it('getFaceByTrack returns a cropUrl and never inlines the JPEG', async () => {
    const { provider, faceStore, mediaStore } = await makeProviderWithSpies()
    const { mediaId } = await seedFaceWithCrop(faceStore, mediaStore)
    const result = await provider.getFaceByTrack({ deviceId: 10, trackId: 'C1' })
    expect(result?.cropUrl).toBe(`${EVENT_MEDIA_BASE}/m/${mediaId}`)
    expect(result?.base64).toBeUndefined()
  })

  it('serves the crop as a data-plane URL built from the media id', async () => {
    const { provider, faceStore, mediaStore } = await makeProviderWithSpies()
    const { mediaId } = await seedFaceWithCrop(faceStore, mediaStore)

    const faces = await provider.listRecentFaces()
    expect(faces[0]!.cropUrl).toBe(`${EVENT_MEDIA_BASE}/m/${mediaId}`)
  })

  it('does NOT inline base64 by DEFAULT — the expensive shape must be asked for', async () => {
    const { provider, faceStore, mediaStore } = await makeProviderWithSpies()
    await seedFaceWithCrop(faceStore, mediaStore)

    // Inline crops timed out this call on the live hub at 500 rows (60 457 ms,
    // UDS timeout, 2026-08-25). A shape that cannot complete is not a default.
    const faces = await provider.listRecentFaces()
    expect(faces[0]!.base64).toBeUndefined()
    // The image is still reachable — off the data plane, in parallel.
    expect(faces[0]!.cropUrl).toBeDefined()
  })

  it('inlines base64 when a caller explicitly asks for it', async () => {
    const { provider, faceStore, mediaStore } = await makeProviderWithSpies()
    await seedFaceWithCrop(faceStore, mediaStore)

    const faces = await provider.listRecentFaces({ includeCrops: true })
    expect((faces[0]!.base64 ?? '').length).toBeGreaterThan(0)
  })

  it('drops the inline base64 — and only it — when includeCrops is false', async () => {
    const { provider, faceStore, mediaStore } = await makeProviderWithSpies()
    await seedFaceWithCrop(faceStore, mediaStore)

    const faces = await provider.listRecentFaces({ includeCrops: false })
    // The payload the 2.87 MiB lived in is gone...
    expect(faces[0]!.base64).toBeUndefined()
    // ...and the row still says where to get the image.
    expect(faces[0]!.cropUrl).toBeDefined()
    expect(faces[0]!.faceId).toBe('face-C1')
  })

  it('omits cropUrl when the face has no stored crop', async () => {
    const { provider, faceStore } = await makeProviderWithSpies()
    await faceStore.insert({
      id: 'face-N1',
      deviceId: 10,
      trackId: 'N1',
      timestamp: 1000,
      embedding: [0.1],
      assigned: false,
    })
    const faces = await provider.listRecentFaces({ includeCrops: true })
    expect(faces[0]!.cropUrl).toBeUndefined()
  })

  it('omits cropUrl when the addon has no data plane', async () => {
    // `eventMediaBaseUrl()` returns null before/without a served plane — the row
    // must then fall back to base64 rather than emit a URL that 404s.
    const fake: FakeSettingsStore = makeFakeSettingsStore()
    const storage: FakeStorageProvider = makeFakeStorageProvider()
    const logger = makeSilentLogger()
    const { ledgers } = await makeAnalyticsWorld()
    const identityStore = new IdentityStore({
      identityLedger: ledgers.identities,
      sampleLedger: ledgers.identitySamples,
      vectors: makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX).vectors,
      logger,
    })
    const mediaStore = new MediaStore({ storage, store: fake.client, logger })
    const faceStore = new FaceStore({
      faceLedger: ledgers.faces,
      vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
      logger,
    })
    await MediaStore.declare(fake.client)
    const provider = new FaceGalleryProvider({
      identityStore,
      faceStore,
      mediaStore,
      trackStore: null as unknown as never,
      eventStore: null as unknown as never,
      logger,
      refreshGallery: () => {},
      eventMediaBaseUrl: () => null,
      eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
      emitFaceGalleryChanged: () => {},
      ...testFaceGalleryModelPins,
    })
    await seedFaceWithCrop(faceStore, mediaStore)

    const faces = await provider.listRecentFaces({ includeCrops: true })
    expect(faces[0]!.cropUrl).toBeUndefined()
    expect((faces[0]!.base64 ?? '').length).toBeGreaterThan(0)
  })
})

describe('FaceGalleryProvider — listRecentFaces', () => {
  it('returns empty list when no faces exist', async () => {
    const { provider } = await makeProviderWithSpies()
    const faces = await provider.listRecentFaces({ includeCrops: true })
    expect(faces).toHaveLength(0)
  })

  it('maps buffered faces to FaceInfo with identityName resolved', async () => {
    const { provider, faceStore, identityStore } = await makeProviderWithSpies()
    const identity = await identityStore.createIdentity({ name: 'Ivan' })
    await faceStore.insert({
      id: 'face-T1',
      deviceId: 10,
      trackId: 'T1',
      timestamp: 1000,
      embedding: [0.1, 0.2],
      assigned: false,
      recognizedIdentityId: identity.id,
    })

    const faces = await provider.listRecentFaces({ includeCrops: true })
    expect(faces).toHaveLength(1)
    expect(faces[0]!.faceId).toBe('face-T1')
    expect(faces[0]!.deviceId).toBe(10)
    expect(faces[0]!.trackId).toBe('T1')
    expect(faces[0]!.assigned).toBe(false)
    expect(faces[0]!.identityName).toBe('Ivan')
    // embedding must NOT be exposed
    expect(faces[0]).not.toHaveProperty('embedding')
  })

  it('respects limit parameter', async () => {
    const { provider, faceStore } = await makeProviderWithSpies()
    for (let i = 0; i < 5; i++) {
      await faceStore.insert({
        id: `face-T${i}`,
        deviceId: 10,
        trackId: `T${i}`,
        timestamp: 1000 + i,
        embedding: [0.1],
        assigned: false,
      })
    }
    const faces = await provider.listRecentFaces({ limit: 3 })
    expect(faces).toHaveLength(3)
  })
})

describe('FaceGalleryProvider — getFaceByTrack', () => {
  it('returns FaceInfo for a matching face', async () => {
    const { provider, faceStore } = await makeProviderWithSpies()
    await faceStore.insert({
      id: 'face-TRK1',
      deviceId: 20,
      trackId: 'TRK1',
      timestamp: 2000,
      embedding: [0.3],
      assigned: false,
    })
    const result = await provider.getFaceByTrack({ deviceId: 20, trackId: 'TRK1' })
    expect(result).not.toBeNull()
    expect(result!.faceId).toBe('face-TRK1')
    expect(result!.trackId).toBe('TRK1')
  })

  it('returns null when deviceId mismatches', async () => {
    const { provider, faceStore } = await makeProviderWithSpies()
    await faceStore.insert({
      id: 'face-TRK2',
      deviceId: 20,
      trackId: 'TRK2',
      timestamp: 2000,
      embedding: [0.3],
      assigned: false,
    })
    const result = await provider.getFaceByTrack({ deviceId: 99, trackId: 'TRK2' })
    expect(result).toBeNull()
  })

  it('returns null when face does not exist', async () => {
    const { provider } = await makeProviderWithSpies()
    const result = await provider.getFaceByTrack({ deviceId: 10, trackId: 'nonexistent' })
    expect(result).toBeNull()
  })
})

describe('FaceGalleryProvider — getFaceMedia', () => {
  it('returns media files for the face owner', async () => {
    const { provider, faceStore, mediaStore } = await makeProviderWithSpies()
    await faceStore.insert({
      id: 'face-M1',
      deviceId: 10,
      trackId: 'M1',
      timestamp: 1000,
      embedding: [0.1],
      assigned: false,
    })
    await mediaStore.put({
      deviceId: 10,
      ownerKind: 'face',
      ownerId: 'face-M1',
      kind: 'crop',
      timestamp: 1000,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    const media = await provider.getFaceMedia({ faceId: 'face-M1' })
    expect(media).toHaveLength(1)
    expect(media[0]!.kind).toBe('crop')
    // The row ADDRESSES its crop on the event-media plane and carries no
    // bytes. This assertion used to be `base64`.toBeDefined()`; leaving it
    // would have described the old contract while the new one shipped.
    expect(media[0]!.url).toBe(`/addon/pipeline-analytics/event-media/m/${media[0]!.mediaId}`)
    expect(media[0]!).not.toHaveProperty('base64')
  })

  it('returns empty list when face has no media', async () => {
    const { provider } = await makeProviderWithSpies()
    const media = await provider.getFaceMedia({ faceId: 'face-none' })
    expect(media).toHaveLength(0)
  })
})

/**
 * An enrolled sample must name the model that ACTUALLY produced its vector.
 *
 * `assignFace` used to stamp a hardcoded `MODEL_ID = 'arcface-r100'` on every
 * sample, whatever the pipeline had really run. That constant was correct only
 * for as long as nobody ever changed `face-embedding`'s model — and the moment
 * someone did, the gallery would fill with AuraFace vectors labelled ArcFace.
 * A mislabelled sample is worse than a missing one: `face-matcher` trusts
 * `modelId` to keep feature spaces apart, so the lie defeats the only guard
 * there is, permanently and with nothing in the data to reveal it.
 */
describe('FaceGalleryProvider — an enrolled sample names its real model', () => {
  it('stamps the sample with the model the FACE ROW recorded, not a constant', async () => {
    const { provider, faceStore, identityStore } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Aura' })

    await faceStore.insert({
      id: 'face-AURA',
      deviceId: 99,
      trackId: 'TA',
      timestamp: 5000,
      embedding: [0.3, 0.4],
      embeddingModelId: 'auraface-r100',
      assigned: false,
    })

    await provider.assignFace({ faceId: 'face-AURA', identityId: identity.id })

    const gallery = await identityStore.loadGallery()
    expect(gallery.find((s) => s.identityId === identity.id)?.modelId).toBe('auraface-r100')
  })

  it('falls back to arcface-r100 for a legacy row that recorded no model', async () => {
    const { provider, faceStore, identityStore } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Legacy' })

    await faceStore.insert({
      id: 'face-LEGACY',
      deviceId: 99,
      trackId: 'TL',
      timestamp: 5000,
      embedding: [0.3, 0.4],
      assigned: false,
    })

    await provider.assignFace({ faceId: 'face-LEGACY', identityId: identity.id })

    const gallery = await identityStore.loadGallery()
    expect(gallery.find((s) => s.identityId === identity.id)?.modelId).toBe('arcface-r100')
  })
})

describe('FaceGalleryProvider — assignFace', () => {
  it('re-owns crop to identity, enrolls a sample, marks face assigned, and labels track', async () => {
    const {
      provider,
      faceStore,
      identityStore,
      mediaStore,
      trackStore,
      trackSetLabelSpy,
      eventSetLabelSpy,
      refreshGallery,
    } = await makeProviderWithSpies()

    const identity = await provider.createIdentity({ name: 'Bob' })

    // Insert a face with a crop key
    await faceStore.insert({
      id: 'face-T9',
      deviceId: 99,
      trackId: 'T9',
      timestamp: 5000,
      embedding: [0.3, 0.4],
      assigned: false,
    })
    // Put media under face owner
    const mediaId = await mediaStore.put({
      deviceId: 99,
      ownerKind: 'face',
      ownerId: 'face-T9',
      kind: 'crop',
      timestamp: 5000,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    // Update face to have the mediaId
    await faceStore.insert({
      id: 'face-T9',
      deviceId: 99,
      trackId: 'T9',
      timestamp: 5000,
      embedding: [0.3, 0.4],
      mediaId,
      assigned: false,
    })

    // The TRACK has to exist: the events copy the track's accepted decision,
    // so a track that is neither active nor persisted labels nothing. Without
    // this row the assertion below passed against a code path that could not
    // run in production.
    trackStore.upsert({
      trackId: 'T9',
      deviceId: 99,
      className: 'person',
      timestamp: 5000,
      position: { x: 0, y: 0, timestamp: 5000, bbox: { x: 0, y: 0, w: 10, h: 10 } },
      zones: [],
      state: 'new',
    })

    await provider.assignFace({ faceId: 'face-T9', identityId: identity.id })

    // Face should now be marked assigned with recognizedIdentityId
    const face = await faceStore.get('face-T9')
    expect(face!.assigned).toBe(true)
    expect(face!.recognizedIdentityId).toBe(identity.id)
    expect(face!.assignedSampleId).toBeDefined()

    // A sample should have been enrolled with correct source and deviceId (via listSamples)
    // and with modelId 'arcface-r100' (via loadGallery which exposes the full row)
    const samples = await identityStore.listSamples(identity.id)
    expect(samples).toHaveLength(1)
    expect(samples[0]!.id).toBe(face!.assignedSampleId)
    expect(samples[0]!.source).toBe('detected')
    expect(samples[0]!.deviceId).toBe(99)
    const gallery = await identityStore.loadGallery()
    expect(gallery.find((s) => s.identityId === identity.id)?.modelId).toBe('arcface-r100')

    // Media should now live under identity owner (reown happened)
    const faceMedia = await mediaStore.listByOwner('face', 'face-T9')
    const identityMedia = await mediaStore.listByOwner('identity', identity.id)
    expect(faceMedia).toHaveLength(0)
    expect(identityMedia).toHaveLength(1)

    // Label should have been propagated
    // An identity is TIER 2, and a hand assignment carries operator authority:
    // arcface routinely answers at 1.0, so without it a correction would lose.
    const expectedIdentity = expect.objectContaining({
      text: 'Bob',
      tier: 2,
      operatorAuthority: true,
    })
    expect(trackSetLabelSpy).toHaveBeenCalledWith('T9', expectedIdentity)
    // The events receive the PATCH the track accepted, never the candidate.
    expect(eventSetLabelSpy).toHaveBeenCalledWith(
      'T9',
      expect.objectContaining({ subLabel: 'Bob' }),
    )

    // Gallery refresh should have been triggered
    expect(refreshGallery).toHaveBeenCalled()

    // Regression: an assigned face still exposes its crop. The crop was re-owned
    // to the identity, so listByOwner('face',…) is empty — the inline base64 must
    // be resolved via the face's mediaId instead (else the card shows an icon).
    const byTrack = await provider.getFaceByTrack({ deviceId: 99, trackId: 'T9' })
    expect(byTrack?.cropUrl).toBeDefined()
    expect(byTrack?.base64).toBeUndefined()
    // Asks for the crop on purpose: what this asserts is that the image FOLLOWED
    // the face, not what the default shape is.
    const recent = await provider.listRecentFaces({ filter: 'all', includeCrops: true })
    expect(recent.find((f) => f.faceId === 'face-T9')?.base64).toBeDefined()

    // Regression: assignment sets the identity cover (was skipped when the fresh
    // identity's coverMediaId came back as SQL NULL) → People avatar shows a face.
    // The avatar now rides `coverMediaId` off the event-media plane, so THAT is
    // what has to be set; the inline bytes are the opt-in, asserted beside it so
    // a cover that resolves to no media still fails.
    const enrolled = (await provider.listIdentities()).find((i) => i.id === identity.id)
    expect(enrolled?.coverMediaId).toBeDefined()
    const enrolledInline = (await provider.listIdentities({ includeCrops: true })).find(
      (i) => i.id === identity.id,
    )
    expect(enrolledInline?.coverBase64).toBeDefined()
  })

  it('assignFace without mediaId still enrolls sample (no reown)', async () => {
    const { provider, faceStore, identityStore } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Carol' })
    await faceStore.insert({
      id: 'face-T10',
      deviceId: 5,
      trackId: 'T10',
      timestamp: 6000,
      embedding: [0.5, 0.6],
      assigned: false,
    })

    await provider.assignFace({ faceId: 'face-T10', identityId: identity.id })

    const samples = await identityStore.listSamples(identity.id)
    expect(samples).toHaveLength(1)
    const face = await faceStore.get('face-T10')
    expect(face!.assigned).toBe(true)
    expect(face!.assignedSampleId).toBeDefined()
  })

  it('throws when face does not exist', async () => {
    const { provider } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Dan' })
    await expect(
      provider.assignFace({ faceId: 'nonexistent', identityId: identity.id }),
    ).rejects.toThrow()
  })

  it('reassign A→B: removes prior sample+media from A, enrolls new sample under B, no throw', async () => {
    const { provider, faceStore, identityStore, mediaStore } = await makeProviderWithSpies()

    const identityA = await provider.createIdentity({ name: 'AssignA' })
    const identityB = await provider.createIdentity({ name: 'AssignB' })

    // Insert face with a face-owned crop
    await faceStore.insert({
      id: 'face-REASSIGN1',
      deviceId: 11,
      trackId: 'REASSIGN1',
      timestamp: 10000,
      embedding: [0.1, 0.2],
      assigned: false,
    })
    const mediaId = await mediaStore.put({
      deviceId: 11,
      ownerKind: 'face',
      ownerId: 'face-REASSIGN1',
      kind: 'crop',
      timestamp: 10000,
      data: Buffer.from([0xaa, 0xbb, 0xcc]),
    })
    await faceStore.insert({
      id: 'face-REASSIGN1',
      deviceId: 11,
      trackId: 'REASSIGN1',
      timestamp: 10000,
      embedding: [0.1, 0.2],
      mediaId,
      assigned: false,
    })

    // First assign: face → identity A
    await provider.assignFace({ faceId: 'face-REASSIGN1', identityId: identityA.id })
    const samplesA_after_first = await identityStore.listSamples(identityA.id)
    expect(samplesA_after_first).toHaveLength(1)

    // Second assign: same face → identity B (should NOT throw)
    await expect(
      provider.assignFace({ faceId: 'face-REASSIGN1', identityId: identityB.id }),
    ).resolves.toBeUndefined()

    // Identity A must have 0 samples and no durable media
    const samplesA_after_reassign = await identityStore.listSamples(identityA.id)
    expect(samplesA_after_reassign).toHaveLength(0)
    const mediaA = await mediaStore.listByOwner('identity', identityA.id)
    expect(mediaA).toHaveLength(0)

    // Identity B must have exactly 1 sample
    const samplesB = await identityStore.listSamples(identityB.id)
    expect(samplesB).toHaveLength(1)

    // Face must reflect the new identity assignment
    const face = await faceStore.get('face-REASSIGN1')
    expect(face!.assigned).toBe(true)
    expect(face!.recognizedIdentityId).toBe(identityB.id)
    expect(face!.assignedSampleId).toBeDefined()
    expect(face!.assignedSampleId).toBe(samplesB[0]!.id)
  })

  it('re-assign to same identity does not duplicate samples (ends with exactly 1)', async () => {
    const { provider, faceStore, identityStore } = await makeProviderWithSpies()

    const identity = await provider.createIdentity({ name: 'SameIdentity' })

    await faceStore.insert({
      id: 'face-RESAMEIDX',
      deviceId: 12,
      trackId: 'RESAMEIDX',
      timestamp: 11000,
      embedding: [0.3, 0.4],
      assigned: false,
    })

    // First assign
    await provider.assignFace({ faceId: 'face-RESAMEIDX', identityId: identity.id })
    expect(await identityStore.listSamples(identity.id)).toHaveLength(1)

    // Second assign to SAME identity — should NOT throw and must NOT duplicate
    await expect(
      provider.assignFace({ faceId: 'face-RESAMEIDX', identityId: identity.id }),
    ).resolves.toBeUndefined()

    const samples = await identityStore.listSamples(identity.id)
    expect(samples).toHaveLength(1)
    const face = await faceStore.get('face-RESAMEIDX')
    expect(face!.assigned).toBe(true)
    expect(face!.recognizedIdentityId).toBe(identity.id)
  })
})

describe('FaceGalleryProvider — unassignFace', () => {
  it('removes enrolled sample + clears face assignment after assignFace', async () => {
    const {
      provider,
      faceStore,
      identityStore,
      mediaStore,
      trackClearLabelSpy,
      eventClearLabelSpy,
      refreshGallery,
    } = await makeProviderWithSpies()

    const identity = await provider.createIdentity({ name: 'Eve' })

    // Insert face with media
    await faceStore.insert({
      id: 'face-UA1',
      deviceId: 10,
      trackId: 'UA1',
      timestamp: 7000,
      embedding: [0.7, 0.8],
      assigned: false,
    })
    const mediaId = await mediaStore.put({
      deviceId: 10,
      ownerKind: 'face',
      ownerId: 'face-UA1',
      kind: 'crop',
      timestamp: 7000,
      data: Buffer.from([0x01, 0x02]),
    })
    await faceStore.insert({
      id: 'face-UA1',
      deviceId: 10,
      trackId: 'UA1',
      timestamp: 7000,
      embedding: [0.7, 0.8],
      mediaId,
      assigned: false,
    })

    // First assign
    await provider.assignFace({ faceId: 'face-UA1', identityId: identity.id })
    expect(await identityStore.listSamples(identity.id)).toHaveLength(1)

    // Reset call counts so we can check unassign triggers refresh
    refreshGallery.mockClear()

    // Now unassign
    await provider.unassignFace({ faceId: 'face-UA1' })

    // Face should be cleared
    const face = await faceStore.get('face-UA1')
    expect(face!.assigned).toBe(false)
    expect(face!.recognizedIdentityId).toBeUndefined()
    expect(face!.assignedSampleId).toBeUndefined()

    // Sample row should be removed
    const samples = await identityStore.listSamples(identity.id)
    expect(samples).toHaveLength(0)

    // The crop is PRESERVED: re-owned back from identity → face (not deleted),
    // so the identity owns no media and the face owns its crop again.
    const identityMedia = await mediaStore.listByOwner('identity', identity.id)
    expect(identityMedia).toHaveLength(0)
    const faceMedia = await mediaStore.listByOwner('face', 'face-UA1')
    expect(faceMedia).toHaveLength(1)
    // The face is back in the unassigned buffer WITH its image (re-assignable).
    const recent = await provider.listRecentFaces({ filter: 'unassigned', includeCrops: true })
    expect(recent.find((f) => f.faceId === 'face-UA1')?.base64).toBeDefined()

    // Label-clear should have been called on both stores
    // Tier 2 only: an identity is what unassign takes back. A tier-1 sub-class
    // on the same track was decided by something else and is still true.
    expect(trackClearLabelSpy).toHaveBeenCalledWith('UA1', 2)
    expect(eventClearLabelSpy).toHaveBeenCalledWith('UA1', 2)

    // Gallery refresh should have been triggered
    expect(refreshGallery).toHaveBeenCalled()
  })

  it('label is cleared (undefined) on the track after unassign', async () => {
    const { provider, faceStore, trackStore, eventStore } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'LabelTest' })

    await faceStore.insert({
      id: 'face-LBL1',
      deviceId: 10,
      trackId: 'LBL1',
      timestamp: 9000,
      embedding: [0.1],
      assigned: false,
    })

    // Upsert track and emit an object event so label-clear has rows to touch
    // (TrackStore.declare was already called in makeProviderWithSpies)
    trackStore.upsert({
      trackId: 'LBL1',
      deviceId: 10,
      className: 'person',
      timestamp: 9000,
      position: { x: 0, y: 0, timestamp: 9000, bbox: { x: 0, y: 0, w: 10, h: 10 } },
      zones: [],
      state: 'new',
    })
    await eventStore.insertObject({
      kind: 'object',
      deviceId: 10,
      timestamp: 9000,
      trackId: 'LBL1',
      className: 'person',
      confidence: 0.9,
    })

    await provider.assignFace({ faceId: 'face-LBL1', identityId: identity.id })

    // The identity lands in TIER 2 — `subLabel`, not `label`.
    const trackAfterAssign = trackStore.getActiveByTrack('LBL1')
    expect(trackAfterAssign?.subLabel).toBe('LabelTest')

    await provider.unassignFace({ faceId: 'face-LBL1' })

    // Track tier 2 should be cleared (undefined/absent)
    const trackAfterUnassign = trackStore.getActiveByTrack('LBL1')
    expect(trackAfterUnassign?.subLabel).toBeUndefined()

    // Object event tier 2 should be cleared (null in store → absent on read)
    const events = await eventStore.queryObject({ deviceId: 10 })
    const evt = events.find((e) => e.trackId === 'LBL1')
    expect(evt?.subLabel).toBeUndefined()
  })

  it('unassignFace on a non-assigned face clears it cleanly (no error)', async () => {
    const { provider, faceStore } = await makeProviderWithSpies()
    await faceStore.insert({
      id: 'face-UA2',
      deviceId: 10,
      trackId: 'UA2',
      timestamp: 8000,
      embedding: [0.1],
      assigned: false,
    })
    await expect(provider.unassignFace({ faceId: 'face-UA2' })).resolves.toBeUndefined()
    const face = await faceStore.get('face-UA2')
    expect(face!.assigned).toBe(false)
  })

  it('unassignFace clears sample when assignedSampleId present even without recognizedIdentityId', async () => {
    // Regression for the guard bug: old guard required BOTH assignedSampleId AND
    // recognizedIdentityId — a face that had a sampleId but no recognizedIdentityId
    // (race condition) would skip sample cleanup. The fixed guard only requires
    // assignedSampleId (plus a valid owningIdentityId to find the sample owner).
    const { provider, faceStore, identityStore } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'RaceTest' })

    await faceStore.insert({
      id: 'face-RACE1',
      deviceId: 10,
      trackId: 'RACE1',
      timestamp: 9500,
      embedding: [0.2],
      assigned: false,
    })

    // Simulate: assignFace ran → sample enrolled, but recognizedIdentityId
    // was never set (race with recognizer clearing it). We manually set the
    // state to test the edge-case guard.
    await provider.assignFace({ faceId: 'face-RACE1', identityId: identity.id })
    // Verify sample was enrolled
    expect(await identityStore.listSamples(identity.id)).toHaveLength(1)
    // Normal unassign should still clean up correctly
    await provider.unassignFace({ faceId: 'face-RACE1' })
    expect(await identityStore.listSamples(identity.id)).toHaveLength(0)
  })

  it('throws when face does not exist', async () => {
    const { provider } = await makeProviderWithSpies()
    await expect(provider.unassignFace({ faceId: 'nonexistent' })).rejects.toThrow()
  })

  it('deleteIdentity detaches its assigned faces (crop preserved, no orphans)', async () => {
    const { provider, faceStore, mediaStore } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'ToDelete' })
    await faceStore.insert({
      id: 'face-DI1',
      deviceId: 10,
      trackId: 'DI1',
      timestamp: 100,
      embedding: [0.5],
      assigned: false,
    })
    const mk = await mediaStore.put({
      deviceId: 10,
      ownerKind: 'face',
      ownerId: 'face-DI1',
      kind: 'crop',
      timestamp: 100,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    await faceStore.insert({
      id: 'face-DI1',
      deviceId: 10,
      trackId: 'DI1',
      timestamp: 100,
      embedding: [0.5],
      mediaId: mk,
      assigned: false,
    })
    await provider.assignFace({ faceId: 'face-DI1', identityId: identity.id })

    await provider.deleteIdentity({ id: identity.id })

    // Identity gone…
    expect((await provider.listIdentities()).find((i) => i.id === identity.id)).toBeUndefined()
    // …but the face is detached (not orphaned to a deleted identity) and keeps its crop.
    const face = await faceStore.get('face-DI1')
    expect(face!.assigned).toBe(false)
    expect(face!.recognizedIdentityId).toBeUndefined()
    expect(await mediaStore.listByOwner('face', 'face-DI1')).toHaveLength(1)
    const recent = await provider.listRecentFaces({ filter: 'unassigned', includeCrops: true })
    expect(recent.find((f) => f.faceId === 'face-DI1')?.base64).toBeDefined()
  })
})

describe('FaceGalleryProvider — batch ops + clustering', () => {
  async function seedFace(
    faceStore: FaceStore,
    mediaStore: MediaStore,
    id: string,
    embedding: number[],
  ): Promise<void> {
    await faceStore.insert({
      id,
      deviceId: 10,
      trackId: id,
      timestamp: 1,
      embedding,
      assigned: false,
    })
    const mk = await mediaStore.put({
      deviceId: 10,
      ownerKind: 'face',
      ownerId: id,
      kind: 'crop',
      timestamp: 1,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    await faceStore.insert({
      id,
      deviceId: 10,
      trackId: id,
      timestamp: 1,
      embedding,
      mediaId: mk,
      assigned: false,
    })
  }

  it('deleteFace removes the row + its crop media', async () => {
    const { provider, faceStore, mediaStore } = await makeProviderWithSpies()
    await seedFace(faceStore, mediaStore, 'face-D1', [1, 0])
    await provider.deleteFace({ faceId: 'face-D1' })
    expect(await faceStore.get('face-D1')).toBeNull()
    expect(await mediaStore.listByOwner('face', 'face-D1')).toHaveLength(0)
  })

  it('deleteFace is idempotent on a missing face', async () => {
    const { provider } = await makeProviderWithSpies()
    await expect(provider.deleteFace({ faceId: 'nope' })).resolves.toBeUndefined()
  })

  it('assignFaces batch-assigns to one identity and reports failures', async () => {
    const { provider, faceStore, mediaStore, emitFake } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Batch' })
    await seedFace(faceStore, mediaStore, 'face-B1', [1, 0])
    await seedFace(faceStore, mediaStore, 'face-B2', [0.9, 0.1])
    const res = await provider.assignFaces({
      faceIds: ['face-B1', 'face-B2', 'face-missing'],
      identityId: identity.id,
    })
    expect(res.assigned).toBe(2)
    expect(res.failed).toEqual(['face-missing'])
    expect((await faceStore.get('face-B1'))!.recognizedIdentityId).toBe(identity.id)

    // Batch failure-exclusion: only successful assignments emit, failed face is excluded
    expect(emitFake.emitted).toHaveLength(2)
    expect(emitFake.emitted[0]).toEqual({ deviceId: 10, faceId: 'face-B1', kind: 'assigned' })
    expect(emitFake.emitted[1]).toEqual({ deviceId: 10, faceId: 'face-B2', kind: 'assigned' })
  })

  it('unassignFaces batch-detaches', async () => {
    const { provider, faceStore, mediaStore, emitFake } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Batch2' })
    await seedFace(faceStore, mediaStore, 'face-U1', [1, 0])
    await seedFace(faceStore, mediaStore, 'face-U2', [0, 1])
    await provider.assignFaces({ faceIds: ['face-U1', 'face-U2'], identityId: identity.id })
    emitFake.emitted.length = 0 // clear the assignFaces emits
    const res = await provider.unassignFaces({ faceIds: ['face-U1', 'face-U2'] })
    expect(res.unassigned).toBe(2)
    expect((await faceStore.get('face-U1'))!.assigned).toBe(false)

    // unassignFaces emit: one event per face with correct faceId + deviceId
    expect(emitFake.emitted).toHaveLength(2)
    expect(emitFake.emitted[0]).toEqual({ deviceId: 10, faceId: 'face-U1', kind: 'unassigned' })
    expect(emitFake.emitted[1]).toEqual({ deviceId: 10, faceId: 'face-U2', kind: 'unassigned' })
  })

  it('suggestFaceClusters groups similar unassigned faces (excludes assigned)', async () => {
    const { provider, faceStore, mediaStore } = await makeProviderWithSpies()
    await seedFace(faceStore, mediaStore, 'face-C1', [1, 0, 0])
    await seedFace(faceStore, mediaStore, 'face-C2', [0.97, 0.24, 0])
    await seedFace(faceStore, mediaStore, 'face-C3', [0, 1, 0]) // different
    const clusters = await provider.suggestFaceClusters({ threshold: 0.7, minClusterSize: 2 })
    expect(clusters).toHaveLength(1)
    expect(new Set(clusters[0]!.faceIds)).toEqual(new Set(['face-C1', 'face-C2']))
  })
})

// ── D1: face-gallery-changed bus emit ───────────────────────────────

describe('FaceGalleryProvider — face-gallery-changed emit', () => {
  async function seedFace(
    faceStore: FaceStore,
    mediaStore: MediaStore,
    id: string,
    deviceId: number,
  ): Promise<void> {
    await faceStore.insert({
      id,
      deviceId,
      trackId: id,
      timestamp: 1,
      embedding: [1, 0],
      assigned: false,
    })
    const mk = await mediaStore.put({
      deviceId,
      ownerKind: 'face',
      ownerId: id,
      kind: 'crop',
      timestamp: 1,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    await faceStore.insert({
      id,
      deviceId,
      trackId: id,
      timestamp: 1,
      embedding: [1, 0],
      mediaId: mk,
      assigned: false,
    })
  }

  it('assignFace emits exactly one face-gallery-changed with kind:assigned', async () => {
    const { provider, faceStore, mediaStore, emitFake } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Emit-Assign' })
    await seedFace(faceStore, mediaStore, 'face-E1', 42)

    await provider.assignFace({ faceId: 'face-E1', identityId: identity.id })

    expect(emitFake.emitted).toHaveLength(1)
    expect(emitFake.emitted[0]).toEqual({ deviceId: 42, faceId: 'face-E1', kind: 'assigned' })
  })

  it('unassignFace emits exactly one face-gallery-changed with kind:unassigned', async () => {
    const { provider, faceStore, mediaStore, emitFake } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Emit-Unassign' })
    await seedFace(faceStore, mediaStore, 'face-E2', 43)
    await provider.assignFace({ faceId: 'face-E2', identityId: identity.id })
    emitFake.emitted.length = 0 // clear the assign emit so we isolate unassign

    await provider.unassignFace({ faceId: 'face-E2' })

    expect(emitFake.emitted).toHaveLength(1)
    expect(emitFake.emitted[0]).toEqual({ deviceId: 43, faceId: 'face-E2', kind: 'unassigned' })
  })

  it('deleteFace emits exactly one face-gallery-changed with kind:deleted', async () => {
    const { provider, faceStore, mediaStore, emitFake } = await makeProviderWithSpies()
    await seedFace(faceStore, mediaStore, 'face-E3', 44)

    await provider.deleteFace({ faceId: 'face-E3' })

    expect(emitFake.emitted).toHaveLength(1)
    expect(emitFake.emitted[0]).toEqual({ deviceId: 44, faceId: 'face-E3', kind: 'deleted' })
  })

  it('deleteFace on an assigned face emits unassigned THEN deleted (2 events)', async () => {
    const { provider, faceStore, mediaStore, emitFake } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Emit-DeleteAssigned' })
    await seedFace(faceStore, mediaStore, 'face-E4', 45)
    await provider.assignFace({ faceId: 'face-E4', identityId: identity.id })
    emitFake.emitted.length = 0

    await provider.deleteFace({ faceId: 'face-E4' })

    expect(emitFake.emitted.map((e) => e.kind)).toEqual(['unassigned', 'deleted'])
  })

  it('assignFaces (batch of N) emits N face-gallery-changed events', async () => {
    const { provider, faceStore, mediaStore, emitFake } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Emit-Batch' })
    await seedFace(faceStore, mediaStore, 'face-EB1', 46)
    await seedFace(faceStore, mediaStore, 'face-EB2', 46)

    await provider.assignFaces({ faceIds: ['face-EB1', 'face-EB2'], identityId: identity.id })

    expect(emitFake.emitted).toHaveLength(2)
    expect(emitFake.emitted.every((e) => e.kind === 'assigned')).toBe(true)
  })
})

describe('FaceGalleryProvider — assignFace stamps the alignment (D643)', () => {
  it('a face CAPTURED after the fix enrols as scrfd-v2; one captured before enrols unstamped', async () => {
    const { provider, faceStore, identityStore } = await makeProviderWithSpies()
    const identity = await provider.createIdentity({ name: 'Alice' })
    await faceStore.insert({
      id: 'face-NEW',
      deviceId: 101,
      trackId: 'TN',
      timestamp: SCRFD_V2_ALIGNMENT_SINCE_MS + 1000,
      embedding: [0.3, 0.4],
      embeddingModelId: 'auraface-r100',
      assigned: false,
    })
    await faceStore.insert({
      id: 'face-OLD',
      deviceId: 101,
      trackId: 'TO',
      timestamp: SCRFD_V2_ALIGNMENT_SINCE_MS - 1000,
      embedding: [0.4, 0.3],
      embeddingModelId: 'auraface-r100',
      assigned: false,
    })
    await provider.assignFace({ faceId: 'face-NEW', identityId: identity.id })
    await provider.assignFace({ faceId: 'face-OLD', identityId: identity.id })

    const samples = await identityStore.listSamples(identity.id)
    const stamps = samples.map((s) => s.alignment ?? 'v1').toSorted()
    expect(stamps).toEqual(['scrfd-v2', 'v1'])
  })

  it('tells the addon an identity gained a detected sample (the after-enrol prune trigger)', async () => {
    const { faceStore, identityStore, mediaStore, trackStore, eventStore } =
      await makeProviderWithSpies()
    const enrolled: string[] = []
    const provider = new FaceGalleryProvider({
      identityStore,
      faceStore,
      mediaStore,
      trackStore,
      eventStore,
      logger: makeSilentLogger(),
      refreshGallery: () => {},
      eventMediaBaseUrl: () => EVENT_MEDIA_BASE,
      eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
      onSampleEnrolled: (identityId) => enrolled.push(identityId),
      emitFaceGalleryChanged: () => {},
      ...testFaceGalleryModelPins,
    })
    const identity = await provider.createIdentity({ name: 'Carol' })
    await faceStore.insert({
      id: 'face-D',
      deviceId: 101,
      trackId: 'TD',
      timestamp: SCRFD_V2_ALIGNMENT_SINCE_MS + 1000,
      embedding: [0.3, 0.4],
      embeddingModelId: 'auraface-r100',
      assigned: false,
    })
    await provider.assignFace({ faceId: 'face-D', identityId: identity.id })
    expect(enrolled).toEqual([identity.id])
  })
})

describe('FaceGalleryProvider — removing a sample a buffered face was enrolled as (I3)', () => {
  async function assignWithCrop(
    h: Awaited<ReturnType<typeof makeProviderWithSpies>>,
    faceId: string,
    trackId: string,
    identityId: string,
    embedding: readonly number[],
  ): Promise<void> {
    const mediaId = await h.mediaStore.put({
      deviceId: 101,
      ownerKind: 'face',
      ownerId: faceId,
      kind: 'crop',
      timestamp: 5000,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    await h.faceStore.insert({
      id: faceId,
      deviceId: 101,
      trackId,
      timestamp: SCRFD_V2_ALIGNMENT_SINCE_MS - 1,
      embedding: [...embedding],
      embeddingModelId: 'auraface-r100',
      mediaId,
      assigned: false,
    })
    await h.provider.assignFace({ faceId, identityId })
  }

  it('the face keeps its assignment and loses the references that died with the sample', async () => {
    const h = await makeProviderWithSpies()
    const identity = await h.provider.createIdentity({ name: 'Carol' })
    await assignWithCrop(h, 'face-A', 'TA', identity.id, [0.3, 0.4])
    const assigned = await h.faceStore.get('face-A')
    const sampleId = assigned?.assignedSampleId
    expect(sampleId).toBeDefined()
    if (sampleId === undefined) return

    await h.provider.removeSample({ identityId: identity.id, sampleId })

    const face = await h.faceStore.get('face-A')
    expect(face).not.toBeNull()
    expect(face?.assigned).toBe(true)
    expect(face?.recognizedIdentityId).toBe(identity.id)
    expect(face?.assignedSampleId).toBeUndefined()
    // The crop was the sample's blob and is gone — the face must not name it.
    expect(face?.mediaId).toBeUndefined()
  })

  it('a later unassign does not count the pruned sample out a second time', async () => {
    const h = await makeProviderWithSpies()
    const identity = await h.provider.createIdentity({ name: 'Carol' })
    await assignWithCrop(h, 'face-A', 'TA', identity.id, [0.3, 0.4])
    await assignWithCrop(h, 'face-B', 'TB', identity.id, [0.4, 0.3])
    const sampleA = (await h.faceStore.get('face-A'))?.assignedSampleId
    if (sampleA === undefined) throw new Error('face-A was not enrolled')

    await h.provider.removeSample({ identityId: identity.id, sampleId: sampleA })
    await h.provider.unassignFace({ faceId: 'face-A' })

    const [after] = (await h.identityStore.listIdentities()).filter((i) => i.id === identity.id)
    expect(after?.sampleCount).toBe(1)
    expect(await h.identityStore.listSamples(identity.id)).toHaveLength(1)
  })
})
