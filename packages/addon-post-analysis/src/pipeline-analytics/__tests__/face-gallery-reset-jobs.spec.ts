/**
 * `FaceAlignmentJobs.resetToCore` over the REAL stores (D644).
 *
 * The pure rule is pinned in `face-gallery-reset.spec.ts`. What only the real
 * stores can show is what the reset does to the REST of the system:
 *
 *  - an assigned face whose sample is discarded keeps its assignment and its
 *    identity — it is DETACHED, never deleted;
 *  - an auto-recognised face (an identity on a track, not assigned) stays;
 *  - pending faces (unassigned, with or without a suggestion) go, with their
 *    face-owned media;
 *  - a dry run changes no row and no blob;
 *  - the reset refuses while any other gallery job runs.
 */
import { describe, expect, it, vi } from 'vitest'
import { FaceAlignmentJobs } from '../face-alignment-jobs.js'
import { FaceGalleryProvider } from '../face-gallery-provider.js'
import { FACE_ARCFACE_INDEX, IDENTITY_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { FaceStore } from '../store/face-store.js'
import { IdentityStore } from '../store/identity-store.js'
import { MediaStore } from '../store/media-store.js'
import type { EventStore } from '../store/event-store.js'
import type { TrackStore } from '../store/track-store.js'
import {
  makeFakeEmbeddingIndex,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
} from './test-helpers.js'
import { makeAnalyticsWorld } from './fake-records.js'

const MODEL = 'auraface-r100'

interface ResetHarness {
  readonly jobs: FaceAlignmentJobs
  readonly identityStore: IdentityStore
  readonly faceStore: FaceStore
  readonly mediaStore: MediaStore
  readonly identityId: string
  readonly farSampleId: string
  readonly pendingCropId: number
  reembedRunning: boolean
}

/**
 * The provider's `removeSample` is the path under test for the detach; it
 * never reads the track or event stores, so none is supplied.
 */
function unusedTrackStore(): TrackStore {
  return new Proxy<TrackStore>(Object.create(null), {
    get: () => {
      throw new Error('the reset must not touch the track store')
    },
  })
}
function unusedEventStore(): EventStore {
  return new Proxy<EventStore>(Object.create(null), {
    get: () => {
      throw new Error('the reset must not touch the event store')
    },
  })
}

async function makeHarness(): Promise<ResetHarness> {
  const fake = makeFakeSettingsStore()
  const logger = makeSilentLogger()
  const { ledgers } = await makeAnalyticsWorld()
  const identityStore = new IdentityStore({
    identityLedger: ledgers.identities,
    sampleLedger: ledgers.identitySamples,
    vectors: makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX).vectors,
    logger,
  })
  const mediaStore = new MediaStore({
    storage: makeFakeStorageProvider(),
    store: fake.client,
    logger,
  })
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
    trackStore: unusedTrackStore(),
    eventStore: unusedEventStore(),
    logger,
    refreshGallery: () => {},
    resolveClusterModelId: async () => MODEL,
    resolveAutoAssignThreshold: async () => 0.5,
    eventMediaBaseUrl: () => null,
    eventMediaPathPrefix: () => '/x',
    emitFaceGalleryChanged: () => {},
  })

  const identity = await identityStore.createIdentity({ name: 'Alice' })
  const vectors: readonly (readonly number[])[] = [
    [1, 0, 0],
    [0.99, 0.1, 0],
    [0.98, 0, 0.1],
    [0.97, 0.1, 0.1],
    [0, 0, 1],
  ]
  const ids: string[] = []
  for (const [i, embedding] of vectors.entries()) {
    const mediaId = await mediaStore.put({
      deviceId: 101,
      ownerKind: 'identity',
      ownerId: identity.id,
      kind: 'crop',
      timestamp: i,
      data: Buffer.from(`t${i}`),
    })
    const s = await identityStore.addSample({
      identityId: identity.id,
      embedding,
      modelId: MODEL,
      source: 'detected',
      deviceId: 101,
      mediaId,
    })
    ids.push(s.id)
  }
  const farSampleId = ids[4] ?? ''

  const face = (id: string, extra: Partial<Parameters<FaceStore['insert']>[0]>) =>
    faceStore.insert({
      id,
      deviceId: 101,
      trackId: id.slice('face-'.length),
      timestamp: 1,
      embedding: [1, 0, 0],
      embeddingModelId: MODEL,
      assigned: false,
      ...extra,
    })
  // The assigned face enrolled as the FAR sample, which the reset discards.
  await face('face-assigned', {
    assigned: true,
    recognizedIdentityId: identity.id,
    assignedSampleId: farSampleId,
  })
  await face('face-recognized', { recognizedIdentityId: identity.id })
  const pendingCropId = await mediaStore.put({
    deviceId: 101,
    ownerKind: 'face',
    ownerId: 'face-pending',
    kind: 'crop',
    timestamp: 1,
    data: Buffer.from('pending-crop'),
  })
  await face('face-pending', { mediaId: pendingCropId })
  await face('face-suggested', { suggestedIdentityId: identity.id, suggestedMatchScore: 0.4 })

  const h: ResetHarness = {
    identityStore,
    faceStore,
    mediaStore,
    identityId: identity.id,
    farSampleId,
    pendingCropId,
    reembedRunning: false,
    jobs: new FaceAlignmentJobs({
      stores: () => ({ identityStore, mediaStore, faceStore }),
      analyzePhoto: async () => {
        throw new Error('no re-alignment in these tests')
      },
      removeDetectedSample: (identityId, sampleId) =>
        provider.removeSample({ identityId, sampleId }),
      refreshGallery: async () => {},
      isReembedRunning: () => h.reembedRunning,
      logger,
    }),
  }
  return h
}

describe('FaceAlignmentJobs.resetToCore over the REAL stores', () => {
  it('keeps 3, detaches the assigned face of a discarded sample, keeps history, drops pending faces', async () => {
    const h = await makeHarness()
    const result = await h.jobs.resetToCore({})

    const samples = await h.identityStore.listSamples(h.identityId)
    expect(samples).toHaveLength(3)
    expect(samples.map((s) => s.id)).not.toContain(h.farSampleId)
    expect(result.totals.removed).toBe(2)

    const assigned = await h.faceStore.get('face-assigned')
    expect(assigned?.assigned).toBe(true)
    expect(assigned?.recognizedIdentityId).toBe(h.identityId)
    expect(assigned?.assignedSampleId).toBeUndefined()

    expect(await h.faceStore.get('face-recognized')).not.toBeNull()
    expect(await h.faceStore.get('face-pending')).toBeNull()
    expect(await h.faceStore.get('face-suggested')).toBeNull()
    expect(await h.mediaStore.getById(h.pendingCropId)).toBeNull()
    expect(result.pendingFaces).toEqual({ found: 2, deleted: 2 })

    const [identity] = await h.identityStore.listIdentities()
    expect(identity?.sampleCount).toBe(3)
  })

  it('a dry run changes no row and no blob', async () => {
    const h = await makeHarness()
    const result = await h.jobs.resetToCore({ dryRun: true })
    expect(result.totals.wouldRemove).toBe(2)
    expect(await h.identityStore.listSamples(h.identityId)).toHaveLength(5)
    expect(await h.faceStore.get('face-pending')).not.toBeNull()
    expect(await h.mediaStore.getById(h.pendingCropId)).not.toBeNull()
    expect((await h.faceStore.get('face-assigned'))?.assignedSampleId).toBe(h.farSampleId)
  })

  it('refuses while a face re-embed pass runs', async () => {
    const h = await makeHarness()
    h.reembedRunning = true
    await expect(h.jobs.resetToCore({})).rejects.toThrow(/re-embed/)
    expect(await h.identityStore.listSamples(h.identityId)).toHaveLength(5)
  })

  it('refuses while a prune runs, and while another reset runs', async () => {
    const h = await makeHarness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const list = h.identityStore.listIdentities.bind(h.identityStore)
    const spy = vi.spyOn(h.identityStore, 'listIdentities').mockImplementation(async () => {
      await gate
      return list()
    })
    const prune = h.jobs.prune()
    await Promise.resolve()
    await Promise.resolve()
    await expect(h.jobs.resetToCore({})).rejects.toThrow(/prune/)
    release()
    await prune
    spy.mockRestore()

    // A reset in flight refuses a second one.
    let releaseReset: () => void = () => {}
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve
    })
    const spy2 = vi.spyOn(h.identityStore, 'listIdentities').mockImplementation(async () => {
      await resetGate
      return list()
    })
    const first = h.jobs.resetToCore({ dryRun: true })
    await expect(h.jobs.resetToCore({ dryRun: true })).rejects.toThrow(/already running/)
    await expect(h.jobs.runPhotoPass({ dryRun: true })).rejects.toThrow(/reset/)
    releaseReset()
    await first
    spy2.mockRestore()
  })

  it('refuses while a photo re-enrol pass runs', async () => {
    const h = await makeHarness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = h.identityStore.listPhotoSamplesForReenrol.bind(h.identityStore)
    vi.spyOn(h.identityStore, 'listPhotoSamplesForReenrol').mockImplementation(async () => {
      await gate
      return base()
    })
    const pass = h.jobs.runPhotoPass({ dryRun: true })
    await expect(h.jobs.resetToCore({})).rejects.toThrow(/photo re-enrol/)
    release()
    await pass
  })

  it('a face assigned AFTER the listing is kept — the delete re-checks the predicate', async () => {
    const h = await makeHarness()
    const list = h.faceStore.listPendingFaces.bind(h.faceStore)
    vi.spyOn(h.faceStore, 'listPendingFaces').mockImplementation(async () => {
      const rows = await list()
      // The operator assigns one while the reset is walking the samples.
      await h.faceStore.markAssigned('face-pending', h.identityId)
      return rows
    })
    const result = await h.jobs.resetToCore({})
    expect(await h.faceStore.get('face-pending')).not.toBeNull()
    expect(await h.mediaStore.getById(h.pendingCropId)).not.toBeNull()
    expect(result.pendingFaces).toEqual({ found: 2, deleted: 1 })
  })

  it('a face delete that FAILS is not counted as deleted', async () => {
    const h = await makeHarness()
    vi.spyOn(h.faceStore, 'delete').mockResolvedValue(false)
    const result = await h.jobs.resetToCore({})
    expect(result.pendingFaces).toEqual({ found: 2, deleted: 0 })
  })

  it('the photo-source backfill and the reset refuse each other', async () => {
    const h = await makeHarness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const list = h.identityStore.listIdentities.bind(h.identityStore)
    const spy = vi.spyOn(h.identityStore, 'listIdentities').mockImplementation(async () => {
      await gate
      return list()
    })
    const reset = h.jobs.resetToCore({ dryRun: true })
    await expect(h.jobs.backfillPhotoSources({ dryRun: true })).rejects.toThrow(/reset/)
    release()
    await reset
    spy.mockRestore()

    let releaseB: () => void = () => {}
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    const photos = h.identityStore.listPhotoSamplesForReenrol.bind(h.identityStore)
    vi.spyOn(h.identityStore, 'listPhotoSamplesForReenrol').mockImplementation(async () => {
      await gateB
      return photos()
    })
    const backfill = h.jobs.backfillPhotoSources({ dryRun: true })
    await expect(h.jobs.resetToCore({ dryRun: true })).rejects.toThrow(/backfill/)
    releaseB()
    await backfill
  })
})
