/**
 * The automatic trigger of the photo re-enrol pass (D643) must converge: it
 * starts for a v1 photo sample this boot has not tried, and never again for
 * one it has — a refusal does not change by asking, and a failing node must
 * not become a full-photo detect+embed every minute.
 */
import { describe, expect, it } from 'vitest'
import { FACE_ALIGNMENT_SCRFD_V2 } from '../face-alignment-version.js'
import type { PhotoReenrolSample } from '../face-photo-reenrol-pass.js'
import { FaceGalleryProvider } from '../face-gallery-provider.js'
import { armsAutoPass, FaceAlignmentJobs, shouldAutoReenrolPhotos } from '../face-alignment-jobs.js'
import type { PhotoFace } from '../photo-enrollment.js'
import { FACE_ARCFACE_INDEX, IDENTITY_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { FaceStore } from '../store/face-store.js'
import { IdentityStore } from '../store/identity-store.js'
import { MediaStore } from '../store/media-store.js'
import {
  makeFakeEmbeddingIndex,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
  testFaceGalleryModelPins,
} from './test-helpers.js'
import { makeAnalyticsWorld } from './fake-records.js'

function s(sampleId: string, v2: boolean): PhotoReenrolSample {
  return {
    sampleId,
    identityId: 'i',
    identityName: 'I',
    modelId: 'auraface-r100',
    sourceMediaId: 1,
    ...(v2 ? { alignment: FACE_ALIGNMENT_SCRFD_V2 } : {}),
  }
}

describe('shouldAutoReenrolPhotos', () => {
  it('starts for an untried v1 photo sample', () => {
    expect(shouldAutoReenrolPhotos([s('a', false)], new Set(), false)).toBe(true)
  })
  it('stays quiet when every photo sample is v2', () => {
    expect(shouldAutoReenrolPhotos([s('a', true)], new Set(), false)).toBe(false)
  })
  it('never re-attempts a sample this boot already tried', () => {
    expect(shouldAutoReenrolPhotos([s('a', false)], new Set(['a']), false)).toBe(false)
  })
  it('waits while a pass (either kind) is running', () => {
    expect(shouldAutoReenrolPhotos([s('a', false)], new Set(), true)).toBe(false)
  })
})

// ── FaceAlignmentJobs over the REAL stores (I1, I2) ─────────────────────────

const MODEL = 'auraface-r100'

interface RealHarness {
  readonly jobs: FaceAlignmentJobs
  readonly identityStore: IdentityStore
  readonly mediaStore: MediaStore
  readonly identityId: string
  readonly oldSampleId: string
  readonly oldTemplateId: number
  readonly sourcePhotoId: number
  readonly analyzed: Buffer[]
  photoListReads: number
}

/**
 * One identity with one OLD (v1) photo sample: a template blob, a source photo
 * blob, a row and a vector — every piece written by the real stores.
 * `removeDetectedSample` is wired to the REAL provider's `removeSample`, so a
 * pass that used it would delete the source photo and fail I2 below.
 */
async function makeReal(): Promise<RealHarness> {
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
    trackStore: null as unknown as never,
    eventStore: null as unknown as never,
    logger,
    refreshGallery: () => {},
    eventMediaBaseUrl: () => null,
    eventMediaPathPrefix: () => '/x',
    emitFaceGalleryChanged: () => {},
    ...testFaceGalleryModelPins,
  })

  const identity = await identityStore.createIdentity({ name: 'Dave' })
  const put = (kind: 'faceCrop' | 'fullFrame', data: string) =>
    mediaStore.put({
      deviceId: 0,
      ownerKind: 'identity',
      ownerId: identity.id,
      kind,
      timestamp: 1,
      data: Buffer.from(data),
    })
  const oldTemplateId = await put('faceCrop', 'old-template')
  const sourcePhotoId = await put('fullFrame', 'the-photograph')
  const old = await identityStore.addSample({
    identityId: identity.id,
    embedding: [1, 0, 0],
    modelId: MODEL,
    source: 'photo',
    mediaId: oldTemplateId,
    sourceMediaId: sourcePhotoId,
  })

  const analyzed: Buffer[] = []
  const newFace: PhotoFace = {
    faceIndex: 0,
    bbox: { x: 0, y: 0, width: 100, height: 100 },
    score: 0.9,
    enrollable: true,
    alignedCropBase64: Buffer.from('new-template').toString('base64'),
    modelId: MODEL,
    embedding: [0.8, 0.6, 0],
    quality: { detectionShortSidePx: 300, score: 0.9 },
  }
  const h: RealHarness = {
    jobs: new FaceAlignmentJobs({
      stores: () => ({ identityStore, mediaStore, faceStore }),
      analyzePhoto: async (photo) => {
        analyzed.push(photo)
        return [newFace]
      },
      removeDetectedSample: (identityId, sampleId) =>
        provider.removeSample({ identityId, sampleId }),
      refreshGallery: async () => {},
      isReembedRunning: () => false,
      logger,
    }),
    identityStore,
    mediaStore,
    identityId: identity.id,
    oldSampleId: old.id,
    oldTemplateId,
    sourcePhotoId,
    analyzed,
    photoListReads: 0,
  }
  const baseList = identityStore.listPhotoSamplesForReenrol.bind(identityStore)
  identityStore.listPhotoSamplesForReenrol = async () => {
    h.photoListReads += 1
    return baseList()
  }
  return h
}

describe('FaceAlignmentJobs — the real old-sample removal (I2)', () => {
  it('removes the old row, vector and template; the source photo the new row owns SURVIVES', async () => {
    const h = await makeReal()
    const result = await h.jobs.runPhotoPass({})
    expect(result.reenrolled).toBe(1)

    // The old sample is gone — row and vector.
    const samples = await h.identityStore.listSamples(h.identityId)
    expect(samples.map((s) => s.id)).not.toContain(h.oldSampleId)
    expect((await h.identityStore.loadSampleVectors([h.oldSampleId])).size).toBe(0)
    // Its template blob is gone.
    expect(await h.mediaStore.getById(h.oldTemplateId)).toBeNull()
    // The photograph is still there, and the new row names it.
    const [replacement] = samples
    expect(replacement?.sourceMediaId).toBe(h.sourcePhotoId)
    expect(replacement?.alignment).toBe('scrfd-v2')
    const photo = await h.mediaStore.getById(h.sourcePhotoId)
    expect(photo).not.toBeNull()
    expect(Buffer.from(photo?.base64 ?? '', 'base64').toString()).toBe('the-photograph')
    // And the new template exists.
    const newTemplate = replacement?.mediaId
    expect(newTemplate).toBeDefined()
    if (newTemplate !== undefined) expect(await h.mediaStore.getById(newTemplate)).not.toBeNull()
    // The identity count moved by +1 −1.
    const [identity] = await h.identityStore.listIdentities()
    expect(identity?.sampleCount).toBe(1)
  })
})

describe('FaceAlignmentJobs — the automatic pass waits to be ARMED (I1)', () => {
  it('only a real, unbudgeted admin run arms it', () => {
    expect(armsAutoPass({ dryRun: true })).toBe(false)
    expect(armsAutoPass({ maxSamples: 1 })).toBe(false)
    expect(armsAutoPass({ dryRun: false, maxSamples: 1 })).toBe(false)
    expect(armsAutoPass({})).toBe(true)
    expect(armsAutoPass({ dryRun: false })).toBe(true)
  })

  it('unarmed, the timer reads nothing and changes nothing', async () => {
    const h = await makeReal()
    await h.jobs.maybeAutoRunPhotoPass()
    expect(h.photoListReads).toBe(0)
    expect(h.analyzed).toHaveLength(0)
    expect((await h.jobs.status()).autoArmed).toBe(false)
  })

  it('a dry run and a canary do not arm it; a full run does, and the scan then stops once converged', async () => {
    const h = await makeReal()
    const dry = await h.jobs.runPhotoPass({ dryRun: true })
    expect(dry.wouldReenrol).toBe(1)
    expect(await h.mediaStore.getById(h.oldTemplateId)).not.toBeNull()
    expect((await h.jobs.status()).autoArmed).toBe(false)

    await h.jobs.runPhotoPass({ maxSamples: 1 })
    expect((await h.jobs.status()).autoArmed).toBe(false)

    await h.jobs.runPhotoPass({})
    expect((await h.jobs.status()).autoArmed).toBe(true)

    const before = h.photoListReads
    await h.jobs.maybeAutoRunPhotoPass()
    expect((await h.jobs.status()).autoConverged).toBe(true)
    await h.jobs.maybeAutoRunPhotoPass()
    await h.jobs.maybeAutoRunPhotoPass()
    // One scan to learn it converged; none after.
    expect(h.photoListReads - before).toBe(1)
  })
})

describe('FaceAlignmentJobs.backfillPhotoSources over the REAL stores', () => {
  /** A baseline-JPEG header with just enough for `readJpegSize`. */
  function jpeg(width: number, height: number): Buffer {
    return Buffer.from([
      0xff,
      0xd8,
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      0x03,
      0x01,
      0x22,
      0x00,
      0x02,
      0x11,
      0x01,
      0x03,
      0x11,
      0x01,
    ])
  }

  async function makeUnsourced() {
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
    const identity = await identityStore.createIdentity({ name: 'Bob' })
    const put = (kind: 'faceCrop' | 'fullFrame', data: Buffer) =>
      mediaStore.put({
        deviceId: 0,
        ownerKind: 'identity',
        ownerId: identity.id,
        kind,
        timestamp: 1,
        data,
      })
    const templateId = await put('faceCrop', jpeg(112, 112))
    const photoId = await put('fullFrame', jpeg(4032, 3024))
    // The live shape: a photo sample that never got its sourceMediaId.
    const s = await identityStore.addSample({
      identityId: identity.id,
      embedding: [1, 0, 0],
      modelId: MODEL,
      source: 'photo',
      mediaId: templateId,
    })
    const jobs = new FaceAlignmentJobs({
      stores: () => ({ identityStore, mediaStore, faceStore }),
      analyzePhoto: async () => {
        throw new Error('the backfill must never analyse')
      },
      removeDetectedSample: async () => {
        throw new Error('the backfill must never remove')
      },
      refreshGallery: async () => {},
      isReembedRunning: () => false,
      logger,
    })
    return { jobs, identityStore, templateId, photoId, sampleId: s.id }
  }

  it('the ids are adjacent the way enrollPhotoFace writes them — the premise of the +1', async () => {
    const h = await makeUnsourced()
    expect(h.photoId).toBe(h.templateId + 1)
  })

  it('writes the verified photo id and it READS BACK from the store', async () => {
    const h = await makeUnsourced()
    const result = await h.jobs.backfillPhotoSources({})
    expect(result.samples[0]).toMatchObject({
      candidate: h.photoId,
      checks: { exists: true, owner: true, dims: true, unreferenced: true },
      outcome: 'backfilled',
    })
    expect(await h.identityStore.readSourceMediaId(h.sampleId)).toBe(h.photoId)
    const [photoSample] = await h.identityStore.listPhotoSamplesForReenrol()
    expect(photoSample?.sourceMediaId).toBe(h.photoId)
    // And it neither armed nor ran the photo pass.
    const status = await h.jobs.status()
    expect(status.autoArmed).toBe(false)
    expect(status.lastPhotoPass).toBeNull()
  })

  it('a dry run leaves the column empty', async () => {
    const h = await makeUnsourced()
    const result = await h.jobs.backfillPhotoSources({ dryRun: true })
    expect(result.samples[0]?.outcome).toBe('would-backfill')
    expect(await h.identityStore.readSourceMediaId(h.sampleId)).toBeNull()
  })
})
