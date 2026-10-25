/**
 * Enrol an identity from an uploaded PHOTOGRAPH.
 *
 * ## Why this had to be the way in, and not a convenience
 *
 * Until now a gallery sample could only come from a face the cameras happened
 * to catch, and its pixels were the 112×112 template the embedder was fed. Two
 * measured facts turned that into a dead end:
 *
 *  - those pixels lived on the FOOTAGE volume, which was wiped on 2026-08-17;
 *    28 of 32 samples lost their bytes while their rows and cover keys survived
 *    intact, so the gallery kept claiming images it no longer had (D197);
 *  - without the pixels a sample can never be re-embedded, and re-embedding is
 *    the whole prerequisite of a model change (D196, D199).
 *
 * A photograph is an ORIGINAL the operator still holds. A gallery built from
 * photographs can be rebuilt from the same photographs, on any model, forever.
 * That is the reason this path exists — not because uploading is nicer.
 *
 * ## The detect+align path is the REAL one, deliberately
 *
 * Nothing here cuts a rectangle. The photo goes to
 * `pipelineExecutor.runPipeline` on the `'full'` plane as a `face-detection`
 * ROOT with a nested `face-embedding` child — the same executor code the live
 * detail plane runs, which regresses SCRFD's five landmarks, warps onto the
 * canonical template and ships that exact template back as `faceAlignedCrop`
 * (`executor.ts`, and `executor-root-details.spec.ts` pins the nesting). So:
 *
 *  - the alignment stays a SINGLE implementation (D52: one crop derivation);
 *  - the model is resolved by the CLUSTER row, because `face-embedding`
 *    declares `modelScope: 'cluster'` and `resolveInputSteps` overwrites any
 *    incoming id with it (D199). This module therefore names no model — it
 *    READS BACK the one that ran and stamps that;
 *  - every gate the live path applies applies here too, unchanged. The
 *    24 px landmark-precision floor is measured in the space the detector ran
 *    in, which for a photograph is the photograph — so it is cleared by
 *    construction rather than by an exemption. There is no photo-only floor,
 *    and there must not be one: a second knob that disagrees with the first is
 *    worse than no knob.
 *
 * ## What analysis may NOT do
 *
 * It may not enrol. A family photograph is several people and one of them may
 * be a stranger; the operator names the faces. Analysis therefore returns the
 * faces and holds their vectors SERVER-SIDE in a bounded, expiring session —
 * an embedding never crosses the wire, and confirmation enrols the exact vector
 * whose crop the operator looked at rather than re-running inference on the
 * same pixels and hoping it lands the same way.
 */
import { randomUUID } from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'
import { FACE_ALIGNMENT_SCRFD_V2, type FaceAlignmentVersion } from './face-alignment-version.js'
import { embeddingMagnitudeVerdict } from './pipeline/embedding-magnitude-gate.js'
import { enrollmentPromiscuity, type GallerySample } from './pipeline/face-matcher.js'

/**
 * The `deviceId` a photo-enrolled blob is filed under.
 *
 * A photograph has no camera, and `MediaStore.put` requires a number for the
 * blob path. `0` is the ABSENCE of a camera, not a camera — so it appears in a
 * media path and never in `tags: { deviceId }`, which is the key that answers
 * "why is 102 worse than 101?" and which a photo cannot answer.
 */
export const PHOTO_ENROLL_DEVICE_ID = 0

/** The step tree analysis runs: a face detector ROOT with the embedder nested. */
export const PHOTO_FACE_DETECTION_STEP_ID = 'face-detection'
export const PHOTO_FACE_EMBEDDING_STEP_ID = 'face-embedding'

/** Pixel-space rectangle, exactly as `ObjectDetection.bbox` reports it. */
export interface PhotoBbox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The slice of a pipeline detection this module reads.
 *
 * Narrowed by hand rather than importing `ObjectDetection` so the pure module
 * has no dependency on the cap surface — a real `ObjectDetection` satisfies it
 * structurally, so the wiring site passes one with no cast.
 */
export interface PhotoDetection {
  readonly macroClass: string
  readonly score: number
  readonly bbox: PhotoBbox
  readonly embedding?: readonly number[]
  readonly embeddingModelId?: string
  readonly embeddingMagnitude?: number
  readonly faceAlignedCrop?: string
}

export interface PhotoPipelineResult {
  readonly detections: readonly PhotoDetection[]
}

/** Why a detected face cannot become a sample. Four causes, four names. */
export type PhotoFaceRefusal =
  /** The runner produced no vector: the landmark floor, the size floor, or a
   *  cluster-model refusal — indistinguishable from here, and all of them mean
   *  there is nothing to enrol. */
  | 'no-embedding'
  /** A vector that does not name its model. D196: a sample that lies about its
   *  feature space defeats the only guard `face-matcher` has. */
  | 'no-model-id'
  /** No aligned template came back, so the sample would have no pixels — the
   *  exact row this feature exists to stop creating. */
  | 'no-aligned-crop'
  /** The raw feature magnitude broke the operator's bound. */
  | 'magnitude'

/** What the operator is shown per face, plus what the log line needs. */
export interface PhotoFaceQuality {
  /** Face short side in the space the DETECTOR ran in — the photo itself. */
  readonly detectionShortSidePx: number
  readonly score: number
  readonly magnitude?: number
}

/**
 * One face found in the photo.
 *
 * The embedding is present on the SERVER-side session shape only; the
 * operator-facing projection drops it (`toWireFace`). Vectors do not leave the
 * server here for the same reason `listRecentFaces` never exposes one.
 */
export interface PhotoFace {
  readonly faceIndex: number
  readonly bbox: PhotoBbox
  readonly score: number
  readonly enrollable: boolean
  readonly refusedReason?: PhotoFaceRefusal
  /** The EXACT model input, base64 JPEG. Present iff enrollable. */
  readonly alignedCropBase64?: string
  /** The model that RAN. Present iff enrollable. */
  readonly modelId?: string
  readonly embedding?: readonly number[]
  readonly quality: PhotoFaceQuality
}

/** The same face without its vector — what a client may see. */
export type PhotoFaceWire = Omit<PhotoFace, 'embedding'>

export function toWireFace(face: PhotoFace): PhotoFaceWire {
  const { embedding: _embedding, ...wire } = face
  return wire
}

/**
 * The two levels this module speaks. Narrowed from `IScopedLogger` rather than
 * redeclared, so a test fake is two functions and the shape can never drift
 * from the real one.
 *
 * No `tags: { deviceId }` anywhere in this file, deliberately: that key exists
 * to answer "why is 102 worse than 101?", and a photograph has no camera to
 * put in it.
 */
export type PhotoAnalysisLogger = Pick<IScopedLogger, 'info' | 'warn'>

export interface PhotoAnalysisDeps {
  /** Run the real detect+align+embed tree over the photo. */
  runFacePipeline(photoJpeg: Buffer): Promise<PhotoPipelineResult>
  /**
   * The operator's `maxEmbeddingMagnitude`. `0` disables the gate, which is the
   * shipped default — the bound is deliberately NOT invented here, because a
   * photo-only default would be a second knob disagreeing with the live one.
   */
  readonly maxEmbeddingMagnitude: number
  readonly logger: PhotoAnalysisLogger
}

export interface PhotoAnalysisInput {
  readonly photoJpeg: Buffer
}

export interface PhotoAnalysisResult {
  readonly faces: readonly PhotoFace[]
}

function shortSide(bbox: PhotoBbox): number {
  return Math.min(bbox.width, bbox.height)
}

/**
 * Classify ONE face detail. Pure, and ordered cheapest-first so the reason an
 * operator is shown is the FIRST thing that was wrong, not the last.
 */
function classifyFace(
  detection: PhotoDetection,
  faceIndex: number,
  maxEmbeddingMagnitude: number,
): PhotoFace {
  const quality: PhotoFaceQuality = {
    detectionShortSidePx: Math.round(shortSide(detection.bbox)),
    score: detection.score,
    ...(detection.embeddingMagnitude !== undefined
      ? { magnitude: detection.embeddingMagnitude }
      : {}),
  }
  const base = {
    faceIndex,
    bbox: detection.bbox,
    score: detection.score,
    quality,
  }
  const refuse = (refusedReason: PhotoFaceRefusal): PhotoFace => ({
    ...base,
    enrollable: false,
    refusedReason,
    // The crop is still returned when there IS one: an operator looking at a
    // refused face needs to see WHICH face was refused.
    ...(detection.faceAlignedCrop !== undefined
      ? { alignedCropBase64: detection.faceAlignedCrop }
      : {}),
  })

  const embedding = detection.embedding
  if (embedding === undefined || embedding.length === 0) return refuse('no-embedding')
  if (detection.embeddingModelId === undefined || detection.embeddingModelId === '') {
    return refuse('no-model-id')
  }
  if (detection.faceAlignedCrop === undefined || detection.faceAlignedCrop === '') {
    return refuse('no-aligned-crop')
  }
  if (embeddingMagnitudeVerdict(detection.embeddingMagnitude, maxEmbeddingMagnitude) !== null) {
    return refuse('magnitude')
  }
  return {
    ...base,
    enrollable: true,
    alignedCropBase64: detection.faceAlignedCrop,
    modelId: detection.embeddingModelId,
    embedding,
  }
}

/**
 * Find every face in a photograph, and enrol NONE of them.
 *
 * The photo is sent verbatim: this side cuts no rectangle, so the alignment
 * stays the executor's single implementation (D52).
 */
export async function analyzePhotoFaces(
  deps: PhotoAnalysisDeps,
  input: PhotoAnalysisInput,
): Promise<PhotoAnalysisResult> {
  const result = await deps.runFacePipeline(input.photoJpeg)
  const faces: PhotoFace[] = []
  for (const detection of result.detections) {
    if (detection.macroClass !== 'face') continue
    faces.push(classifyFace(detection, faces.length, deps.maxEmbeddingMagnitude))
  }
  const refused = faces.filter((f) => !f.enrollable)
  // A branch that drops work logs it. A photo whose faces were all refused is
  // otherwise indistinguishable from a photo with no faces in it, and the
  // operator's next move differs completely between the two.
  deps.logger.info('photo enrollment: analysis finished', {
    meta: {
      bytes: input.photoJpeg.length,
      faces: faces.length,
      enrollable: faces.length - refused.length,
      refusals: refused.map((f) => ({
        faceIndex: f.faceIndex,
        reason: f.refusedReason,
        detectionShortSidePx: f.quality.detectionShortSidePx,
      })),
    },
  })
  return { faces }
}

// ── Sessions ────────────────────────────────────────────────────────────────

export interface PhotoAnalysisSession {
  readonly sessionId: string
  readonly createdAt: number
  readonly photoJpeg: Buffer
  readonly faces: readonly PhotoFace[]
}

export interface PhotoAnalysisSessionsOptions {
  readonly ttlMs?: number
  readonly maxSessions?: number
  readonly now?: () => number
}

/** Fifteen minutes: long enough to name a family, short enough that a forgotten
 *  tab does not pin a photograph in hub-main's heap. */
const DEFAULT_PHOTO_SESSION_TTL_MS = 15 * 60 * 1000
/**
 * Bounded because the value held is a whole photograph, not a row.
 *
 * 16, not 8, since the dialog gained multi-upload (2026-08-21): a batch is up
 * to `MAX_PHOTOS_PER_BATCH` (12, mirrored in
 * `addon-admin-ui/src/lib/photo-enroll.ts`) live sessions at once, and a bound
 * below the batch size evicts the batch's FIRST photos while their crops are
 * still on the operator's screen — their enrol then fails "expired" for no
 * visible reason. 16 covers one full batch plus slack for a second tab.
 * Worst-case heap stays bounded: 16 × 18 MB (the per-photo cap) = 288 MB
 * transiently, and the 15-minute TTL reclaims it.
 */
export const DEFAULT_PHOTO_SESSION_MAX = 16

/**
 * The analysed photo, held server-side between analysis and confirmation.
 *
 * It exists so confirmation enrols the EXACT vector whose crop the operator
 * looked at. The alternative — re-running the pipeline on confirm — would
 * re-do inference and could land a different face, which means the picture on
 * screen would stop being 1:1 with the stored sample, and that 1:1 is the only
 * reason the gallery is debuggable at all.
 *
 * Bounded and expiring in both directions: a TTL so a forgotten upload is
 * released, and a cap so N uploads cannot grow hub-main's heap by N photographs.
 */
export class PhotoAnalysisSessions {
  private readonly sessions = new Map<string, PhotoAnalysisSession>()
  private readonly ttlMs: number
  private readonly maxSessions: number
  private readonly now: () => number

  constructor(options: PhotoAnalysisSessionsOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PHOTO_SESSION_TTL_MS
    this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_PHOTO_SESSION_MAX)
    this.now = options.now ?? (() => Date.now())
  }

  put(input: { readonly photoJpeg: Buffer; readonly faces: readonly PhotoFace[] }): string {
    this.sweep()
    const sessionId = randomUUID()
    this.sessions.set(sessionId, {
      sessionId,
      createdAt: this.now(),
      photoJpeg: input.photoJpeg,
      faces: input.faces,
    })
    // Insertion order IS age order (`Map` preserves it and nothing re-inserts),
    // so the oldest is simply the first key.
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      this.sessions.delete(oldest.value)
    }
    return sessionId
  }

  get(sessionId: string): PhotoAnalysisSession | null {
    this.sweep()
    return this.sessions.get(sessionId) ?? null
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  get size(): number {
    return this.sessions.size
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [id, session] of this.sessions) {
      if (session.createdAt <= cutoff) this.sessions.delete(id)
    }
  }
}

// ── Enrollment ──────────────────────────────────────────────────────────────

export interface PhotoEnrollMediaInput {
  readonly identityId: string
  /** `faceCrop` = the aligned template; `fullFrame` = the original photograph. */
  readonly kind: 'faceCrop' | 'fullFrame'
  readonly data: Buffer
}

export interface PhotoEnrollSampleInput {
  readonly identityId: string
  readonly embedding: readonly number[]
  readonly modelId: string
  readonly source: 'photo'
  /** The aligned template — what a re-embed pass will send as a whole frame. */
  readonly mediaId?: number
  /** The ORIGINAL photograph, named beside it. */
  readonly sourceMediaId?: number
  /** The alignment that cut the template (D643). A photo analysed today is v2. */
  readonly alignment?: FaceAlignmentVersion
  /** The face's rectangle in the original — what a later re-enrol matches by IoU. */
  readonly sourceBbox?: PhotoBbox
}

export interface PhotoEnrollDeps {
  loadGallery(): Promise<readonly GallerySample[]>
  putIdentityMedia(input: PhotoEnrollMediaInput): Promise<number>
  deleteMedia(mediaId: number): Promise<void>
  addSample(input: PhotoEnrollSampleInput): Promise<{ readonly id: string }>
  refreshGallery(): void
  readonly logger: PhotoAnalysisLogger
}

export interface PhotoEnrollInput {
  readonly identityId: string
  readonly photoJpeg: Buffer
  readonly face: PhotoFace
}

export interface PhotoEnrollResult {
  readonly sampleId: string
  readonly identityId: string
  readonly modelId: string
  readonly mediaId: number
  readonly sourceMediaId: number
}

/**
 * Turn one named face into a gallery sample.
 *
 * Order is load-bearing:
 *
 *  1. the face must be one analysis ADMITTED — a refused face has no vector and
 *     nothing here may invent one;
 *  2. the promiscuity gate runs BEFORE any byte is written (the cheap question
 *     first): an embedding sitting on top of another identity's sample becomes
 *     a magnet that recognises every degraded probe as its owner, and 22 of 50
 *     live samples were enrolled that way on 2026-08-18;
 *  3. both blobs are written under `ownerKind: 'identity'`, which is what puts
 *     them in the addon data dir — the location a footage wipe cannot reach (D197);
 *  4. the row is written last, and if it does not land BOTH blobs are reclaimed.
 *     An orphan under `identity` is exempt from every sweep this repo has, so
 *     it would otherwise live forever.
 */
export async function enrollPhotoFace(
  deps: PhotoEnrollDeps,
  input: PhotoEnrollInput,
): Promise<PhotoEnrollResult> {
  const { face, identityId } = input
  if (!face.enrollable || face.embedding === undefined || face.modelId === undefined) {
    throw new Error(
      `photo enrollment: face ${face.faceIndex} is not enrollable (${face.refusedReason ?? 'unknown'})`,
    )
  }
  const alignedCropBase64 = face.alignedCropBase64
  if (alignedCropBase64 === undefined) {
    throw new Error(`photo enrollment: face ${face.faceIndex} is not enrollable (no-aligned-crop)`)
  }

  const verdict = enrollmentPromiscuity(
    face.embedding,
    face.modelId,
    identityId,
    await deps.loadGallery(),
  )
  if (verdict !== null) {
    deps.logger.warn('photo enrollment refused: embedding too close to a FOREIGN identity sample', {
      meta: {
        identityId,
        faceIndex: face.faceIndex,
        foreignIdentityId: verdict.identityId,
        cosine: verdict.cosine,
        modelId: face.modelId,
      },
    })
    throw new Error(
      `photo enrollment: embedding is ambiguous — cosine ${verdict.cosine.toFixed(3)} with a sample of another identity (${verdict.identityId}); pick a clearer photo`,
    )
  }

  const written: number[] = []
  const reclaim = async (): Promise<void> => {
    for (const mediaId of written) {
      await deps.deleteMedia(mediaId).catch(() => undefined)
    }
  }

  try {
    const mediaId = await deps.putIdentityMedia({
      identityId,
      kind: 'faceCrop',
      data: Buffer.from(alignedCropBase64, 'base64'),
    })
    written.push(mediaId)
    const sourceMediaId = await deps.putIdentityMedia({
      identityId,
      kind: 'fullFrame',
      data: input.photoJpeg,
    })
    written.push(sourceMediaId)

    const sample = await deps.addSample({
      identityId,
      embedding: face.embedding,
      modelId: face.modelId,
      source: 'photo',
      mediaId,
      sourceMediaId,
      // Analysed just now, by the fixed detector: this template IS v2.
      alignment: FACE_ALIGNMENT_SCRFD_V2,
      sourceBbox: face.bbox,
    })

    deps.refreshGallery()
    deps.logger.info('photo enrollment: sample enrolled', {
      meta: {
        identityId,
        sampleId: sample.id,
        modelId: face.modelId,
        faceIndex: face.faceIndex,
        detectionShortSidePx: face.quality.detectionShortSidePx,
        photoBytes: input.photoJpeg.length,
      },
    })
    return {
      sampleId: sample.id,
      identityId,
      modelId: face.modelId,
      mediaId,
      sourceMediaId,
    }
  } catch (err: unknown) {
    await reclaim()
    deps.logger.warn('photo enrollment: FAILED after writing media — the blobs were reclaimed', {
      meta: {
        identityId,
        faceIndex: face.faceIndex,
        reclaimed: written.length,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    throw err
  }
}
