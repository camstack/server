import { FACE_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FaceRecognizer } from '../face-recognizer.js'
import { FACE_DEFAULTS } from '../face-settings.js'
import type { GallerySample } from '../pipeline/face-matcher.js'
import { FaceStore } from '../store/face-store.js'
import { ObjectEmbeddingStore } from '../store/object-embedding-store.js'
import {
  makeFakeEmbeddingIndex,
  makeFakeSettingsStore,
  makeFakeVectorStore,
  makeSilentLogger,
} from './test-helpers.js'
import { makeAnalyticsWorld } from './fake-records.js'
import { testClipRegistry } from './fixtures/clip-test-registry.js'
import { makeTrackedDetectionOut } from './support/tracked-detection-out.js'
import type { FaceRecord } from '../store/face-store.js'
import { completeLoggerStub } from '../../notification-center/__tests__/support/nc-test-deps.js'

// ── Design B: keyFrameMediaId + faceBbox linkage across the stores + face path.

describe('ObjectEmbeddingStore — keyFrameMediaId link', () => {
  let vectors: ReturnType<typeof makeFakeVectorStore>
  let store: ObjectEmbeddingStore

  beforeEach(async () => {
    makeFakeSettingsStore()
    vectors = makeFakeVectorStore()
    store = new ObjectEmbeddingStore({
      vectorStore: vectors.client,
      logger: makeSilentLogger(),
      clipModels: testClipRegistry(3),
    })
  })

  it('round-trips keyFrameMediaId alongside the crop mediaId', async () => {
    await store.upsertIfBetter({
      trackId: 't1',
      deviceId: 7,
      timestamp: 1000,
      className: 'person',
      embedding: [0.1, 0.2, 0.3],
      modelId: 'mobileclip-s1',
      confidence: 0.9,
      mediaId: 1000,
      keyFrameMediaId: 1001,
    })
    const rows = (
      await store.searchByVector({
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        deviceId: 7,
        modelId: 'mobileclip-s1',
      })
    ).hits.map((h) => h.row)
    expect(rows[0]!.mediaId).toBe(1000)
    expect(rows[0]!.keyFrameMediaId).toBe(1001)
  })

  it('advances keyFrameMediaId when a strictly-better detection upserts', async () => {
    await store.upsertIfBetter({
      trackId: 't1',
      deviceId: 7,
      timestamp: 1000,
      className: 'person',
      embedding: [0.1, 0.2, 0.3],
      modelId: 'mobileclip-s1',
      confidence: 0.6,
      keyFrameMediaId: 1000,
    })
    await store.upsertIfBetter({
      trackId: 't1',
      deviceId: 7,
      timestamp: 2000,
      className: 'person',
      embedding: [0.1, 0.2, 0.3],
      modelId: 'mobileclip-s1',
      confidence: 0.9,
      keyFrameMediaId: 2000,
    })
    const rows = (
      await store.searchByVector({
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        deviceId: 7,
        modelId: 'mobileclip-s1',
      })
    ).hits.map((h) => h.row)
    expect(rows[0]!.keyFrameMediaId).toBe(2000)
  })

  it('leaves keyFrameMediaId undefined when never supplied', async () => {
    await store.upsertIfBetter({
      trackId: 't1',
      deviceId: 7,
      timestamp: 1000,
      className: 'person',
      embedding: [0.1, 0.2, 0.3],
      modelId: 'mobileclip-s1',
      confidence: 0.9,
    })
    const rows = (
      await store.searchByVector({
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        deviceId: 7,
        modelId: 'mobileclip-s1',
      })
    ).hits.map((h) => h.row)
    expect(rows[0]!.keyFrameMediaId).toBeUndefined()
  })
})

describe('FaceStore — keyFrameMediaId + faceBbox link', () => {
  let store: FaceStore

  beforeEach(async () => {
    const { ledgers } = await makeAnalyticsWorld()
    store = new FaceStore({
      vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
      logger: makeSilentLogger(),
      faceLedger: ledgers.faces,
    })
  })

  it('round-trips keyFrameMediaId + faceBbox through insert/get', async () => {
    await store.insert({
      id: 'face-t1',
      deviceId: 7,
      trackId: 't1',
      timestamp: 1000,
      embedding: [0.1, 0.2],
      mediaId: 1000,
      assigned: false,
      keyFrameMediaId: 1001,
      faceBbox: { x: 30, y: 10, w: 40, h: 40 },
    })
    const row = await store.get('face-t1')
    expect(row?.keyFrameMediaId).toBe(1001)
    expect(row?.faceBbox).toEqual({ x: 30, y: 10, w: 40, h: 40 })
  })

  it('maps unset keyFrameMediaId/faceBbox to undefined in listAllRecentFaces', async () => {
    await store.insert({
      id: 'face-t2',
      deviceId: 7,
      trackId: 't2',
      timestamp: 2000,
      embedding: [0.1, 0.2],
      mediaId: 2000,
      assigned: false,
    })
    const rows = await store.listAllRecentFaces({})
    expect(rows[0]!.keyFrameMediaId).toBeUndefined()
    expect(rows[0]!.faceBbox).toBeUndefined()
  })
})

// ── Face path: onTrackEnd links the shared key frame + face bbox, guards intact.

function faceDeps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    identityStore: {
      loadGallery: vi.fn(async (): Promise<readonly GallerySample[]> => []),
      listIdentities: vi.fn(async () => [] as readonly { id: string; name: string }[]),
    },
    faceStore: { insert: vi.fn<(face: FaceRecord) => Promise<void>>(async () => {}) },
    mediaStore: { put: vi.fn(async () => 1) },
    trackStore: { setLabel: vi.fn(async () => {}) },
    eventStore: { setLabelForTrack: vi.fn(async () => 0) },
    captureCrop: vi.fn(async () => Buffer.from('jpg')),
    getKeyFrameMediaId: vi.fn((_trackId: string) => 101),
    logger: completeLoggerStub({ warn: vi.fn(), debug: vi.fn(), info: vi.fn() }),
    ...overrides,
  }
}

const ENABLED = { ...FACE_DEFAULTS, enabled: true, confirmFrames: 2 }

function faceCandidate() {
  return makeTrackedDetectionOut({
    trackId: 't1',
    className: 'person',
    confidence: 0.9,
    bbox: { x: 0, y: 0, w: 100, h: 300 },
    faceBbox: { x: 30, y: 10, w: 40, h: 40 },
    state: 'moving',
    embedding: [1, 0, 0, 0],
    embeddingModelId: 'arcface-r100',
  })
}

describe('FaceRecognizer.onTrackEnd — key-frame + faceBbox link', () => {
  it('persists faceBbox + the shared keyFrameMediaId for an imaged face', async () => {
    const d = faceDeps()
    const rec = new FaceRecognizer(d as never)
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [faceCandidate()],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: {} as never,
    })
    await rec.onTrackEnd(7, 't1')
    expect(d.getKeyFrameMediaId).toHaveBeenCalledWith('t1')
    expect(d.faceStore.insert).toHaveBeenCalledOnce()
    const inserted = d.faceStore.insert.mock.calls[0]![0]
    expect(inserted.faceBbox).toEqual({ x: 30, y: 10, w: 40, h: 40 })
    expect(inserted.keyFrameMediaId).toBe(101)
  })

  it('still DROPS an imageless track (guard intact) — no face row, no keyFrame link', async () => {
    const d = faceDeps()
    const rec = new FaceRecognizer(d as never)
    // No frameHandle → no crop captured (faceBbox-only gate leaves the track
    // crop-less), so the imageless-drop guard must fire.
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [faceCandidate()],
      settings: ENABLED,
      cropPadding: 0,
    })
    await rec.onTrackEnd(7, 't1')
    expect(d.faceStore.insert).not.toHaveBeenCalled()
  })

  it('omits keyFrameMediaId when the getter yields none (fallback to face crop)', async () => {
    const d = faceDeps({ getKeyFrameMediaId: vi.fn(() => undefined) })
    const rec = new FaceRecognizer(d as never)
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [faceCandidate()],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: {} as never,
    })
    await rec.onTrackEnd(7, 't1')
    const inserted = d.faceStore.insert.mock.calls[0]![0]
    expect(inserted.keyFrameMediaId).toBeUndefined()
    // faceBbox is still linked even without a key frame.
    expect(inserted.faceBbox).toBeDefined()
  })
})
