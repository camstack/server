/**
 * Shared fixtures for `FaceRecognizer` adopt specs (D683 Task 17): a
 * recognizer wired exactly like `face-recognizer.spec.ts`'s `deps()`, plus a
 * `feedFaces` helper that drives a track to a confirmed identity through
 * `confirmFrames` matching frames.
 *
 * Embeddings are synthetic: each identity gets its own one-hot axis (assigned
 * on first use) and a shared trailing "noise" axis. A probe at
 * `[…, score at the identity's axis, …, sqrt(1-score²) at the noise axis]`
 * cosines to EXACTLY `score` against that identity's gallery sample
 * (`[…, 1 at the identity's axis, 0 elsewhere]`) and to 0 against every other
 * identity — so `score` doubles as both the match cosine and (via `tracked`'s
 * `confidence`) the best-FACE ranking input, which is what lets the "better
 * face is the one held" test use it as a single knob.
 */
import {
  type FaceProcessInput,
  FaceRecognizer,
  type FaceRecognizerSourceFrames,
  type FaceStoreInsertInput,
} from '../face-recognizer.js'
import { FACE_DEFAULTS } from '../face-settings.js'
import type { GallerySample } from '../pipeline/face-matcher.js'
import type { LabelCandidate } from '../pipeline/label-tier.js'
import { makeTrackedDetectionOut } from './support/tracked-detection-out.js'
import { makeLogRecorder } from './test-helpers.js'

const ENABLED = {
  ...FACE_DEFAULTS,
  enabled: true,
  confirmFrames: 2,
  minFacePx: 0,
  recognitionMinFacePx: 0,
  minIdentitySamples: 1,
}

const EMBEDDING_DIMS = 8
const NOISE_DIM = EMBEDDING_DIMS - 1

export interface FaceRecognizerTestHarness {
  readonly recognizer: FaceRecognizer
  readonly identityOf: (trackId: string) => string | null
  readonly heldFaceScore: (trackId: string) => number | undefined
  readonly warnings: () => readonly string[]
  /** Every WARN with its extras (tags / meta). */
  readonly warnEntries: () => readonly { message: string; extras?: unknown }[]
  /** Every INFO message, in order. */
  readonly infos: () => readonly string[]
  /** Every face row `onTrackEnd` wrote. */
  readonly inserted: readonly FaceStoreInsertInput[]
}

/** Optional collaborators a spec may hand the recognizer. */
export interface FaceRecognizerTestOptions {
  readonly faceSourceFrames?: FaceRecognizerSourceFrames
}

/** The growable gallery each built recognizer reads from — `feedFaces` only
 *  ever receives the bare `FaceRecognizer`, so this is how it finds (and
 *  enrolls into) the gallery backing it, without reaching into the
 *  recognizer's own private state. */
const galleryByRecognizer = new WeakMap<FaceRecognizer, GallerySample[]>()

/** Build a `FaceRecognizer` over a GROWABLE in-memory gallery (fed by
 *  {@link feedFaces}) and a recorded logger. */
export async function buildFaceRecognizerForTest(
  options: FaceRecognizerTestOptions = {},
): Promise<FaceRecognizerTestHarness> {
  const gallery: GallerySample[] = []
  const rec = makeLogRecorder()
  const inserted: FaceStoreInsertInput[] = []
  const recognizer = new FaceRecognizer({
    ...(options.faceSourceFrames !== undefined
      ? { faceSourceFrames: options.faceSourceFrames }
      : {}),
    identityStore: {
      loadGallery: async () => gallery,
      listIdentities: async () => [],
    },
    faceStore: {
      insert: async (face) => {
        inserted.push(face)
      },
    },
    mediaStore: { put: async () => 1 },
    trackStore: {
      applyLabelCandidate: async (_trackId: string, candidate: LabelCandidate) => ({
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
    },
    eventStore: { projectTrackLabel: async () => 0 },
    captureCrop: async () => Buffer.from('jpg'),
    logger: rec.logger,
  })
  galleryByRecognizer.set(recognizer, gallery)
  return {
    recognizer,
    identityOf: (trackId) => recognizer.assignedIdentityId(trackId) ?? null,
    heldFaceScore: (trackId) => recognizer.heldBestFaceScore(trackId),
    warnings: () => rec.entries.filter((e) => e.level === 'warn').map((e) => e.message),
    warnEntries: () =>
      rec.entries
        .filter((e) => e.level === 'warn')
        .map((e) => ({
          message: e.message,
          ...(e.extras !== undefined ? { extras: e.extras } : {}),
        })),
    infos: () => rec.entries.filter((e) => e.level === 'info').map((e) => e.message),
    inserted,
  }
}

const identitySlots = new Map<string, number>()
function slotFor(identity: string): number {
  let slot = identitySlots.get(identity)
  if (slot === undefined) {
    slot = identitySlots.size
    identitySlots.set(identity, slot)
  }
  if (slot >= NOISE_DIM) {
    throw new Error(`face-recognizer-test-helpers: out of embedding slots for ${identity}`)
  }
  return slot
}

function gallerySample(identity: string): GallerySample {
  const embedding = Array.from<number>({ length: EMBEDDING_DIMS }).fill(0)
  embedding[slotFor(identity)] = 1
  return { identityId: identity, embedding, modelId: 'arcface-r100' }
}

function probeEmbedding(identity: string, score: number): number[] {
  const embedding = Array.from<number>({ length: EMBEDDING_DIMS }).fill(0)
  embedding[slotFor(identity)] = score
  embedding[NOISE_DIM] = Math.sqrt(Math.max(0, 1 - score * score))
  return embedding
}

/** Feed `frames` matching candidates for `trackId` against `identity`, at
 *  `score` (both the match cosine and the detection confidence). Enrolls
 *  `identity` into the recognizer's gallery on first use. */
export async function feedFaces(
  recognizer: FaceRecognizer,
  input: {
    readonly trackId: string
    readonly identity: string
    readonly frames: number
    readonly score: number
    /** Enroll `identity` into the gallery (default true). False = a stranger. */
    readonly enroll?: boolean
    /** A face detail fired on the frame (default true). False = an
     *  embedding inherited onto the body on a face-less frame. */
    readonly faceBbox?: boolean
    /** First frame instant (default 1000). */
    readonly startAt?: number
  },
): Promise<void> {
  const gallery = galleryByRecognizer.get(recognizer)
  if (gallery === undefined) {
    throw new Error('feedFaces: recognizer was not built via buildFaceRecognizerForTest')
  }
  if (input.enroll !== false && !gallery.some((s) => s.identityId === input.identity)) {
    gallery.push(gallerySample(input.identity))
  }
  await recognizer.refreshGallery()
  for (let i = 0; i < input.frames; i++) {
    await recognizer.processFrame(
      faceFrameInput({ ...input, timestamp: (input.startAt ?? 1000) + i }),
    )
  }
}

/**
 * One face frame for `trackId`, built synchronously (no gallery work) by
 * default — `faceAlignedCrop` makes the held crop available with no await at
 * all, so a plain call resolves in one microtask.
 *
 * `viaCaptureCrop: true` instead omits `faceAlignedCrop` and adds a frame
 * handle, so the recognizer takes the OTHER capture path
 * (`this.deps.captureCrop`, a real await on the mocked dep) — the suspension
 * point a spec uses to start `processFrame` and act while it is still in
 * flight (D683 Task 21: the old tracker's resurrection-scene timing trick
 * this used is gone with it).
 */
export function faceFrameInput(input: {
  readonly trackId: string
  readonly identity: string
  readonly score: number
  readonly timestamp: number
  readonly faceBbox?: boolean
  readonly viaCaptureCrop?: boolean
}): FaceProcessInput {
  return {
    deviceId: 1,
    timestamp: input.timestamp,
    frameWidth: 640,
    frameHeight: 480,
    ...(input.viaCaptureCrop === true
      ? {
          frameHandle: {
            shmId: 'shm-test',
            slot: 0,
            seq: 1,
            width: 640,
            height: 480,
            format: 'rgb',
            pts: input.timestamp,
            byteLength: 640 * 480 * 3,
            nodeId: 'hub',
            slotCount: 4,
          },
        }
      : {}),
    tracked: [
      makeTrackedDetectionOut({
        trackId: input.trackId,
        confidence: input.score,
        ...(input.faceBbox !== false ? { faceBbox: { x: 2, y: 2, w: 6, h: 6 } } : {}),
        embedding: probeEmbedding(input.identity, input.score),
        embeddingModelId: 'arcface-r100',
        ...(input.viaCaptureCrop === true
          ? {}
          : { faceAlignedCrop: Buffer.from(`aligned-${input.trackId}`).toString('base64') }),
      }),
    ],
    settings: ENABLED,
    cropPadding: 0,
  }
}
