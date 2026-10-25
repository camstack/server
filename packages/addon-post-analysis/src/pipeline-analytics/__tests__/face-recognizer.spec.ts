import type { PipelineAnalyticsFaceGalleryChangedPayload } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FaceRecognizer, type FaceRecognizerDeps } from '../face-recognizer.js'
import { FACE_DEFAULTS } from '../face-settings.js'
import type { GallerySample } from '../pipeline/face-matcher.js'
import type { LabelCandidate } from '../pipeline/label-tier.js'
import type { TrackedDetectionOut } from '../pipeline/frame-processor.js'
import { makeSilentLogger } from './test-helpers.js'
import { makeTestFrameHandle } from './support/frame-handle.js'
import { makeTrackedDetectionOut } from './support/tracked-detection-out.js'

function deps(overrides: Partial<FaceRecognizerDeps> = {}): FaceRecognizerDeps {
  const loadGallery = vi.fn<FaceRecognizerDeps['identityStore']['loadGallery']>(
    async (): Promise<readonly GallerySample[]> => [],
  )
  const listIdentities = vi.fn<FaceRecognizerDeps['identityStore']['listIdentities']>(
    async () => [] as readonly { id: string; name: string }[],
  )
  const applyLabelCandidate = vi.fn<FaceRecognizerDeps['trackStore']['applyLabelCandidate']>(
    async (_trackId: string, candidate: LabelCandidate) => ({
      kind: 'write' as const,
      tier: 2 as const,
      patch: {
        subLabel: candidate.text,
        subLabelScore: candidate.score,
        subLabelMeta: {
          stepId: candidate.stepId,
          decidedAt: candidate.decidedAt,
          ...(candidate.identityId !== undefined ? { identityId: candidate.identityId } : {}),
        },
      },
    }),
  )
  const base: FaceRecognizerDeps = {
    identityStore: { loadGallery, listIdentities },
    faceStore: { insert: vi.fn(async () => {}) },
    mediaStore: { put: vi.fn(async () => 501) },
    trackStore: { applyLabelCandidate },
    eventStore: { projectTrackLabel: vi.fn(async () => 0) },
    captureCrop: vi.fn(async () => Buffer.from('jpg')),
    logger: makeSilentLogger(),
  }
  return { ...base, ...overrides }
}

// The shared harness neutralizes the auto-match gates (min-face-size, the
// separate recognition floor, and min-identity-samples) so these legacy tests
// exercise the matching/crop logic in isolation. The gates have their own
// dedicated describe blocks below.
const ENABLED = {
  ...FACE_DEFAULTS,
  enabled: true,
  confirmFrames: 2,
  minFacePx: 0,
  recognitionMinFacePx: 0,
  minIdentitySamples: 1,
}

function tracked(trackId: string, embedding: number[], confidence = 0.9): TrackedDetectionOut {
  return makeTrackedDetectionOut({
    trackId,
    confidence,
    faceBbox: { x: 2, y: 2, w: 6, h: 6 },
    embedding,
    embeddingModelId: 'arcface-r100',
  })
}

describe('FaceRecognizer — match + label propagation', () => {
  let d: FaceRecognizerDeps
  let rec: FaceRecognizer

  beforeEach(() => {
    d = deps()
    rec = new FaceRecognizer(d)
  })

  it('ignores settings.enabled — the per-device gate was removed (master switch is GLOBAL, applied in the orchestrator)', async () => {
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    await rec.refreshGallery()
    const t = tracked('t1', [1, 0, 0, 0])
    // enabled:false must NOT suppress processing anymore — the recognizer runs
    // whenever embedding-bearing candidates are present.
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: { ...ENABLED, enabled: false },
      cropPadding: 0,
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 2,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: { ...ENABLED, enabled: false },
      cropPadding: 0,
    })
    expect(d.trackStore.applyLabelCandidate).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ text: 'Alice', tier: 2 }),
    )
  })

  it('crops the FACE bbox (faceBbox), not the person bbox', async () => {
    const personBbox = { x: 0, y: 0, w: 100, h: 300 }
    const faceBbox = { x: 30, y: 10, w: 40, h: 40 }
    const t = makeTrackedDetectionOut({
      trackId: 't1',
      bbox: personBbox,
      faceBbox,
      embedding: [1, 0, 0, 0],
      embeddingModelId: 'arcface-r100',
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    // 6th arg is the trackId (ownerId for the once-per-track fallback log);
    // 7th (S4) is the deviceId for the CaptureScheduler lane.
    expect(d.captureCrop).toHaveBeenCalledWith(
      expect.anything(),
      faceBbox,
      640,
      480,
      0,
      expect.any(String),
      7,
    )
    expect(d.captureCrop).not.toHaveBeenCalledWith(
      expect.anything(),
      personBbox,
      640,
      480,
      0,
      expect.any(String),
      7,
    )
  })

  it('does NOT crop the person bbox when faceBbox is absent, and drops the crop-less track', async () => {
    // An inherited embedding on a frame with no face detail has no faceBbox.
    // Cropping the person/torso box here produced the "not a face" gallery
    // images; instead we capture nothing (R1 gate intact). A face row with no
    // crop is a useless "no image" gallery result, so onTrackEnd DROPS it
    // rather than persisting an imageless row.
    const personBbox = { x: 0, y: 0, w: 100, h: 300 }
    const t = makeTrackedDetectionOut({
      trackId: 't1',
      bbox: personBbox,
      embedding: [1, 0, 0, 0],
      embeddingModelId: 'arcface-r100',
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    expect(d.captureCrop).not.toHaveBeenCalled()
    // No crop captured → no imageless row is written (no put, no insert).
    await rec.onTrackEnd(7, 't1')
    expect(d.mediaStore.put).not.toHaveBeenCalled()
    expect(d.faceStore.insert).not.toHaveBeenCalled()
  })

  it('drops an imageless track: onTrackEnd never persists a crop-less face row', async () => {
    // Even when captureCrop always fails (returns null), no face row is written.
    d = deps({ captureCrop: vi.fn(async () => null) })
    rec = new FaceRecognizer(d)
    await rec.refreshGallery()
    const t = tracked('t1', [1, 0, 0, 0], 0.9) // carries faceBbox → capture attempted
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    expect(d.captureCrop).toHaveBeenCalled() // R1 gate: faceBbox present → attempted
    await rec.onTrackEnd(7, 't1')
    expect(d.mediaStore.put).not.toHaveBeenCalled()
    expect(d.faceStore.insert).not.toHaveBeenCalled()
  })

  it('no-ops when no candidate carries an embedding (the de-facto per-camera gate is the detection pipeline)', async () => {
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    await rec.refreshGallery()
    const noEmbedding = makeTrackedDetectionOut({
      trackId: 't1',
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [noEmbedding],
      settings: ENABLED,
      cropPadding: 0,
    })
    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled()
  })

  it('assigns + propagates the name forward-only after confirmFrames', async () => {
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    await rec.refreshGallery()

    const t = tracked('t1', [1, 0, 0, 0])
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
    })
    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled() // 1 confirmation < 2

    await rec.processFrame({
      deviceId: 7,
      timestamp: 2,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
    })
    expect(d.trackStore.applyLabelCandidate).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ text: 'Alice', tier: 2 }),
    )
    expect(d.eventStore.projectTrackLabel).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ subLabel: 'Alice' }),
    )

    // A third identical frame must NOT re-fire the label writes (changed-gated).
    await rec.processFrame({
      deviceId: 7,
      timestamp: 3,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
    })
    expect(d.trackStore.applyLabelCandidate).toHaveBeenCalledTimes(1)
    expect(d.eventStore.projectTrackLabel).toHaveBeenCalledTimes(1)
  })

  it('retains the assigned-identity match confidence for the NC label-confidence seam', async () => {
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    await rec.refreshGallery()

    const t = tracked('t1', [1, 0, 0, 0]) // identical vector ⇒ cosine 1
    for (const timestamp of [1, 2]) {
      await rec.processFrame({
        deviceId: 7,
        timestamp,
        frameWidth: 100,
        frameHeight: 100,
        tracked: [t],
        settings: ENABLED,
        cropPadding: 0,
      })
    }
    expect(rec.bestLabelMatchConfidence('t1')).toBeCloseTo(1)
    // Dropped after the track ends.
    await rec.onTrackEnd(7, 't1')
    expect(rec.bestLabelMatchConfidence('t1')).toBeUndefined()
  })

  it('collect-only (empty gallery) retains NO match confidence', async () => {
    await rec.refreshGallery() // empty
    const t = tracked('t1', [1, 0, 0, 0])
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
    })
    expect(rec.bestLabelMatchConfidence('t1')).toBeUndefined()
  })

  it('with an empty gallery, never assigns (collect-only)', async () => {
    await rec.refreshGallery() // empty
    const t = tracked('t1', [1, 0, 0, 0])
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 2,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
    })
    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled()
  })

  // D662: the detector's score is on ITS model's scale (YuNet's is not SCRFD's),
  // and the runner already applied that model's floor before the face reached
  // here. A second bar in the recognizer can only be a no-op or a number
  // calibrated for another model — so there is none: a face the detector kept
  // is a candidate whatever its score.
  it('does not re-gate the detector score — the model floor on the runner is the only one', async () => {
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    await rec.refreshGallery()
    const low = tracked('t1', [1, 0, 0, 0], 0.2) // below the retired 0.5 recognizer bar
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [low],
      settings: ENABLED,
      cropPadding: 0,
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 2,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [low],
      settings: ENABLED,
      cropPadding: 0,
    })
    expect(d.trackStore.applyLabelCandidate).toHaveBeenCalledTimes(1)
  })
})

describe('FaceRecognizer — best-face capture + track-end persist', () => {
  let d: FaceRecognizerDeps
  let rec: FaceRecognizer

  beforeEach(() => {
    d = deps()
    rec = new FaceRecognizer(d)
  })

  it('captures the crop of the highest-confidence face and persists one buffer entry at track end', async () => {
    await rec.refreshGallery() // empty gallery => collect-only
    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.7)],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 200,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.95)],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    }) // new best
    expect(d.captureCrop).toHaveBeenCalledTimes(2)

    await rec.onTrackEnd(7, 't1')
    expect(d.mediaStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKind: 'face',
        ownerId: 'face-t1',
        kind: 'crop',
      }),
    )
    expect(d.faceStore.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'face-t1',
        deviceId: 7,
        trackId: 't1',
        assigned: false,
      }),
    )
    const inserted = vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      timestamp: number
      embedding: readonly number[]
    }
    expect(inserted.timestamp).toBe(200) // the best frame's timestamp
  })

  it('offers the face crop as a track preview when the track has none', async () => {
    const copyCropToTrackPreview = vi.fn(async () => {})
    d = deps({ copyCropToTrackPreview })
    rec = new FaceRecognizer(d)
    await rec.refreshGallery()
    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.9)],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 200,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.95)],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.onTrackEnd(7, 't1')
    expect(copyCropToTrackPreview).toHaveBeenCalledWith({
      deviceId: 7,
      trackId: 't1',
      crop: expect.any(Buffer),
      timestamp: 200,
    })
  })

  it('asks for the person crop + full frame from the same handle that produced the face', async () => {
    const onLiveHierarchy = vi.fn()
    d = deps({ onLiveHierarchy })
    rec = new FaceRecognizer(d)
    await rec.refreshGallery()
    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 1920,
      frameHeight: 1080,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.9)],
      settings: ENABLED,
      cropPadding: 0.1,
      frameHandle: makeTestFrameHandle(),
    })
    expect(onLiveHierarchy).toHaveBeenCalledWith({
      deviceId: 7,
      trackId: 't1',
      timestamp: 100,
      bodyBbox: { x: 0, y: 0, w: 10, h: 10 },
      frameWidth: 1920,
      frameHeight: 1080,
      cropPadding: 0.1,
      frameHandle: makeTestFrameHandle(),
    })
  })

  it('passes cropPadding through to captureCrop', async () => {
    await rec.refreshGallery() // empty gallery => collect-only
    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.9)],
      settings: ENABLED,
      cropPadding: 0.15,
      frameHandle: makeTestFrameHandle(),
    })
    expect(d.captureCrop).toHaveBeenCalledWith(
      expect.anything(), // frameHandle
      expect.anything(), // bbox
      100, // frameWidth
      100, // frameHeight
      0.15, // padding
      expect.any(String), // ownerId (trackId)
      7, // deviceId (S4: CaptureScheduler lane key)
    )
  })

  it('records recognizedIdentityId on the buffered face when the track was recognized', async () => {
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    await rec.refreshGallery()
    const t = tracked('t1', [1, 0, 0, 0])
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 2,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.onTrackEnd(7, 't1')
    expect(d.faceStore.insert).toHaveBeenCalledWith(
      expect.objectContaining({ recognizedIdentityId: 'id-alice' }),
    )
  })

  // ── confirmFrames is a HARD gate on the persisted identity ──
  // A single above-threshold frame must NOT stamp the buffered face with an
  // identity: assignment requires `confirmFrames` cumulative confirmations. The
  // old `state.assignedIdentityId ?? match?.identityId` fallback leaked the raw
  // per-frame match onto the held face after ONE frame — auto-assigning wrong
  // identities on lucky single frames AND persisting them with NO bestMatchScore
  // (10/11 live auto-assigns had no score). The buffered row for a sub-confirm
  // track must carry neither recognizedIdentityId nor bestMatchScore.
  it('does NOT persist an identity when a single frame matches but confirmFrames is not reached', async () => {
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    await rec.refreshGallery()
    // Exactly ONE matching frame — below confirmFrames (2).
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0])],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.onTrackEnd(7, 't1')
    expect(d.faceStore.insert).toHaveBeenCalledTimes(1)
    const inserted = vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      recognizedIdentityId?: string
      bestMatchScore?: number
    }
    expect(inserted.recognizedIdentityId).toBeUndefined()
    expect(inserted.bestMatchScore).toBeUndefined()
  })

  // ── The gallery crop must be the EXACT ArcFace input ──
  // The embedding is computed by the executor on a landmark-aligned 112² crop.
  // When that crop rides on the candidate (`faceAlignedCrop`, base64 JPEG), the
  // recognizer persists it VERBATIM as the gallery image — 1:1 with the embedding
  // — instead of separately capturing a natural crop (what you see = what the
  // model embedded).

  it('persists the exact aligned crop (ArcFace input) as the gallery image, not a captured crop', async () => {
    const alignedBytes = Buffer.from('exact-arcface-input-jpeg')
    const alignedB64 = alignedBytes.toString('base64')
    await rec.refreshGallery() // empty gallery → collect-only
    const t = {
      ...tracked('t1', [1, 0, 0, 0], 0.9),
      faceAlignedCrop: alignedB64,
    }
    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    // The aligned crop is self-contained → no natural capture is performed.
    expect(d.captureCrop).not.toHaveBeenCalled()

    await rec.onTrackEnd(7, 't1')
    // The persisted media is byte-identical to the executor's ArcFace input.
    expect(d.mediaStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKind: 'face',
        ownerId: 'face-t1',
        data: alignedBytes,
      }),
    )
    expect(d.faceStore.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'face-t1', assigned: false }),
    )
  })

  it('falls back to the natural captured crop when the candidate carries no aligned crop', async () => {
    // Native-with-fallback: aligned crop missing (older runner / plain-crop path)
    // → today's natural capture, gated on faceBbox + frameHandle. Never worse.
    await rec.refreshGallery()
    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.9)], // no faceAlignedCrop
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    expect(d.captureCrop).toHaveBeenCalled()
    await rec.onTrackEnd(7, 't1')
    expect(d.mediaStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ ownerKind: 'face', data: Buffer.from('jpg') }),
    )
  })

  it('uses the aligned crop even without a frameHandle (self-contained bytes, no capture path)', async () => {
    const alignedB64 = Buffer.from('aligned').toString('base64')
    await rec.refreshGallery()
    const t = {
      ...tracked('t1', [1, 0, 0, 0], 0.9),
      faceAlignedCrop: alignedB64,
    }
    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: undefined, // no live frame — capture path unavailable
    })
    expect(d.captureCrop).not.toHaveBeenCalled()
    await rec.onTrackEnd(7, 't1')
    expect(d.mediaStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ data: Buffer.from('aligned') }),
    )
  })

  it('onTrackEnd is a no-op for an unknown track', async () => {
    await rec.onTrackEnd(7, 'never-seen')
    expect(d.faceStore.insert).not.toHaveBeenCalled()
  })

  it('does not capture a crop when no frameHandle is available', async () => {
    await rec.refreshGallery()
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0])],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: undefined,
    })
    expect(d.captureCrop).not.toHaveBeenCalled()
  })

  // ── Regression: crop robustness (the "mediaId NULL on every face" bug) ──
  // The best-face hold used to overwrite the crop ONLY on a new max-confidence
  // frame. A single transient capture miss on the peak frame (shm slot recycled
  // / non-RGB decode → captureCrop returns null) then poisoned the whole track:
  // its crop stayed null forever even though other frames could have produced
  // one. The hold now backfills a crop from ANY later frame and never regresses
  // a held crop back to null.

  it('backfills a crop from a later frame when the peak frame capture failed', async () => {
    const backfill = Buffer.from('later-jpg')
    d = deps({
      captureCrop: vi
        .fn()
        .mockResolvedValueOnce(null) // peak frame — transient miss
        .mockResolvedValueOnce(backfill), // later, lower-confidence frame
    })
    rec = new FaceRecognizer(d)
    await rec.refreshGallery() // empty gallery => collect-only

    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.95)], // peak confidence
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 200,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.8)], // lower — not a new best
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    // A crop was attempted on BOTH frames (peak miss + backfill), even though
    // the second is not a new best — because the track still lacked a crop.
    expect(d.captureCrop).toHaveBeenCalledTimes(2)

    await rec.onTrackEnd(7, 't1')
    // The backfilled crop is persisted; the embedding/timestamp stay the peak.
    expect(d.mediaStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKind: 'face',
        ownerId: 'face-t1',
        data: backfill,
      }),
    )
    const inserted = vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      timestamp: number
      mediaId?: number
    }
    expect(inserted.timestamp).toBe(100) // peak (embedding) frame
    expect(inserted.mediaId).toBe(501) // crop persisted → mediaId set (not NULL)
  })

  it('never regresses a held crop to null when a later higher-confidence frame fails to capture', async () => {
    const good = Buffer.from('early-jpg')
    d = deps({
      captureCrop: vi
        .fn()
        .mockResolvedValueOnce(good) // early, lower-confidence frame — success
        .mockResolvedValueOnce(null), // later, higher-confidence frame — miss
    })
    rec = new FaceRecognizer(d)
    await rec.refreshGallery()

    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.7)],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 200,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.95)], // new best, but capture misses
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })

    await rec.onTrackEnd(7, 't1')
    // The earlier good crop survives the failed peak-frame capture.
    expect(d.mediaStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ ownerKind: 'face', data: good }),
    )
    const inserted = vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      timestamp: number
      mediaId?: number
    }
    expect(inserted.timestamp).toBe(200) // best (embedding) frame is still the peak
    expect(inserted.mediaId).toBe(501)
  })

  it('captures the crop before any identity-label store write (frame-sensitive work first)', async () => {
    const order: string[] = []
    d = deps({
      captureCrop: vi.fn(async () => {
        order.push('crop')
        return Buffer.from('jpg')
      }),
      trackStore: {
        applyLabelCandidate: vi.fn(async (_trackId: string, candidate: LabelCandidate) => {
          order.push('applyLabelCandidate')
          return {
            kind: 'write' as const,
            tier: 2 as const,
            patch: {
              subLabel: candidate.text,
              subLabelScore: candidate.score,
            },
          }
        }),
      },
      eventStore: {
        projectTrackLabel: vi.fn(async () => {
          order.push('projectTrackLabel')
          return 0
        }),
      },
    })
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    rec = new FaceRecognizer(d)
    await rec.refreshGallery()

    // confirmFrames=2 → the label fires on the second frame, in the SAME
    // processFrame call as a crop capture (a higher-confidence new best); the
    // crop must be captured before the label store writes.
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.7)],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 2,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.95)], // new best → captures again
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    expect(d.trackStore.applyLabelCandidate).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ text: 'Alice', tier: 2 }),
    )
    // Within the second frame, the crop capture precedes both label writes.
    expect(order.indexOf('crop')).toBeLessThan(order.indexOf('applyLabelCandidate'))
    expect(order.indexOf('crop')).toBeLessThan(order.indexOf('projectTrackLabel'))
  })
})

// ── D1: face-gallery-changed bus emit (kind:'buffered') ──────────────

describe('FaceRecognizer — face-gallery-changed emit on buffer', () => {
  it('onTrackEnd emits exactly one face-gallery-changed(kind:buffered) after the store write succeeds', async () => {
    const emitted: PipelineAnalyticsFaceGalleryChangedPayload[] = []
    const d = deps({
      emitFaceGalleryChanged: (payload: PipelineAnalyticsFaceGalleryChangedPayload) =>
        emitted.push(payload),
    })
    const rec = new FaceRecognizer(d)
    await rec.refreshGallery() // empty gallery => collect-only

    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.9)],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    // Not yet emitted — onTrackEnd hasn't run, no row persisted yet.
    expect(emitted).toHaveLength(0)

    await rec.onTrackEnd(7, 't1')

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      deviceId: 7,
      faceId: 'face-t1',
      kind: 'buffered',
    })
    // Ordering: the faceStore.insert store write must have already resolved
    // (mocked async fn) before the emit — verified indirectly by the emit
    // firing only after onTrackEnd's insert branch completed successfully.
    expect(d.faceStore.insert).toHaveBeenCalled()
  })

  it('does NOT emit when onTrackEnd drops an imageless track (no crop captured)', async () => {
    const emitted: PipelineAnalyticsFaceGalleryChangedPayload[] = []
    const d = deps({
      captureCrop: vi.fn(async () => null),
      emitFaceGalleryChanged: (payload: PipelineAnalyticsFaceGalleryChangedPayload) =>
        emitted.push(payload),
    })
    const rec = new FaceRecognizer(d)
    await rec.refreshGallery()
    const t = tracked('t1', [1, 0, 0, 0], 0.9) // carries faceBbox → capture attempted
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [t],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.onTrackEnd(7, 't1')
    expect(d.faceStore.insert).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(0)
  })

  it('omitting emitFaceGalleryChanged entirely is a safe no-op (optional dep)', async () => {
    const d = deps() // no emitFaceGalleryChanged override — dep is undefined
    const rec = new FaceRecognizer(d)
    await rec.refreshGallery()
    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.9)],
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await expect(rec.onTrackEnd(7, 't1')).resolves.toBeUndefined()
    expect(d.faceStore.insert).toHaveBeenCalled()
  })
})

describe('FaceRecognizer — #26 auto-match gates', () => {
  it('rejects a sub-minFacePx face: not matched, not enrolled', async () => {
    const d = deps()
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    const rec = new FaceRecognizer(d)
    await rec.refreshGallery()
    // faceBbox shorter side 12px < minFacePx 30 → dropped before matching/enrolment.
    const tiny = makeTrackedDetectionOut({
      trackId: 't-tiny',
      confidence: 0.99,
      bbox: { x: 0, y: 0, w: 100, h: 300 },
      faceBbox: { x: 10, y: 10, w: 12, h: 12 },
      embedding: [1, 0, 0, 0],
      embeddingModelId: 'arcface-r100',
    })
    const settings = { ...ENABLED, minFacePx: 30, minIdentitySamples: 2 }
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [tiny],
      settings,
      cropPadding: 0,
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 2,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [tiny],
      settings,
      cropPadding: 0,
    })
    // No candidate ⇒ no label, no crop capture.
    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled()
    expect(d.captureCrop).not.toHaveBeenCalled()
    // Track end must NOT enrol a face row (nothing was held).
    await rec.onTrackEnd(7, 't-tiny')
    expect(d.faceStore.insert).not.toHaveBeenCalled()
  })

  it('does not auto-match a 1-sample identity under minIdentitySamples=2', async () => {
    const d = deps()
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-bob',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-bob', name: 'Bob' }])
    const rec = new FaceRecognizer(d)
    await rec.refreshGallery()
    const t = makeTrackedDetectionOut({
      trackId: 't1',
      confidence: 0.99,
      bbox: { x: 0, y: 0, w: 100, h: 300 },
      faceBbox: { x: 10, y: 10, w: 40, h: 40 },
      embedding: [1, 0, 0, 0],
      embeddingModelId: 'arcface-r100',
    })
    const settings = { ...ENABLED, minFacePx: 30, minIdentitySamples: 2 }
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [t],
      settings,
      cropPadding: 0,
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 2,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [t],
      settings,
      cropPadding: 0,
    })
    // 1-sample identity is not an eligible target → no label applied.
    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled()
  })
})

// ── Recognition floor (auto-assignment ≥ recognitionMinFacePx), separate from
//    the detection/collection floor (minFacePx). A face between the two floors
//    is still DETECTED, cropped, and STORED (available for manual assignment),
//    but is NEVER auto-assigned an identity (recognizedIdentityId stays UNSET). ──

describe('FaceRecognizer — recognition floor (recognitionMinFacePx)', () => {
  let d: FaceRecognizerDeps
  let rec: FaceRecognizer

  // minFacePx (detect) 30, recognitionMinFacePx (recognize) 48, 2 confirmations,
  // 1-sample eligibility so a single enrolled sample is a valid target.
  const RECOG = {
    ...FACE_DEFAULTS,
    enabled: true,
    confirmFrames: 2,
    minFacePx: 30,
    recognitionMinFacePx: 48,
    minIdentitySamples: 1,
  }

  /** A face candidate carrying an explicit native short side (px). */
  function nativeFace(trackId: string, embedding: number[], nativePx: number, confidence = 0.9) {
    return {
      ...tracked(trackId, embedding, confidence),
      nativeFaceShortSidePx: nativePx,
    }
  }

  beforeEach(() => {
    d = deps()
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    rec = new FaceRecognizer(d)
  })

  async function feed(track: TrackedDetectionOut, timestamps: number[]): Promise<void> {
    for (const timestamp of timestamps) {
      await rec.processFrame({
        deviceId: 7,
        timestamp,
        frameWidth: 640,
        frameHeight: 480,
        tracked: [track],
        settings: RECOG,
        cropPadding: 0,
        frameHandle: makeTestFrameHandle(),
      })
    }
  }

  it('auto-assigns a face AT the recognition floor (native 48px)', async () => {
    await rec.refreshGallery()
    await feed(nativeFace('t1', [1, 0, 0, 0], 48), [1, 2])
    expect(d.trackStore.applyLabelCandidate).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ text: 'Alice', tier: 2 }),
    )
  })

  it('does NOT auto-assign a face just BELOW the floor (native 47px) — but still stores it', async () => {
    await rec.refreshGallery()
    await feed(nativeFace('t1', [1, 0, 0, 0], 47), [1, 2])
    // Below the recognition floor → never labelled (fail-safe).
    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled()
    expect(d.eventStore.projectTrackLabel).not.toHaveBeenCalled()
    // But it IS collected: onTrackEnd persists an UNASSIGNED face row (a crop was
    // captured), available for manual assignment, with recognizedIdentityId unset.
    await rec.onTrackEnd(7, 't1')
    expect(d.faceStore.insert).toHaveBeenCalledTimes(1)
    const row = vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      recognizedIdentityId?: string
      bestMatchScore?: number
      assigned: boolean
    }
    expect(row.assigned).toBe(false)
    expect(row.recognizedIdentityId).toBeUndefined()
    expect(row.bestMatchScore).toBeUndefined() // no winning match → no score
  })

  it('never retains a match confidence for a below-floor face', async () => {
    await rec.refreshGallery()
    await feed(nativeFace('t1', [1, 0, 0, 0], 40), [1, 2, 3])
    expect(rec.bestLabelMatchConfidence('t1')).toBeUndefined()
  })

  it('falls back to the detection-frame faceBbox short side when no native measure is present', async () => {
    await rec.refreshGallery()
    // No nativeFaceShortSidePx; tracked()'s faceBbox is 6px < 48 → below the floor.
    await feed(tracked('t1', [1, 0, 0, 0]), [1, 2])
    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled()
  })

  it('a candidate with NO size measure at all passes the floor (deferred to the detection gate)', async () => {
    await rec.refreshGallery()
    // No faceBbox and no native measure → size unknown → not spuriously suppressed.
    const noSize = makeTrackedDetectionOut({
      trackId: 't1',
      bbox: { x: 0, y: 0, w: 100, h: 300 },
      faceBbox: undefined,
      embedding: [1, 0, 0, 0],
      embeddingModelId: 'arcface-r100',
    })
    await feed(noSize, [1, 2])
    expect(d.trackStore.applyLabelCandidate).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ text: 'Alice', tier: 2 }),
    )
  })
})

// ── Auditability: the winning match cosine + native face px are persisted onto
//    the face row (2026-07-23 face-quality batch). ──

describe('FaceRecognizer — persists bestMatchScore + nativeFaceShortSidePx', () => {
  let d: FaceRecognizerDeps
  let rec: FaceRecognizer

  beforeEach(() => {
    d = deps()
    rec = new FaceRecognizer(d)
  })

  it('persists the winning cosine and native px onto the recognized face row', async () => {
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      {
        identityId: 'id-alice',
        embedding: [1, 0, 0, 0],
        modelId: 'arcface-r100',
      },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    rec = new FaceRecognizer(d)
    await rec.refreshGallery()
    const t = { ...tracked('t1', [1, 0, 0, 0]), nativeFaceShortSidePx: 96 }
    for (const timestamp of [1, 2]) {
      await rec.processFrame({
        deviceId: 7,
        timestamp,
        frameWidth: 640,
        frameHeight: 480,
        tracked: [t],
        settings: { ...ENABLED, recognitionMinFacePx: 48 },
        cropPadding: 0,
        frameHandle: makeTestFrameHandle(),
      })
    }
    await rec.onTrackEnd(7, 't1')
    const row = vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      recognizedIdentityId?: string
      bestMatchScore?: number
      nativeFaceShortSidePx?: number
    }
    expect(row.recognizedIdentityId).toBe('id-alice')
    // Identical probe/gallery vectors ⇒ cosine 1.
    expect(row.bestMatchScore).toBeCloseTo(1)
    expect(row.nativeFaceShortSidePx).toBe(96)
  })

  it('omits nativeFaceShortSidePx when the runner reported no native measure (legacy)', async () => {
    await rec.refreshGallery() // empty gallery → collect-only (still persists a row)
    await rec.processFrame({
      deviceId: 7,
      timestamp: 100,
      frameWidth: 100,
      frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.9)], // no nativeFaceShortSidePx
      settings: ENABLED,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.onTrackEnd(7, 't1')
    const row = vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      bestMatchScore?: number
      nativeFaceShortSidePx?: number
    }
    // Collect-only: never recognized → no score; no native measure → no px.
    expect(row.bestMatchScore).toBeUndefined()
    expect('nativeFaceShortSidePx' in row).toBe(false)
  })
})

// ── SUGGESTED-assignment tier (2026-07-24). A plausible-but-not-confident match
//    that MISSES auto-assignment surfaces as a SUGGESTION (persisted
//    `suggestedIdentityId`/`suggestedMatchScore`), NEVER an assignment
//    (`recognizedIdentityId` stays unset). Two bands:
//      • cosine in [0.8 × similarityThreshold, similarityThreshold) AND face ≥
//        the recognition size floor, OR
//      • cosine ≥ similarityThreshold BUT face below the recognition size floor
//        (blocked ONLY by size).
//    Assigned and suggestion fields are mutually exclusive. ──

describe('FaceRecognizer — suggested-assignment tier', () => {
  let d: FaceRecognizerDeps
  let rec: FaceRecognizer

  // similarityThreshold 0.625 ⇒ suggestion floor 0.50 (D222: the floor is
  // DERIVED, `deriveSuggestionMinCosine` = 0.8 × the threshold, and there is no
  // second knob to set — the threshold is chosen here so the band's edges land
  // on the round numbers these cases are written against). Recognition floor
  // 48px; minFacePx 0 so tiny faces are still COLLECTED (detection floor off)
  // and can reach the suggestion classifier; 1-sample eligibility; margin 0.15
  // (a single gallery identity has no competitor, so the ambiguity guard never
  // fires).
  const SUGG = {
    ...FACE_DEFAULTS,
    enabled: true,
    confirmFrames: 2,
    minFacePx: 0,
    recognitionMinFacePx: 48,
    similarityThreshold: 0.625,
    margin: 0.15,
    minIdentitySamples: 1,
  }

  /** A face whose embedding has a KNOWN cosine to the single gallery vector
   *  [1,0]: probe [c, √(1−c²)] is unit-length ⇒ cosine == c. */
  function suggFace(trackId: string, cosine: number, nativePx: number) {
    const s = Math.sqrt(Math.max(0, 1 - cosine * cosine))
    return {
      ...tracked(trackId, [cosine, s]),
      nativeFaceShortSidePx: nativePx,
    }
  }

  beforeEach(() => {
    d = deps()
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([
      { identityId: 'id-alice', embedding: [1, 0], modelId: 'arcface-r100' },
    ])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    rec = new FaceRecognizer(d)
  })

  async function runTrack(
    track: ReturnType<typeof tracked>,
    timestamps: number[],
  ): Promise<{
    recognizedIdentityId?: string
    suggestedIdentityId?: string
    suggestedMatchScore?: number
    assigned: boolean
  }> {
    for (const timestamp of timestamps) {
      await rec.processFrame({
        deviceId: 7,
        timestamp,
        frameWidth: 640,
        frameHeight: 480,
        tracked: [track],
        settings: SUGG,
        cropPadding: 0,
        frameHandle: makeTestFrameHandle(),
      })
    }
    await rec.onTrackEnd(7, track.trackId)
    return vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      recognizedIdentityId?: string
      suggestedIdentityId?: string
      suggestedMatchScore?: number
      assigned: boolean
    }
  }

  it('near-miss band: cosine 0.55 with a large face (96px) → suggestion, no assignment', async () => {
    await rec.refreshGallery()
    const row = await runTrack(suggFace('t1', 0.55, 96), [1, 2])
    expect(row.recognizedIdentityId).toBeUndefined()
    expect(row.suggestedIdentityId).toBe('id-alice')
    expect(row.suggestedMatchScore).toBeCloseTo(0.55)
    expect(row.assigned).toBe(false)
    // Never labelled — a suggestion is not an assignment.
    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled()
  })

  it('AT the suggestion floor: cosine 0.50 (inclusive), face 48px → suggestion', async () => {
    await rec.refreshGallery()
    const row = await runTrack(suggFace('t1', 0.5, 48), [1, 2])
    expect(row.suggestedIdentityId).toBe('id-alice')
    expect(row.suggestedMatchScore).toBeCloseTo(0.5)
    expect(row.recognizedIdentityId).toBeUndefined()
  })

  it('just BELOW the suggestion floor: cosine 0.4999 → NO suggestion', async () => {
    await rec.refreshGallery()
    const row = await runTrack(suggFace('t1', 0.4999, 96), [1, 2])
    expect(row.suggestedIdentityId).toBeUndefined()
    expect(row.suggestedMatchScore).toBeUndefined()
    expect(row.recognizedIdentityId).toBeUndefined()
  })

  it('just BELOW the auto-threshold: cosine 0.6249, face 48px → suggestion (near-miss)', async () => {
    await rec.refreshGallery()
    const row = await runTrack(suggFace('t1', 0.6249, 48), [1, 2])
    expect(row.suggestedIdentityId).toBe('id-alice')
    expect(row.suggestedMatchScore).toBeCloseTo(0.6249)
    expect(row.recognizedIdentityId).toBeUndefined()
  })

  it('AT the auto-threshold with a large face: cosine 0.625, face 48px → AUTO-ASSIGNED, no suggestion', async () => {
    await rec.refreshGallery()
    const row = await runTrack(suggFace('t1', 0.625, 48), [1, 2])
    expect(row.recognizedIdentityId).toBe('id-alice')
    expect(row.suggestedIdentityId).toBeUndefined()
    expect(row.suggestedMatchScore).toBeUndefined()
    expect(d.trackStore.applyLabelCandidate).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ text: 'Alice', tier: 2 }),
    )
  })

  it('size-blocked band: cosine 0.625 but face 47px (below the recognition floor) → suggestion, NOT assigned', async () => {
    await rec.refreshGallery()
    const row = await runTrack(suggFace('t1', 0.625, 47), [1, 2])
    expect(row.recognizedIdentityId).toBeUndefined()
    expect(row.suggestedIdentityId).toBe('id-alice')
    expect(row.suggestedMatchScore).toBeCloseTo(0.625)
    // Below the recognition floor → never auto-matched.
    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled()
  })

  it('small face just below threshold: cosine 0.6249, face 47px → NO suggestion (neither band)', async () => {
    await rec.refreshGallery()
    const row = await runTrack(suggFace('t1', 0.6249, 47), [1, 2])
    expect(row.suggestedIdentityId).toBeUndefined()
    expect(row.recognizedIdentityId).toBeUndefined()
  })

  /**
   * The live defect, as a test (D222). The 2026-08-19 retune took
   * `similarityThreshold` to 0.45 and left the separate `suggestionMinCosine`
   * at 0.50 — the band [0.50, 0.45) is EMPTY, so the recognizer stopped
   * producing suggestions entirely and said nothing about it. With the floor
   * derived, lowering the threshold WIDENS what is offered, which is what an
   * operator lowering a threshold expects. Nothing in the settings can put the
   * two numbers back in contradiction.
   */
  it('lowering the match threshold MOVES the suggestion floor with it (never inverts the band)', async () => {
    await rec.refreshGallery()
    const live = { ...SUGG, similarityThreshold: 0.45 }
    // 0.36 = 0.8 × 0.45 — the floor in force on the hub after this change.
    const atFloor = suggFace('t1', 0.37, 96)
    for (const timestamp of [1, 2]) {
      await rec.processFrame({
        deviceId: 7,
        timestamp,
        frameWidth: 640,
        frameHeight: 480,
        tracked: [atFloor],
        settings: live,
        cropPadding: 0,
        frameHandle: makeTestFrameHandle(),
      })
    }
    await rec.onTrackEnd(7, atFloor.trackId)
    const row = vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      suggestedIdentityId?: string
      recognizedIdentityId?: string
    }
    // Under the OLD two-knob wiring this face was below a 0.50 floor and
    // produced nothing at all.
    expect(row.suggestedIdentityId).toBe('id-alice')
    expect(row.recognizedIdentityId).toBeUndefined()
  })

  it('small face at the suggestion floor: cosine 0.50, face 47px → NO suggestion (near-miss needs size ≥ floor)', async () => {
    await rec.refreshGallery()
    const row = await runTrack(suggFace('t1', 0.5, 47), [1, 2])
    expect(row.suggestedIdentityId).toBeUndefined()
    expect(row.recognizedIdentityId).toBeUndefined()
  })

  it('mutual exclusivity: a track that later AUTO-ASSIGNS writes NO suggestion (even after an earlier suggestion-band frame)', async () => {
    await rec.refreshGallery()
    // Frame 1 is a near-miss (records a suggestion); frames 2-3 auto-assign.
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [suggFace('t1', 0.55, 96)],
      settings: SUGG,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    for (const timestamp of [2, 3]) {
      await rec.processFrame({
        deviceId: 7,
        timestamp,
        frameWidth: 640,
        frameHeight: 480,
        tracked: [suggFace('t1', 0.95, 96)],
        settings: SUGG,
        cropPadding: 0,
        frameHandle: makeTestFrameHandle(),
      })
    }
    await rec.onTrackEnd(7, 't1')
    const row = vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      recognizedIdentityId?: string
      suggestedIdentityId?: string
      suggestedMatchScore?: number
    }
    expect(row.recognizedIdentityId).toBe('id-alice')
    expect(row.suggestedIdentityId).toBeUndefined()
    expect(row.suggestedMatchScore).toBeUndefined()
  })

  it('below both bands: cosine 0.30 → neither assignment nor suggestion (row still persisted)', async () => {
    await rec.refreshGallery()
    const row = await runTrack(suggFace('t1', 0.3, 96), [1, 2])
    expect(row.recognizedIdentityId).toBeUndefined()
    expect(row.suggestedIdentityId).toBeUndefined()
    expect(row.suggestedMatchScore).toBeUndefined()
    expect(row.assigned).toBe(false)
  })

  it('empty gallery ⇒ collect-only, never a suggestion', async () => {
    vi.mocked(d.identityStore.loadGallery).mockResolvedValue([])
    vi.mocked(d.identityStore.listIdentities).mockResolvedValue([])
    rec = new FaceRecognizer(d)
    await rec.refreshGallery()
    const row = await runTrack(suggFace('t1', 0.55, 96), [1, 2])
    expect(row.suggestedIdentityId).toBeUndefined()
    expect(row.suggestedMatchScore).toBeUndefined()
  })

  it('keeps the PEAK suggestion cosine across frames', async () => {
    await rec.refreshGallery()
    // 0.52 then 0.58 — both near-miss; the higher one wins.
    await rec.processFrame({
      deviceId: 7,
      timestamp: 1,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [suggFace('t1', 0.52, 96)],
      settings: SUGG,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.processFrame({
      deviceId: 7,
      timestamp: 2,
      frameWidth: 640,
      frameHeight: 480,
      tracked: [suggFace('t1', 0.58, 96)],
      settings: SUGG,
      cropPadding: 0,
      frameHandle: makeTestFrameHandle(),
    })
    await rec.onTrackEnd(7, 't1')
    const row = vi.mocked(d.faceStore.insert).mock.calls[0]![0] as {
      suggestedMatchScore?: number
    }
    expect(row.suggestedMatchScore).toBeCloseTo(0.58)
  })
})
