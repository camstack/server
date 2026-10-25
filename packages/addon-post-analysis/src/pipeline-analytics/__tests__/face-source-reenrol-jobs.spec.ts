/**
 * Source re-enrol of a DETECTED sample over the real stores (D644).
 *
 * A detected sample enrolled since D644 names its source frame. The photo
 * re-enrol pass now re-derives it too — through a window around the stored
 * box, because the photo path's detector would not find a camera-sized face on
 * a whole 4K frame — and the buffered face that named the old sample follows
 * the replacement (its crop too), instead of being left naming a removed row.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { FaceAlignmentJobs } from '../face-alignment-jobs.js'
import { faceSourceWindow } from '../face-source-window.js'
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
} from './test-helpers.js'
import { makeAnalyticsWorld } from './fake-records.js'

const MODEL = 'auraface-r100'
const BOX = { x: 400, y: 300, width: 50, height: 60 }

describe('faceSourceWindow', () => {
  it('is a square 4× the long side, centred on the face and clamped into the frame', () => {
    expect(faceSourceWindow(BOX, 1000, 800)).toEqual({
      left: 305,
      top: 210,
      width: 240,
      height: 240,
    })
    expect(faceSourceWindow({ x: 0, y: 0, width: 50, height: 60 }, 1000, 800)).toMatchObject({
      left: 0,
      top: 0,
    })
    // Never larger than the frame.
    expect(faceSourceWindow({ x: 0, y: 0, width: 500, height: 500 }, 1000, 800).width).toBe(800)
  })
})

describe('FaceAlignmentJobs — source re-enrol of a detected sample', () => {
  it('re-derives from the window, repoints the face, keeps the source frame', async () => {
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
    const identity = await identityStore.createIdentity({ name: 'Alice' })
    const frameJpeg = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: { r: 90, g: 90, b: 90 } },
    })
      .jpeg()
      .toBuffer()
    const put = (kind: 'crop' | 'fullFrame', data: Buffer) =>
      mediaStore.put({
        deviceId: 101,
        ownerKind: 'identity',
        ownerId: identity.id,
        kind,
        timestamp: 1,
        data,
      })
    const template = await put('crop', Buffer.from('old-template'))
    const frame = await put('fullFrame', frameJpeg)
    const old = await identityStore.addSample({
      identityId: identity.id,
      embedding: [1, 0, 0],
      modelId: MODEL,
      source: 'detected',
      deviceId: 101,
      mediaId: template,
      sourceMediaId: frame,
      sourceBbox: BOX,
    })
    await faceStore.insert({
      id: 'face-t1',
      deviceId: 101,
      trackId: 't1',
      timestamp: 1,
      embedding: [1, 0, 0],
      embeddingModelId: MODEL,
      mediaId: template,
      assigned: true,
      recognizedIdentityId: identity.id,
      assignedSampleId: old.id,
      sourceFrameMediaId: frame,
    })

    const analyzedSizes: string[] = []
    const jobs = new FaceAlignmentJobs({
      stores: () => ({ identityStore, mediaStore, faceStore }),
      analyzePhoto: async (jpeg): Promise<readonly PhotoFace[]> => {
        const meta = await sharp(jpeg).metadata()
        analyzedSizes.push(`${meta.width}x${meta.height}`)
        return [
          {
            faceIndex: 0,
            // In WINDOW coordinates: the window starts at (305, 210).
            bbox: { x: 95, y: 90, width: 50, height: 60 },
            score: 0.9,
            enrollable: true,
            alignedCropBase64: Buffer.from('new-template').toString('base64'),
            modelId: MODEL,
            embedding: [0.8, 0.6, 0],
            quality: { detectionShortSidePx: 60, score: 0.9 },
          },
        ]
      },
      removeDetectedSample: async () => {
        throw new Error('the source re-enrol never uses the Remove path')
      },
      refreshGallery: async () => {},
      isReembedRunning: () => false,
      logger,
    })

    const result = await jobs.runPhotoPass({})
    expect(result.reenrolled).toBe(1)
    expect(analyzedSizes).toEqual(['240x240'])

    const samples = await identityStore.listSamples(identity.id)
    expect(samples).toHaveLength(1)
    const [replacement] = samples
    expect(replacement?.source).toBe('detected')
    expect(replacement?.deviceId).toBe(101)
    expect(replacement?.sourceMediaId).toBe(frame)
    expect(replacement?.sourceBbox).toEqual(BOX)
    // The frame survived; the old template did not.
    expect(await mediaStore.getById(frame)).not.toBeNull()
    expect(await mediaStore.getById(template)).toBeNull()
    // The face followed the replacement.
    const face = await faceStore.get('face-t1')
    expect(face?.assignedSampleId).toBe(replacement?.id)
    expect(face?.mediaId).toBe(replacement?.mediaId)
    expect(face?.sourceFrameMediaId).toBe(frame)
  })
})
