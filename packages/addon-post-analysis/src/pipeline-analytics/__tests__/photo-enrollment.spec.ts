/**
 * Enrolling an identity from an uploaded PHOTO.
 *
 * This is the path that exists because the other one cannot be trusted: a
 * detected-face sample's pixels lived on the footage volume and 28 of 32 of
 * them were destroyed by a wipe nobody was told about (D197). A photo is an
 * ORIGINAL the operator still has, so a gallery rebuilt from photos can be
 * rebuilt again — which is the only reason the AuraFace flip is reachable at
 * all (D196).
 *
 * Three things are asserted here because each of them, done the obvious way,
 * is silently wrong:
 *
 *  1. **Analysis ENROLS NOTHING.** The operator names the faces; the server
 *     must not guess. A photo of a family is several people and one of them may
 *     be a stranger.
 *  2. **The stamp is the model that RAN**, read back off the detection, never a
 *     constant and never the model the caller asked for. A vector that lies
 *     about its feature space defeats the only guard `face-matcher` has (D196),
 *     and the whole point of the cluster row is that the answer changes.
 *  3. **A face the runner refused is not enrollable**, and says why. The runner
 *     refuses by producing no embedding — the landmark floor, the size floor
 *     and the cluster model refusal all look identical from here — so a face
 *     without one must never reach `addSample` with a fabricated vector.
 */
import { describe, expect, it } from 'vitest'
import {
  analyzePhotoFaces,
  enrollPhotoFace,
  PHOTO_ENROLL_DEVICE_ID,
  type PhotoAnalysisDeps,
  PhotoAnalysisSessions,
  type PhotoDetection,
  type PhotoEnrollDeps,
  type PhotoEnrollSampleInput,
} from '../photo-enrollment.js'
import { GALLERY_MEDIA_LOCATION, locationForOwnerKind } from '../store/media-store.js'

const silent = {
  info: () => undefined,
  warn: () => undefined,
}

const PHOTO = Buffer.from('a-photograph')

function faceDetection(over: Partial<PhotoDetection> = {}): PhotoDetection {
  return {
    macroClass: 'face',
    score: 0.95,
    bbox: { x: 100, y: 100, width: 300, height: 300 },
    embedding: [1, 0, 0],
    embeddingModelId: 'arcface-r100',
    embeddingMagnitude: 4.4,
    faceAlignedCrop: Buffer.from('aligned').toString('base64'),
    ...over,
  }
}

interface AnalysisHarness {
  readonly deps: PhotoAnalysisDeps
  readonly runs: Buffer[]
}

function analysisHarness(
  detections: readonly PhotoDetection[],
  over: Partial<PhotoAnalysisDeps> = {},
): AnalysisHarness {
  const runs: Buffer[] = []
  return {
    runs,
    deps: {
      runFacePipeline: async (photoJpeg) => {
        runs.push(photoJpeg)
        return { detections }
      },
      maxEmbeddingMagnitude: 0,
      logger: silent,
      ...over,
    },
  }
}

interface EnrollHarness {
  readonly deps: PhotoEnrollDeps
  readonly media: Array<{
    mediaId: number
    kind: string
    identityId: string
    bytes: Buffer
  }>
  readonly samples: Array<{
    identityId: string
    modelId: string
    source: string
    mediaId?: number
    sourceMediaId?: number
    embedding: readonly number[]
  }>
  readonly deleted: number[]
  refreshed: number
}

function enrollHarness(over: Partial<PhotoEnrollDeps> = {}): EnrollHarness {
  const media: EnrollHarness['media'] = []
  const samples: EnrollHarness['samples'] = []
  const deleted: number[] = []
  const h: EnrollHarness = {
    media,
    samples,
    deleted,
    refreshed: 0,
    deps: {
      loadGallery: async () => [],
      putIdentityMedia: async (input) => {
        const mediaId = media.length + 1
        media.push({
          mediaId,
          kind: input.kind,
          identityId: input.identityId,
          bytes: input.data,
        })
        return mediaId
      },
      deleteMedia: async (mediaId) => {
        deleted.push(mediaId)
      },
      addSample: async (input) => {
        samples.push({
          identityId: input.identityId,
          modelId: input.modelId,
          source: input.source,
          embedding: input.embedding,
          ...(input.mediaId !== undefined ? { mediaId: input.mediaId } : {}),
          ...(input.sourceMediaId !== undefined ? { sourceMediaId: input.sourceMediaId } : {}),
        })
        return { id: `sample-${samples.length}` }
      },
      refreshGallery: () => {
        h.refreshed += 1
      },
      logger: silent,
      ...over,
    },
  }
  return h
}

// ── Analysis ────────────────────────────────────────────────────────────────

describe('analyzePhotoFaces', () => {
  it('returns EVERY face the photo contains and enrols none of them', async () => {
    const { deps, runs } = analysisHarness([
      faceDetection({ bbox: { x: 10, y: 10, width: 200, height: 200 } }),
      faceDetection({ bbox: { x: 400, y: 20, width: 180, height: 180 } }),
    ])

    const analysis = await analyzePhotoFaces(deps, { photoJpeg: PHOTO })

    // The photo went to the pipeline verbatim — no pre-cropping on this side.
    expect(runs).toEqual([PHOTO])
    expect(analysis.faces).toHaveLength(2)
    expect(analysis.faces.map((f) => f.faceIndex)).toEqual([0, 1])
    expect(analysis.faces.every((f) => f.enrollable)).toBe(true)
    // The crop shown is the EXACT model input, so what the operator picks is
    // 1:1 with the vector that gets stored.
    expect(analysis.faces[0]?.alignedCropBase64).toBe(Buffer.from('aligned').toString('base64'))
    // Nothing about identities is decided here.
    expect('identityId' in (analysis.faces[0] ?? {})).toBe(false)
  })

  it('ignores non-face detections', async () => {
    const { deps } = analysisHarness([
      {
        macroClass: 'person',
        score: 0.9,
        bbox: { x: 0, y: 0, width: 500, height: 900 },
      },
      faceDetection(),
    ])
    const analysis = await analyzePhotoFaces(deps, { photoJpeg: PHOTO })
    expect(analysis.faces).toHaveLength(1)
  })

  it('marks a face the runner produced NO embedding for as not enrollable', async () => {
    // This is what the landmark-precision floor, the min-face floor and a
    // cluster model refusal all look like from here: a face detail with no
    // vector. There is nothing to enrol and nothing to invent.
    const { deps } = analysisHarness([
      faceDetection({
        embedding: undefined,
        embeddingModelId: undefined,
        embeddingMagnitude: undefined,
        faceAlignedCrop: undefined,
      }),
    ])
    const analysis = await analyzePhotoFaces(deps, { photoJpeg: PHOTO })
    expect(analysis.faces).toHaveLength(1)
    expect(analysis.faces[0]?.enrollable).toBe(false)
    expect(analysis.faces[0]?.refusedReason).toBe('no-embedding')
  })

  it('refuses an embedding that does not NAME its model (D196)', async () => {
    const { deps } = analysisHarness([faceDetection({ embeddingModelId: undefined })])
    const analysis = await analyzePhotoFaces(deps, { photoJpeg: PHOTO })
    expect(analysis.faces[0]?.enrollable).toBe(false)
    expect(analysis.faces[0]?.refusedReason).toBe('no-model-id')
  })

  it('refuses an embedding whose aligned template did not come back', async () => {
    // Without the template there is no sample media, and a sample with no
    // pixels is exactly the row this whole feature exists to stop creating.
    const { deps } = analysisHarness([faceDetection({ faceAlignedCrop: undefined })])
    const analysis = await analyzePhotoFaces(deps, { photoJpeg: PHOTO })
    expect(analysis.faces[0]?.enrollable).toBe(false)
    expect(analysis.faces[0]?.refusedReason).toBe('no-aligned-crop')
  })

  it('applies the magnitude gate with the OPERATOR bound, and is off at 0', async () => {
    const degenerate = faceDetection({ embeddingMagnitude: 12 })

    const off = await analyzePhotoFaces(analysisHarness([degenerate]).deps, {
      photoJpeg: PHOTO,
    })
    expect(off.faces[0]?.enrollable).toBe(true)

    const on = await analyzePhotoFaces(
      analysisHarness([degenerate], { maxEmbeddingMagnitude: 6 }).deps,
      { photoJpeg: PHOTO },
    )
    expect(on.faces[0]?.enrollable).toBe(false)
    expect(on.faces[0]?.refusedReason).toBe('magnitude')
  })

  it('reports a photo with no faces as an empty list, not an error', async () => {
    const analysis = await analyzePhotoFaces(analysisHarness([]).deps, {
      photoJpeg: PHOTO,
    })
    expect(analysis.faces).toEqual([])
  })
})

// ── Sessions ────────────────────────────────────────────────────────────────

describe('PhotoAnalysisSessions', () => {
  it('hands the photo and the face back by id, then forgets it after the TTL', () => {
    let now = 1_000
    const sessions = new PhotoAnalysisSessions({
      ttlMs: 500,
      maxSessions: 4,
      now: () => now,
    })
    const id = sessions.put({
      photoJpeg: PHOTO,
      faces: [
        {
          faceIndex: 0,
          bbox: { x: 1, y: 2, width: 3, height: 4 },
          score: 0.9,
          enrollable: true,
          alignedCropBase64: 'AA==',
          modelId: 'arcface-r100',
          embedding: [1, 0, 0],
          quality: { detectionShortSidePx: 3, score: 0.9, magnitude: 4.4 },
        },
      ],
    })
    expect(sessions.get(id)?.photoJpeg).toBe(PHOTO)
    now += 501
    expect(sessions.get(id)).toBeNull()
  })

  it('evicts the OLDEST session rather than growing without bound', () => {
    let now = 0
    const sessions = new PhotoAnalysisSessions({
      ttlMs: 10_000,
      maxSessions: 2,
      now: () => now,
    })
    const a = sessions.put({ photoJpeg: PHOTO, faces: [] })
    now += 1
    const b = sessions.put({ photoJpeg: PHOTO, faces: [] })
    now += 1
    const c = sessions.put({ photoJpeg: PHOTO, faces: [] })
    expect(sessions.get(a)).toBeNull()
    expect(sessions.get(b)).not.toBeNull()
    expect(sessions.get(c)).not.toBeNull()
  })

  it('holds a whole multi-upload batch concurrently under the DEFAULT bound', () => {
    // The dialog analyses up to MAX_PHOTOS_PER_BATCH photographs in one review
    // (12 — mirrored client-side in `addon-admin-ui/src/lib/photo-enroll.ts`).
    // Every one of them is a live session until the operator confirms, so a
    // default bound below the batch size silently evicts the FIRST photos of
    // the batch — their enrol then fails "expired" while their crops are still
    // on screen.
    const sessions = new PhotoAnalysisSessions()
    const ids: string[] = []
    for (let i = 0; i < 12; i += 1) {
      ids.push(sessions.put({ photoJpeg: PHOTO, faces: [] }))
    }
    for (const id of ids) {
      expect(sessions.get(id)).not.toBeNull()
    }
  })
})

// ── Enrollment ──────────────────────────────────────────────────────────────

describe('enrollPhotoFace', () => {
  const face = {
    faceIndex: 0,
    bbox: { x: 1, y: 2, width: 3, height: 4 },
    score: 0.95,
    enrollable: true as const,
    alignedCropBase64: Buffer.from('aligned').toString('base64'),
    modelId: 'auraface-v1',
    embedding: [1, 0, 0],
    quality: { detectionShortSidePx: 300, score: 0.95, magnitude: 4.4 },
  }

  it('stores the aligned crop AND the original photo, both owned by the identity', async () => {
    const h = enrollHarness()
    const result = await enrollPhotoFace(h.deps, {
      identityId: 'i1',
      photoJpeg: PHOTO,
      face,
    })

    expect(result.sampleId).toBe('sample-1')
    // ownerKind `identity` is what routes the bytes to `galleryMedia` (D197) —
    // the ONE location a footage wipe cannot reach. Both blobs go there.
    expect(h.media.map((m) => m.kind)).toEqual(['faceCrop', 'fullFrame'])
    expect(h.media.every((m) => m.identityId === 'i1')).toBe(true)
    // The ORIGINAL is stored verbatim. It is the reloadable master: it is why a
    // photo-built gallery survives a model change that a crop-built one cannot.
    expect(h.media[1]?.bytes).toBe(PHOTO)
    expect(h.media[0]?.bytes.toString()).toBe('aligned')
  })

  it('points the sample at the aligned template and NAMES the original beside it', async () => {
    const h = enrollHarness()
    await enrollPhotoFace(h.deps, { identityId: 'i1', photoJpeg: PHOTO, face })

    const sample = h.samples[0]
    // `mediaId` MUST stay the aligned 112x112 template: the re-embed pass
    // sends exactly that as a whole frame, and a source photo there would be
    // re-detected and re-warped into a plausible, useless vector (D199).
    expect(sample?.mediaId).toBe(h.media[0]?.mediaId)
    expect(sample?.sourceMediaId).toBe(h.media[1]?.mediaId)
    expect(sample?.source).toBe('photo')
  })

  it('stamps a photo enrolled today as scrfd-v2 and keeps the face box it was cut from (D643)', async () => {
    const seen: PhotoEnrollSampleInput[] = []
    const h = enrollHarness({
      addSample: async (input) => {
        seen.push(input)
        return { id: 'sample-x' }
      },
    })
    await enrollPhotoFace(h.deps, { identityId: 'i1', photoJpeg: PHOTO, face })
    expect(seen[0]?.alignment).toBe('scrfd-v2')
    expect(seen[0]?.sourceBbox).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('stamps the model that actually RAN, not one chosen here', async () => {
    const h = enrollHarness()
    await enrollPhotoFace(h.deps, { identityId: 'i1', photoJpeg: PHOTO, face })
    expect(h.samples[0]?.modelId).toBe('auraface-v1')
  })

  it('refuses an embedding promiscuous with ANOTHER identity, before any media is written', async () => {
    const h = enrollHarness({
      loadGallery: async () => [
        {
          identityId: 'someone-else',
          modelId: 'auraface-v1',
          embedding: [1, 0, 0],
        },
      ],
    })
    await expect(
      enrollPhotoFace(h.deps, { identityId: 'i1', photoJpeg: PHOTO, face }),
    ).rejects.toThrow(/ambiguous/i)
    // The cheap question first: nothing was written, so nothing has to be undone.
    expect(h.media).toEqual([])
    expect(h.samples).toEqual([])
  })

  it('refuses a face that analysis marked NOT enrollable', async () => {
    const h = enrollHarness()
    await expect(
      enrollPhotoFace(h.deps, {
        identityId: 'i1',
        photoJpeg: PHOTO,
        face: {
          ...face,
          enrollable: false,
          refusedReason: 'no-embedding',
          embedding: undefined,
          modelId: undefined,
          alignedCropBase64: undefined,
        },
      }),
    ).rejects.toThrow(/no-embedding/)
    expect(h.samples).toEqual([])
  })

  it('rolls the media back when the sample row does not land', async () => {
    const h = enrollHarness({
      addSample: async () => {
        throw new Error('store is down')
      },
    })
    await expect(
      enrollPhotoFace(h.deps, { identityId: 'i1', photoJpeg: PHOTO, face }),
    ).rejects.toThrow(/store is down/)
    // Both blobs are reclaimed — an orphan under `identity` is exempt from
    // every sweep this repo has, so it would live forever.
    expect(h.deleted).toHaveLength(2)
    expect(h.refreshed).toBe(0)
  })

  it('refreshes the recognizer gallery only after the row landed', async () => {
    const h = enrollHarness()
    await enrollPhotoFace(h.deps, { identityId: 'i1', photoJpeg: PHOTO, face })
    expect(h.refreshed).toBe(1)
  })
})

describe('where a photo-enrolled blob LANDS', () => {
  it('owning it as `identity` is what puts it on the addon gallery dir — asserted against the real derivation', () => {
    // The wiring hands `ownerKind: 'identity'` to `MediaStore.put` and the doc
    // above claims that reaches the gallery location (addon data dir). Pinned
    // to the real function rather than restated: if the exemption list ever
    // stops implying the location, this claim would otherwise stay true only
    // in prose — and the last time an exemption existed only in prose, 28
    // samples lost their pixels to a footage wipe (D197).
    expect(locationForOwnerKind('identity')).toBe(GALLERY_MEDIA_LOCATION)
    expect(locationForOwnerKind('face')).not.toBe(GALLERY_MEDIA_LOCATION)
  })
})

describe('PHOTO_ENROLL_DEVICE_ID', () => {
  it('is not a camera id', () => {
    // A photo has no camera. 0 is the absence of one, and it must never be
    // logged as `tags: { deviceId }` — that key answers "why is 102 worse than
    // 101?" and a photo cannot answer it.
    expect(PHOTO_ENROLL_DEVICE_ID).toBe(0)
  })
})
