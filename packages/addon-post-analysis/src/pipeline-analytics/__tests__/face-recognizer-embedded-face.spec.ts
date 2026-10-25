/**
 * `FaceRecognizer.onTrackEnd` → `Track.hasEmbeddedFace` — the PRODUCER half.
 *
 * `hasEmbeddedFace` is the strict twin of `hasFace`, and the whole value of the
 * pair is that they disagree. `hasFace` is stamped at the TOP of the face
 * branch, before every gate: it means only "a face detector produced a face
 * detail". `hasEmbeddedFace` means "this track has a row IN THE GALLERY — a
 * crop plus an embedding — a face an operator could ASSIGN to an identity", and
 * there is exactly ONE moment in the system where that becomes true: after
 * `faceStore.insert` resolves inside `onTrackEnd`.
 *
 * So what this file pins is the placement, not the plumbing. Everything between
 * the detector and that insert can legitimately refuse the face:
 *
 *  - the embedding-magnitude verdict,
 *  - the `minFacePx` detection gate,
 *  - the candidate gate (no embedding-bearing candidate at all),
 *  - the imageless-track drop (no crop was ever captured),
 *  - the `mediaId === undefined` drop (the crop store failed).
 *
 * A mark written before any of those is a lie the gallery cannot honour: the
 * operator is told a face is assignable and finds nothing to assign. The two
 * negative cases below are therefore the point of the file — the positive one
 * only proves the mark is reachable.
 *
 * The positive case is deliberately an UNRECOGNISED face. `hasEmbeddedFace` is
 * independent of recognition: a face collected but never auto-matched is
 * precisely the face an operator most wants to assign, so gating the mark on
 * `recognizedIdentityId` would make it false exactly where it matters.
 */
import type { FrameHandle } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { FaceRecognizer, type FaceRecognizerDeps } from '../face-recognizer.js'
import { FACE_DEFAULTS, type FaceSettings } from '../face-settings.js'
import { makeTrackedDetectionOut } from './support/tracked-detection-out.js'
import { makeSilentLogger } from './test-helpers.js'

/** The gallery row `faceStore.insert` receives — read off the dep so the fake
 *  can never drift from the shape production actually writes. */
type InsertedFaceRow = Parameters<FaceRecognizerDeps['faceStore']['insert']>[0]

const DEVICE_ID = 101

/**
 * Every auto-match gate neutralized: this file is about the persist placement,
 * not about the gates, each of which has its own spec in
 * `face-recognizer.spec.ts`.
 */
const ENABLED: FaceSettings = {
  ...FACE_DEFAULTS,
  enabled: true,
  confirmFrames: 2,
  minFacePx: 0,
  recognitionMinFacePx: 0,
  minIdentitySamples: 1,
}

/** A real handle shape — the recognizer only forwards it to `captureCrop`. */
const FRAME_HANDLE: FrameHandle = {
  shmId: 'shm-test',
  slot: 0,
  seq: 2,
  width: 100,
  height: 100,
  format: 'rgb',
  pts: 1,
  byteLength: 30_000,
  nodeId: 'hub',
  slotCount: 4,
}

/** An embedding-bearing person candidate carrying its own face box (the R1
 *  gate: a crop is captured only from a real face-bearing frame). */
function tracked(trackId: string) {
  return makeTrackedDetectionOut({
    trackId,
    faceBbox: { x: 2, y: 2, w: 6, h: 6 },
    embedding: [1, 0, 0, 0],
    embeddingModelId: 'arcface-r100',
  })
}

interface Harness {
  readonly rec: FaceRecognizer
  readonly markEmbeddedFace: ReturnType<typeof vi.fn>
  readonly insert: ReturnType<typeof vi.fn>
}

function makeHarness(overrides: Partial<FaceRecognizerDeps> = {}): Harness {
  const markEmbeddedFace = vi.fn(async (_trackId: string): Promise<void> => {})
  const insert = vi.fn(async (_face: InsertedFaceRow): Promise<void> => {})
  const deps: FaceRecognizerDeps = {
    identityStore: {
      // Empty gallery ⇒ COLLECT-ONLY: nothing can be auto-matched, which is
      // exactly the case that must still mark the track.
      loadGallery: async () => [],
      listIdentities: async () => [],
    },
    faceStore: { insert },
    mediaStore: { put: async () => 1 },
    trackStore: { applyLabelCandidate: async () => null },
    eventStore: { projectTrackLabel: async () => 0 },
    captureCrop: async () => Buffer.from('jpeg-bytes'),
    markEmbeddedFace,
    logger: makeSilentLogger(),
    ...overrides,
  }
  return { rec: new FaceRecognizer(deps), markEmbeddedFace, insert }
}

async function seeFace(rec: FaceRecognizer, trackId: string, withHandle = true): Promise<void> {
  await rec.processFrame({
    deviceId: DEVICE_ID,
    timestamp: 100,
    frameWidth: 100,
    frameHeight: 100,
    tracked: [tracked(trackId)],
    settings: ENABLED,
    cropPadding: 0,
    ...(withHandle ? { frameHandle: FRAME_HANDLE } : {}),
  })
}

describe('FaceRecognizer — hasEmbeddedFace is stamped only by a landed gallery row', () => {
  it('marks a collected face that was NEVER recognised — assignability, not recognition', async () => {
    const h = makeHarness()
    await h.rec.refreshGallery()
    await seeFace(h.rec, 't-collected')

    await h.rec.onTrackEnd(DEVICE_ID, 't-collected')

    expect(h.insert).toHaveBeenCalledTimes(1)
    // No identity was ever assigned (empty gallery) and the mark still fires:
    // an unassigned gallery row is exactly what an operator assigns.
    expect(h.insert.mock.calls[0]![0].recognizedIdentityId).toBeUndefined()
    expect(h.markEmbeddedFace).toHaveBeenCalledTimes(1)
    expect(h.markEmbeddedFace).toHaveBeenCalledWith('t-collected')
  })

  it('does NOT mark an imageless track — no crop was ever captured, so no gallery row exists', async () => {
    // `captureCrop` misses every tier: the R1 gate attempted a capture (the
    // candidate carries a faceBbox) and got nothing, so `onTrackEnd` drops the
    // track before any store call. `hasFace` would already be true for this
    // track; `hasEmbeddedFace` must not be.
    const h = makeHarness({ captureCrop: async () => null })
    await h.rec.refreshGallery()
    await seeFace(h.rec, 't-imageless')

    await h.rec.onTrackEnd(DEVICE_ID, 't-imageless')

    expect(h.insert).not.toHaveBeenCalled()
    expect(h.markEmbeddedFace).not.toHaveBeenCalled()
  })

  it('does NOT mark when the crop store fails — the row is dropped, so nothing is assignable', async () => {
    // `mediaStore.put` throws ⇒ `mediaId === undefined` ⇒ the face row is
    // dropped rather than persisted imageless. A mark here would promise the
    // gallery a face it does not hold.
    const h = makeHarness({
      mediaStore: {
        put: async () => {
          throw new Error('disk full')
        },
      },
    })
    await h.rec.refreshGallery()
    await seeFace(h.rec, 't-crop-store-down')

    await h.rec.onTrackEnd(DEVICE_ID, 't-crop-store-down')

    expect(h.insert).not.toHaveBeenCalled()
    expect(h.markEmbeddedFace).not.toHaveBeenCalled()
  })

  it('does NOT mark when the faceStore insert itself fails', async () => {
    const h = makeHarness({
      faceStore: {
        insert: async () => {
          throw new Error('store unavailable')
        },
      },
    })
    await h.rec.refreshGallery()
    await seeFace(h.rec, 't-insert-fails')

    await h.rec.onTrackEnd(DEVICE_ID, 't-insert-fails')

    expect(h.markEmbeddedFace).not.toHaveBeenCalled()
  })

  it('does NOT mark a track that ended without a held face at all', async () => {
    const h = makeHarness()
    await h.rec.refreshGallery()

    await h.rec.onTrackEnd(DEVICE_ID, 'never-seen')

    expect(h.markEmbeddedFace).not.toHaveBeenCalled()
  })

  it('omitting the dep entirely is a safe no-op (optional, like recomputeImportance)', async () => {
    const h = makeHarness({ markEmbeddedFace: undefined })
    await h.rec.refreshGallery()
    await seeFace(h.rec, 't-no-dep')

    await expect(h.rec.onTrackEnd(DEVICE_ID, 't-no-dep')).resolves.toBeUndefined()
    expect(h.insert).toHaveBeenCalledTimes(1)
  })
})
