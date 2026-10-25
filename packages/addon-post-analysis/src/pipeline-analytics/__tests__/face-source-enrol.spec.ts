/**
 * The source frame through enrolment and removal (D644), over the REAL stores.
 *
 *  - enrolling a face moves its frame into the sample's `sourceMediaId`, with
 *    the box and landmarks — the face and the sample then name ONE blob;
 *  - removing the sample deletes that blob and detaches the face from it (the
 *    frame is deleted when nothing references it any more);
 *  - unassigning gives the frame back to the face;
 *  - a frame the face SHARES with a sibling is copied, never taken;
 *  - a face-owned frame leaves with its track (the retention cascade).
 */
import { describe, expect, it } from 'vitest'
import { FaceGalleryProvider } from '../face-gallery-provider.js'
import { FACE_ARCFACE_INDEX, IDENTITY_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { EventStore } from '../store/event-store.js'
import { FaceStore } from '../store/face-store.js'
import { IdentityStore } from '../store/identity-store.js'
import { MediaStore } from '../store/media-store.js'
import { TrackStore } from '../store/track-store.js'
import {
  makeFakeEmbeddingIndex,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
} from './test-helpers.js'
import { makeAnalyticsWorld } from './fake-records.js'

const MODEL = 'auraface-r100'
const LANDMARKS = [
  { x: 630, y: 360 },
  { x: 690, y: 360 },
  { x: 660, y: 396 },
  { x: 636, y: 432 },
  { x: 684, y: 432 },
]

async function makeHarness() {
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
  const provider = new FaceGalleryProvider({
    identityStore,
    faceStore,
    mediaStore,
    trackStore,
    eventStore,
    logger,
    refreshGallery: () => {},
    resolveClusterModelId: async () => MODEL,
    resolveAutoAssignThreshold: async () => 0.5,
    eventMediaBaseUrl: () => null,
    eventMediaPathPrefix: () => '/x',
    emitFaceGalleryChanged: () => {},
  })
  const identity = await identityStore.createIdentity({ name: 'Alice' })

  /** A buffered face with its crop and (by default) its OWN source frame. */
  async function bufferFace(
    trackId: string,
    frameOwner: { kind: 'face' | 'track'; id: string } = { kind: 'face', id: `face-${trackId}` },
  ): Promise<number> {
    const faceId = `face-${trackId}`
    const crop = await mediaStore.put({
      deviceId: 101,
      ownerKind: 'face',
      ownerId: faceId,
      kind: 'crop',
      timestamp: 1,
      data: Buffer.from(`crop-${trackId}`),
    })
    const frame = await mediaStore.put({
      deviceId: 101,
      ownerKind: frameOwner.kind,
      ownerId: frameOwner.id,
      kind: frameOwner.kind === 'track' ? 'keyFrame' : 'fullFrame',
      timestamp: 1,
      data: Buffer.from(`frame-of-${frameOwner.id}`),
    })
    await faceStore.insert({
      id: faceId,
      deviceId: 101,
      trackId,
      timestamp: Date.now(),
      embedding: [1, 0, 0],
      embeddingModelId: MODEL,
      mediaId: crop,
      assigned: false,
      sourceFrameMediaId: frame,
      sourceFrameBbox: { x: 600, y: 300, w: 120, h: 180 },
      sourceFrameLandmarks: LANDMARKS,
    })
    return frame
  }

  return { provider, identityStore, mediaStore, faceStore, identityId: identity.id, bufferFace }
}

describe('the source frame through enrolment (D644)', () => {
  it('enrolment moves the frame into the sample, with its box and landmarks', async () => {
    const h = await makeHarness()
    await h.bufferFace('t1')
    await h.provider.assignFace({ faceId: 'face-t1', identityId: h.identityId })

    const [sample] = await h.identityStore.listSamples(h.identityId)
    const face = await h.faceStore.get('face-t1')
    expect(sample?.sourceMediaId).toBeDefined()
    expect(face?.sourceFrameMediaId).toBe(sample?.sourceMediaId)
    expect(sample?.sourceBbox).toEqual({ x: 600, y: 300, width: 120, height: 180 })
    expect(sample?.sourceLandmarks).toEqual(LANDMARKS)
    const owner = await h.mediaStore.ownerOf(sample?.sourceMediaId ?? -1)
    expect(owner).toEqual({ ownerKind: 'identity', ownerId: h.identityId })
  })

  it('removing the sample deletes the frame and detaches the face from it', async () => {
    const h = await makeHarness()
    await h.bufferFace('t1')
    await h.provider.assignFace({ faceId: 'face-t1', identityId: h.identityId })
    const [sample] = await h.identityStore.listSamples(h.identityId)
    const frameId = sample?.sourceMediaId ?? -1

    await h.provider.removeSample({ identityId: h.identityId, sampleId: sample?.id ?? '' })
    expect(await h.mediaStore.getById(frameId)).toBeNull()
    const face = await h.faceStore.get('face-t1')
    expect(face?.sourceFrameMediaId).toBeUndefined()
    expect(face?.assigned).toBe(true)
  })

  it('unassigning gives the frame back to the face', async () => {
    const h = await makeHarness()
    await h.bufferFace('t1')
    await h.provider.assignFace({ faceId: 'face-t1', identityId: h.identityId })
    await h.provider.unassignFace({ faceId: 'face-t1' })
    const face = await h.faceStore.get('face-t1')
    expect(face?.sourceFrameMediaId).toBeDefined()
    const owner = await h.mediaStore.ownerOf(face?.sourceFrameMediaId ?? -1)
    expect(owner).toEqual({ ownerKind: 'face', ownerId: 'face-t1' })
  })

  it('a reused TRACK keyFrame is copied into the sample, never taken from the track', async () => {
    const h = await makeHarness()
    const keyFrame = await h.bufferFace('k', { kind: 'track', id: 'k' })
    await h.provider.assignFace({ faceId: 'face-k', identityId: h.identityId })
    const [sample] = await h.identityStore.listSamples(h.identityId)
    expect(sample?.sourceMediaId).toBeDefined()
    expect(sample?.sourceMediaId).not.toBe(keyFrame)
    expect(await h.mediaStore.ownerOf(keyFrame)).toEqual({ ownerKind: 'track', ownerId: 'k' })
    // The face names the copy — one blob with the sample, as with its own frame.
    expect((await h.faceStore.get('face-k'))?.sourceFrameMediaId).toBe(sample?.sourceMediaId)
  })

  it('a frame owned by anything else is not enrolled with — and nothing is copied', async () => {
    const h = await makeHarness()
    const foreign = await h.bufferFace('x', { kind: 'face', id: 'face-other' })
    await h.provider.assignFace({ faceId: 'face-x', identityId: h.identityId })
    const [sample] = await h.identityStore.listSamples(h.identityId)
    expect(sample?.sourceMediaId).toBeUndefined()
    expect(await h.mediaStore.ownerOf(foreign)).toEqual({
      ownerKind: 'face',
      ownerId: 'face-other',
    })
  })

  it('unassign never leaves an identity-owned frame nobody names', async () => {
    const h = await makeHarness()
    await h.bufferFace('t1')
    await h.provider.assignFace({ faceId: 'face-t1', identityId: h.identityId })
    const frame = (await h.faceStore.get('face-t1'))?.sourceFrameMediaId ?? -1
    // The move back fails.
    const reown = h.mediaStore.reown.bind(h.mediaStore)
    h.mediaStore.reown = async (input) => {
      if (input.mediaId === frame) throw new Error('disk full')
      return reown(input)
    }
    await h.provider.unassignFace({ faceId: 'face-t1' })
    const left = await h.mediaStore.listInfoByOwner('identity', h.identityId)
    expect(left.filter((m) => m.kind === 'fullFrame')).toEqual([])
    expect((await h.faceStore.get('face-t1'))?.sourceFrameMediaId).toBeUndefined()
  })

  it('a face-owned frame leaves with its track (retention cascade)', async () => {
    const h = await makeHarness()
    const frame = await h.bufferFace('gone')
    await h.mediaStore.deleteByTracks(['gone'])
    expect(await h.mediaStore.getById(frame)).toBeNull()
  })
})
