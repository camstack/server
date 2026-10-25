/**
 * D692 §4: the face recogniser remembers when each live track FIRST showed a face (past
 * the quality gate). The grouped-notification outlook reads it against the tracker's
 * face-settle cap; a fused track keeps the earlier instant; an ended track forgets it.
 */
import { describe, expect, it } from 'vitest'
import {
  FaceRecognizer,
  type FaceDetailInput,
  type FaceRecognizerDeps,
} from '../face-recognizer.js'
import { FACE_DEFAULTS } from '../face-settings.js'
import { makeSilentLogger } from './test-helpers.js'

const SETTINGS = { ...FACE_DEFAULTS, enabled: true, minFacePx: 0, recognitionMinFacePx: 0 }

function recognizer(): FaceRecognizer {
  const deps: FaceRecognizerDeps = {
    identityStore: { loadGallery: async () => [], listIdentities: async () => [] },
    faceStore: { insert: async () => {} },
    mediaStore: { put: async () => 1 },
    trackStore: { applyLabelCandidate: async () => null },
    eventStore: { projectTrackLabel: async () => 0 },
    captureCrop: async () => Buffer.from('jpg'),
    logger: makeSilentLogger(),
  }
  return new FaceRecognizer(deps)
}

function detail(
  trackId: string,
  timestamp: number,
  over: Partial<FaceDetailInput> = {},
): FaceDetailInput {
  return {
    deviceId: 101,
    trackId,
    timestamp,
    frameWidth: 640,
    frameHeight: 480,
    score: 0.9,
    embedding: [1, 0, 0, 0],
    parentBbox: { x: 0, y: 0, w: 100, h: 100 },
    faceBbox: { x: 10, y: 10, w: 50, h: 50 },
    settings: SETTINGS,
    cropPadding: 0,
    ...over,
  }
}

describe('FaceRecognizer.firstFaceAt (D692)', () => {
  it('is undefined before any face, then the FIRST face instant', async () => {
    const rec = recognizer()
    expect(rec.firstFaceAt('t1')).toBeUndefined()
    await rec.ingestFaceDetail(detail('t1', 5_000))
    await rec.ingestFaceDetail(detail('t1', 7_000))
    expect(rec.firstFaceAt('t1')).toBe(5_000)
  })
  it('a fused track keeps the EARLIER of the two pieces', async () => {
    const rec = recognizer()
    await rec.ingestFaceDetail(detail('S', 5_000))
    await rec.ingestFaceDetail(detail('A', 3_000))
    rec.adoptTrack(101, 'S', 'A')
    expect(rec.firstFaceAt('S')).toBe(3_000)
    expect(rec.firstFaceAt('A')).toBeUndefined()
  })
  it('an ended track forgets it', async () => {
    const rec = recognizer()
    await rec.ingestFaceDetail(detail('t1', 5_000))
    await rec.onTrackEnd(101, 't1')
    expect(rec.firstFaceAt('t1')).toBeUndefined()
  })
  it('a detail the quality gate drops does not count as a face', async () => {
    const rec = recognizer()
    await rec.ingestFaceDetail(
      detail('t1', 5_000, {
        embeddingMagnitude: 50,
        settings: { ...SETTINGS, maxEmbeddingMagnitude: 1 },
      }),
    )
    expect(rec.firstFaceAt('t1')).toBeUndefined()
  })
})
