import type {
  FrameHandle,
  IScopedLogger,
  PipelineAnalyticsFaceGalleryChangedPayload,
} from '@camstack/types'
import type { CopyFaceCropPreviewInput } from './copy-face-crop-preview.js'
import type { LiveHierarchyCapture } from './ensure-track-hierarchy.js'
import {
  deriveSuggestionMinCosine,
  FACE_SOURCE_PARK_MIN_INTERVAL_MS,
  type FaceSettings,
} from './face-settings.js'
import {
  type FaceSourceFrameKeeper,
  type FaceSourcePoint,
  type HeldFaceSource,
  shouldParkSource,
} from './face-source-frame.js'
import { BestDetectionTracker } from './pipeline/best-detection-tracker.js'
import { BEST_FACE_POLICY } from './pipeline/best-selection-policies.js'
import { embeddingMagnitudeVerdict } from './pipeline/embedding-magnitude-gate.js'
import {
  assignUniquePerFrame,
  EMPTY_AGGREGATE,
  type GallerySample,
  matchEmbedding,
  type TrackAggregate,
  updateTrackAggregate,
} from './pipeline/face-matcher.js'
import { faceSizeScore } from './pipeline/face-size-score.js'
import type {
  LabelCandidate,
  TieredLabelDecision,
  TieredLabelPatch,
} from './pipeline/label-tier.js'

import type { TrackedDetectionOut } from './pipeline/frame-processor.js'

/** The recognizer's step id — the attribution a face identity label carries. */
const FACE_RECOGNIZER_STEP_ID = 'face-recognizer'

/** At most one "dropping imageless track" log per this interval, per recognizer. */
const FACE_IMAGELESS_LOG_THROTTLE_MS = 60_000

/** At most one 'embedding magnitude' sample line per device per this interval. */
const FACE_MAGNITUDE_LOG_THROTTLE_MS = 60_000

/** At most one 'probe model has no gallery sample' line per model id per this
 *  interval. Longer than the others: the condition is a standing state, not an
 *  event, and it resolves only by an operator re-enrolling the gallery. */
const FACE_MODEL_MISMATCH_LOG_THROTTLE_MS = 300_000

/**
 * Last-resort model id for a face candidate that names no model AND meets an
 * empty gallery — the collect-only case, where the id is never compared.
 *
 * It used to be reached far more often. `DetailResult` carried no
 * `embeddingModelId`, so recognition fell back to the GALLERY's own id, which
 * made `face-matcher`'s same-model gate compare the gallery against itself.
 * The detail plane carries the id now (`toDetailResult`), the probe names its
 * own model, and the gallery fallback survives only for a runner that predates
 * the field.
 */
const FALLBACK_FACE_MODEL_ID = 'arcface'

/**
 * One face detail produced by `pipelineRunner.runDetailSubtree` for a track,
 * decoded into the shape `processFrame` consumes. Replaces the per-frame face
 * child that used to ride on `TrackedDetectionOut` (two-plane cut): the input
 * source changes, the recognizer's candidate/best-face/gallery/keyFrame logic
 * is unchanged.
 */
export interface FaceDetailInput {
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly frameWidth: number
  readonly frameHeight: number
  /** Face-detection confidence, on the DETECTOR model's scale — ranks the best
   *  face. Not gated here: the runner already applied that model's floor (D662). */
  readonly score: number
  /** Decoded arcface embedding vector (L2-normalized). */
  readonly embedding: readonly number[]
  /** L2 magnitude of the RAW pre-normalization vector — the free face-quality
   *  signal. Absent from an older runner, which the gate treats as "accept". */
  readonly embeddingMagnitude?: number
  /**
   * Model that produced {@link embedding}, as reported by the node that ran it.
   *
   * This is what makes `face-matcher`'s same-model gate REAL. Until it existed
   * the probe's id was taken from `gallery[0]`, i.e. from the very collection
   * it was about to be compared against, so the gate could never fire and two
   * feature spaces could be scored against each other in silence.
   *
   * Absent from a runner that predates the field — see the fallback at the use
   * site, which degrades to the old assumption rather than to a refusal.
   */
  readonly embeddingModelId?: string
  /** Parent (person) bbox in frame-space — the crop fallback anchor. */
  readonly parentBbox: { x: number; y: number; w: number; h: number }
  /** Tight face bbox in frame-space (from the detail result). */
  readonly faceBbox?: { x: number; y: number; w: number; h: number }
  /** Face short side (px) at NATIVE scale, when the runner measured it —
   *  preferred over `faceBbox` (detection-frame px) for the min-face gate. */
  readonly nativeFaceShortSidePx?: number
  /** The byte-identical landmark-aligned crop the embedding was computed from. */
  readonly alignedCropJpeg?: string
  /** The five landmarks in FRAME space, when the runner sent them (D644). */
  readonly landmarks?: readonly FaceSourcePoint[]
  readonly settings: FaceSettings
  readonly cropPadding: number
  readonly frameHandle?: FrameHandle
}

/** Held best face for a track (crop captured lazily in Task 4). */
interface HeldFace {
  score: number
  embedding: readonly number[]
  embeddingModelId: string
  bbox: { x: number; y: number; w: number; h: number }
  timestamp: number
  recognizedIdentityId?: string
  crop?: Buffer
  /** Native-scale face short side (px) of the held best frame, when the runner
   *  measured it — persisted onto the face row for auditability. */
  nativeFaceShortSidePx?: number
  /**
   * The frame this face will be stored with (D644): the LAST PARKED best face
   * of the track — this one, or one at most the park interval older. Absent =
   * no frame kept (the setting is off, or no park happened).
   */
  source?: HeldFaceSource
}

/**
 * A frame on which a face was RESOLVED — it cleared the recognition size floor
 * and produced an embedding — reported for SEMANTIC best-shot promotion.
 * Fired per such frame, deliberately BEFORE the `confirmFrames` aggregate
 * confirms: a single-face-frame track ("faccia attaccata", track 3892b82b…
 * 2026-08-21) never confirms, yet that one frame is exactly the shot to show.
 *
 * D406 (2026-09-08) widened this from "the gallery AUTO-MATCH succeeded" to
 * "a face was resolved". The old rule made the semantic tier unreachable for
 * every STRANGER, and the operator's ask is about the face being VISIBLE, not
 * about knowing whose it is (track `acad3a3e`, device 101: a stored face crop,
 * no identity, and a best shot taken from the torso 4.3 s later). The identity
 * still rides along when there is one — absent means nobody was proved, and it
 * is never faked.
 */
export interface FaceSemanticEvidence {
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly frameWidth: number
  readonly frameHeight: number
  /** PERSON (parent) bbox in frame-space — the box the best-shot ranking scores. */
  readonly bbox: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
  /** Subject detection confidence of the candidate. */
  readonly confidence: number
  /** Winning identity-match cosine — present ONLY on an auto-match. */
  readonly matchScore?: number
  /** The identity this frame proved — present ONLY on an auto-match. */
  readonly identityId?: string
  readonly frameHandle?: FrameHandle
}

/**
 * One identity VERDICT on a live track: the aggregate settled on (or switched
 * to, or restored) `identityId`, or took it back (`null`). What a tracking
 * tape records as an `identity` record (D681).
 */
export interface FaceIdentityVerdict {
  readonly deviceId: number
  readonly trackId: string
  /** The frame the verdict was reached on. */
  readonly timestamp: number
  readonly identityId: string | null
}

/** The identity-gallery store surface this recognizer touches. */
export interface FaceRecognizerIdentityStore {
  loadGallery(): Promise<readonly GallerySample[]>
  listIdentities(): Promise<readonly { id: string; name: string }[]>
}

/** One face row write — the shape `FaceRecognizerDeps.faceStore.insert` takes. */
export interface FaceStoreInsertInput {
  readonly id: string
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly embedding: readonly number[]
  readonly embeddingModelId?: string
  /** Media id (D482) of the buffered crop. */
  readonly mediaId?: number
  readonly recognizedIdentityId?: string
  readonly assigned: boolean
  /** Media id (D482) of the track's native key frame (Design B). */
  readonly keyFrameMediaId?: number
  readonly faceBbox?: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
  /** Winning identity-match cosine for the track's assigned identity (audit). */
  readonly bestMatchScore?: number
  /** Native-scale face short side (px) at recognition time (audit). */
  readonly nativeFaceShortSidePx?: number
  /** SUGGESTED identity — a plausible match that MISSED auto-assignment.
   *  Mutually exclusive with `recognizedIdentityId` (the row stays unassigned). */
  readonly suggestedIdentityId?: string
  /** Peak cosine for `suggestedIdentityId` (present iff it is). */
  readonly suggestedMatchScore?: number
  /** The full frame the face was detected on, and where it is on it (D644). */
  readonly sourceFrameMediaId?: number
  readonly sourceFrameBbox?: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
  readonly sourceFrameLandmarks?: readonly FaceSourcePoint[]
}

/** The source-frame surface this recognizer touches (`FaceSourceFrameKeeper`). */
export type FaceRecognizerSourceFrames = Pick<
  FaceSourceFrameKeeper,
  'park' | 'persist' | 'release' | 'adopt'
>

/** The face-row store surface this recognizer touches. */
export interface FaceRecognizerFaceStore {
  insert(face: FaceStoreInsertInput): Promise<void>
}

/** One face-crop media write — the shape `FaceRecognizerDeps.mediaStore.put` takes. */
export interface FaceCropMediaPutInput {
  readonly deviceId: number
  readonly ownerKind: 'face'
  readonly ownerId: string
  readonly kind: 'crop'
  readonly timestamp: number
  readonly data: Buffer
}

/** The media-store surface this recognizer touches. */
export interface FaceRecognizerMediaStore {
  put(input: FaceCropMediaPutInput): Promise<number>
}

/** The track-store surface this recognizer touches — the tiered write rule's
 *  entry point. */
export interface FaceRecognizerTrackStore {
  applyLabelCandidate(
    trackId: string,
    candidate: LabelCandidate,
  ): Promise<TieredLabelDecision | null>
}

/** The event-store surface this recognizer touches. */
export interface FaceRecognizerEventStore {
  /** Copy the TRACK's accepted patch onto every event of the track — the
   *  events never re-decide (see `EventStore.projectTrackLabel`). */
  projectTrackLabel(trackId: string, patch: TieredLabelPatch): Promise<number>
}

export interface FaceRecognizerDeps {
  readonly identityStore: FaceRecognizerIdentityStore
  readonly faceStore: FaceRecognizerFaceStore
  readonly mediaStore: FaceRecognizerMediaStore
  /** Structural slices of the stores — the tiered write rule's entry points. */
  readonly trackStore: FaceRecognizerTrackStore
  readonly eventStore: FaceRecognizerEventStore
  /** Recompute a persisted track's importance after a late label is applied (so
   *  the identity term bumps the score retroactively). No-op for still-active
   *  tracks. Optional so tests can omit it. */
  readonly recomputeImportance?: (trackId: string) => Promise<void>
  /**
   * Stamp `Track.hasEmbeddedFace` — "this track has a face row IN THE GALLERY:
   * a crop plus an embedding, i.e. a face an operator could ASSIGN".
   *
   * Called from exactly ONE place, {@link onTrackEnd}, and only AFTER
   * `faceStore.insert` resolved. It is deliberately not the same signal as
   * `Track.hasFace`, which the detail route stamps at the top of the face
   * branch before every gate: everything between that stamp and this insert —
   * the magnitude verdict, `minFacePx`, the candidate gate, the imageless-track
   * drop, the crop-store drop — can refuse the face, and a flag written earlier
   * would promise the gallery a row it does not hold.
   *
   * Optional so existing tests can omit it (the established pattern for
   * `recomputeImportance` / `getKeyFrameMediaId` above); absent ⇒ the track
   * simply carries no flag, which reads as "unknown", never as "no face".
   */
  readonly markEmbeddedFace?: (trackId: string) => Promise<void>
  /**
   * After a face crop is persisted, copy it onto the owning track when the
   * track has no thumbnail of its own. Optional so existing tests can omit it.
   * Last resort for tiles — the live hierarchy callback below is what lands
   * a person crop + full frame from the same handle.
   */
  readonly copyCropToTrackPreview?: (input: CopyFaceCropPreviewInput) => Promise<void>
  /**
   * A face crop just landed from a still-live handle. The person crop and
   * full frame must come from that same handle (display-crop surface, not
   * native-strict). Optional so existing tests can omit it.
   */
  readonly onLiveHierarchy?: (input: LiveHierarchyCapture) => void
  /** Design B: resolve the track's shared native key-frame media id (D482),
   *  captured by the object-embedding best path in `index.ts`. Field name kept
   *  for the wiring closure there; the value is `TrackResidentState.
   *  keyFrameMediaId`. Optional so tests can omit it; absent ⇒ the face row
   *  carries no `keyFrameMediaId` and the UI falls back to the inline face
   *  crop. */
  readonly getKeyFrameMediaId?: (trackId: string) => number | undefined
  /** DISPLAY-crop capture for the face gallery tile: native-first with a bounded
   *  full-frame fallback (keyframe-native or ≤640 RAM tier, honest sub-native —
   *  never upscaled), `null` only on a total miss. `ownerId` (the trackId) keys
   *  the once-per-track fallback info log. `deviceId` (S4) keys the injected
   *  CaptureScheduler's per-device lane — the wrapper in `index.ts` routes this
   *  fetch through the scheduler, so a `null` may also mean "dropped stale /
   *  cancelled" (treated exactly like a capture miss: retry on a later frame). */
  readonly captureCrop: (
    frameHandle: FrameHandle,
    bbox: { x: number; y: number; w: number; h: number },
    frameWidth: number,
    frameHeight: number,
    padding: number,
    ownerId: string,
    deviceId: number,
  ) => Promise<Buffer | null>
  /**
   * Best-effort bus notification fired AFTER a new gallery face row is
   * persisted (`kind:'buffered'`). Optional so tests can omit it; a lost
   * emit only delays the admin-ui live-refresh (D8 telemetry semantics),
   * never the mutation itself.
   */
  readonly emitFaceGalleryChanged?: (payload: PipelineAnalyticsFaceGalleryChangedPayload) => void
  /**
   * SEMANTIC best-shot signal (2026-08-21, widened by D406): invoked once per
   * candidate that cleared the RECOGNITION size floor and carries an
   * embedding, so the best-shot ranking can promote the frame that actually
   * SHOWS the face (semantic tier — see `pipeline/semantic-promotion.ts`).
   * Carries the identity when the gallery auto-match succeeded. Optional so
   * tests can omit it; a face below `recognitionMinFacePx` never fires it.
   */
  readonly onSemanticFace?: (evidence: FaceSemanticEvidence) => void
  /**
   * Keep the full source frame of every BUFFERED face (D644): parked on the
   * owning node when a face becomes its track's best, taken and stored only
   * when the face is buffered. Optional so tests can omit it; absent ⇒ face
   * rows carry no source frame.
   */
  readonly faceSourceFrames?: FaceRecognizerSourceFrames
  /**
   * OBSERVES every identity verdict (D681 tracking tape). Called synchronously
   * where the verdict is reached; a throw is caught and logged, so an observer
   * can never change recognition. Optional; absent ⇒ nothing observes.
   */
  readonly onIdentityVerdict?: (verdict: FaceIdentityVerdict) => void
  readonly logger: IScopedLogger
}

export interface FaceProcessInput {
  readonly deviceId: number
  readonly timestamp: number
  readonly frameWidth: number
  readonly frameHeight: number
  readonly tracked: readonly TrackedDetectionOut[]
  readonly settings: FaceSettings
  readonly cropPadding: number
  readonly frameHandle?: FrameHandle
}

/**
 * A held face carrying `identityId` as its stamp — rebuilt, never spread, so a
 * stale `recognizedIdentityId` cannot ride through. `null` strips the stamp
 * (a fusion whose merged identity is unnamed).
 */
function restampHeldFace(held: HeldFace, identityId: string | null): HeldFace {
  return {
    score: held.score,
    embedding: held.embedding,
    embeddingModelId: held.embeddingModelId,
    bbox: held.bbox,
    timestamp: held.timestamp,
    ...(identityId !== null ? { recognizedIdentityId: identityId } : {}),
    ...(held.crop !== undefined ? { crop: held.crop } : {}),
    ...(held.nativeFaceShortSidePx !== undefined
      ? { nativeFaceShortSidePx: held.nativeFaceShortSidePx }
      : {}),
    ...(held.source !== undefined ? { source: held.source } : {}),
  }
}

export class FaceRecognizer {
  private gallery: readonly GallerySample[] = []
  private names = new Map<string, string>()
  private readonly aggregates = new Map<string, TrackAggregate>()
  private readonly bestFace = new Map<string, HeldFace>()
  /** Frame instant of each live track's last source park (D644). */
  private readonly lastSourceParkAt = new Map<string, number>()
  /**
   * D692: the frame instant of the FIRST face detail each live track produced (after
   * the quality gate). The grouped-notification outlook reads it to apply the tracker's
   * own face-settle cap (`FACE_SETTLE_HOLD_MS`) — a member whose face showed and was
   * never named is final once the cap has passed. Min-merged on `adoptTrack`, dropped
   * at `onTrackEnd`.
   */
  private readonly firstFace = new Map<string, number>()
  /** Per-device throttle clock for the magnitude sample line. */
  private readonly lastMagnitudeLogAt = new Map<number, number>()
  /** Keyed by PROBE MODEL ID, not device — see `logModelSpaceMismatch`. */
  private readonly lastModelMismatchLogAt = new Map<string, number>()
  /** Per camera: last "probe names no model, gallery mixed" refusal line (D651). */
  private readonly lastUnnamedProbeLogAt = new Map<number, number>()
  /**
   * Peak identity-MATCH cosine per track for the currently-assigned identity
   * (NOT the detection confidence held in {@link bestFace}). Reset on an
   * identity switch so a track carries the confidence of the label it ends up
   * with. Read synchronously at close (NC `minLabelConfidence`) via
   * {@link bestLabelMatchConfidence}, then dropped in {@link onTrackEnd}.
   */
  private readonly bestMatchScore = new Map<string, number>()
  /**
   * Peak SUGGESTION (identity + cosine) per track: the best plausible-but-not-
   * confident match that MISSED auto-assignment (cosine in the suggestion band
   * with a large-enough face, OR ≥ threshold but below the recognition size
   * floor). Accumulated across frames exactly like {@link bestMatchScore},
   * read at close, then dropped in {@link onTrackEnd}. A track that is ever
   * auto-assigned discards this at close (mutual exclusivity: assigned rows
   * carry `recognizedIdentityId`, suggestion rows carry `suggested*`).
   */
  private readonly bestSuggestion = new Map<string, { identityId: string; score: number }>()
  /** Best-face-per-track ranking via the shared tracker primitive, constructed
   *  WITH the DECLARED face policy (`BEST_FACE_POLICY` in
   *  `best-selection-policies.ts`): confidence-only, no hysteresis, no rate
   *  limit — always keep the true highest-confidence face (holding a buffer in
   *  memory is cheap, and a track may last well under the best-frame
   *  rate-limit window). */
  private readonly bestTracker = new BestDetectionTracker(BEST_FACE_POLICY)
  /** Throttle for the "dropping imageless track" log — one line per minute at
   *  most, so a busy scene that never produces a face crop can't flood logs. */
  private lastImagelessLogAt = 0
  /**
   * D683 (Task 7 review H2): track ids that have ADOPTED an absorbed piece —
   * so a LATER per-frame match that would switch the survivor's already-
   * assigned identity (confirmFrames reached on a second name) is never
   * silent about it. Cleared at {@link persistTrackFace} like every other
   * per-track container.
   */
  private readonly fusedTrackIds = new Set<string>()
  /**
   * D683 review M1: absorbed id → its LIVE survivor (flattened across chained
   * fusions). A frame still carrying the absorbed id — one already in flight
   * when the fusion ran — feeds the survivor instead of re-creating state
   * nothing would ever end. Cleared when the survivor ends.
   */
  private readonly aliases = new Map<string, string>()
  /** Survivor id → every id it absorbed (for the alias cleanup and the
   *  ghost-state purge at the survivor's end). */
  private readonly absorbedBy = new Map<string, readonly string[]>()

  constructor(private readonly deps: FaceRecognizerDeps) {}

  /** (Re)load the in-memory gallery + identity-name map. Call at init and on enroll/delete. */
  async refreshGallery(): Promise<void> {
    try {
      this.gallery = await this.deps.identityStore.loadGallery()
      const ids = await this.deps.identityStore.listIdentities()
      this.names = new Map(ids.map((i) => [i.id, i.name]))
    } catch (err) {
      this.deps.logger.warn('FaceRecognizer.refreshGallery failed', {
        meta: { error: String(err) },
      })
    }
  }

  /**
   * Two-plane detail feed: ingest ONE `runDetailSubtree` face result for a
   * track and run it through the SAME `processFrame` logic (candidate → best
   * face → gallery match → crop hold). The result is synthesized into a single
   * `TrackedDetectionOut` candidate so no recognizer logic changes — only the
   * input source moves from the per-frame plane to this per-track call.
   */
  async ingestFaceDetail(input: FaceDetailInput): Promise<void> {
    // QUALITY GATE, before anything is stored, matched or enrolled. A degenerate
    // crop does not score LOW against the gallery — it scores HIGH against
    // everything — so it cannot be caught downstream by any threshold. The raw
    // feature magnitude is the only signal that separates it, and it is free.
    // Disabled by default (bound 0); see `maxEmbeddingMagnitude`.
    const verdict = embeddingMagnitudeVerdict(
      input.embeddingMagnitude,
      input.settings.maxEmbeddingMagnitude,
    )
    if (verdict !== null) {
      this.deps.logger.info('face: dropping detail — raw embedding magnitude over bound', {
        tags: { deviceId: input.deviceId },
        meta: {
          trackId: input.trackId,
          magnitude: Number(verdict.magnitude.toFixed(3)),
          bound: verdict.bound,
          score: input.score,
          ...(input.nativeFaceShortSidePx !== undefined
            ? { nativeFaceShortSidePx: input.nativeFaceShortSidePx }
            : {}),
        },
      })
      return
    }
    // The magnitude is logged even when the gate is OFF, throttled, because the
    // bound cannot be chosen without the live distribution and this field has
    // never been observable on this cluster before today.
    this.logEmbeddingMagnitude(input)
    // D692: a face was SEEN on this track (past the quality gate) — whether or not a
    // verdict can be reached below. Keyed by the live survivor when an alias exists.
    const faceTrackId = this.aliases.get(input.trackId) ?? input.trackId
    if (!this.firstFace.has(faceTrackId)) this.firstFace.set(faceTrackId, input.timestamp)
    // Recognition compares same-model rows only (face-matcher gate). The probe
    // names its OWN model when the runner reports it; only a runner predating
    // `embeddingModelId` falls back to the gallery's id — the old assumption,
    // kept so version skew degrades to previous behaviour rather than to a
    // blanket refusal. The last fallback is the collect-only / empty-gallery
    // case, where the id is never compared.
    //
    // D651: that guess is safe only while the gallery holds ONE model. Mid
    // model switch it holds two, and `gallery[0]` may name the model that did
    // NOT produce this probe — a cross-space comparison. Refuse instead: a
    // missed face is recoverable, a wrong identity is not.
    if (input.embeddingModelId === undefined) {
      const galleryModelIds = new Set(this.gallery.map((s) => s.modelId))
      if (galleryModelIds.size > 1) {
        this.logUnnamedProbeRefused(input.deviceId, [...galleryModelIds])
        return
      }
    }
    const modelId = input.embeddingModelId ?? this.gallery[0]?.modelId ?? FALLBACK_FACE_MODEL_ID
    // A gallery that speaks a different language than the pipeline reads, from
    // the outside, as "recognition just stopped" — so it has to be audible.
    // Throttled per model id: this fires on EVERY face while a cutover is
    // half-done, and the operator needs the fact once, not the volume.
    if (this.gallery.length > 0 && !this.gallery.some((s) => s.modelId === modelId)) {
      this.logModelSpaceMismatch(input.deviceId, modelId)
    }
    const candidate: TrackedDetectionOut = {
      trackId: input.trackId,
      className: 'face',
      confidence: input.score,
      bbox: input.parentBbox,
      zones: [],
      state: 'moving',
      // A face detail is a real, current-frame detection — always media-eligible.
      matchedThisFrame: true,
      // A detail carries no dwell of its own; it never settles.
      settling: false,
      // It rides a track the tracker already emitted — past its birth gate.
      confirmed: true,
      embedding: input.embedding,
      embeddingModelId: modelId,
      ...(input.faceBbox !== undefined ? { faceBbox: input.faceBbox } : {}),
      ...(input.nativeFaceShortSidePx !== undefined
        ? { nativeFaceShortSidePx: input.nativeFaceShortSidePx }
        : {}),
      ...(input.alignedCropJpeg !== undefined ? { faceAlignedCrop: input.alignedCropJpeg } : {}),
      ...(input.landmarks !== undefined ? { faceLandmarks: input.landmarks } : {}),
    }
    await this.processFrame({
      deviceId: input.deviceId,
      timestamp: input.timestamp,
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      tracked: [candidate],
      settings: input.settings,
      cropPadding: input.cropPadding,
      ...(input.frameHandle !== undefined ? { frameHandle: input.frameHandle } : {}),
    })
  }

  /**
   * At most one magnitude line per device per
   * {@link FACE_MAGNITUDE_LOG_THROTTLE_MS}. This is the ONLY way the operator
   * can see where this cluster's usable and degenerate face populations sit, so
   * it must exist before `maxEmbeddingMagnitude` can honestly be turned on.
   */
  private logEmbeddingMagnitude(input: FaceDetailInput): void {
    const magnitude = input.embeddingMagnitude
    if (magnitude === undefined || !Number.isFinite(magnitude)) return
    const now = Date.now()
    const last = this.lastMagnitudeLogAt.get(input.deviceId) ?? 0
    if (now - last < FACE_MAGNITUDE_LOG_THROTTLE_MS) return
    this.lastMagnitudeLogAt.set(input.deviceId, now)
    this.deps.logger.info('face: embedding magnitude', {
      tags: { deviceId: input.deviceId },
      meta: {
        trackId: input.trackId,
        magnitude: Number(magnitude.toFixed(3)),
        bound: input.settings.maxEmbeddingMagnitude,
        score: input.score,
        detectionFrameShortSidePx:
          input.faceBbox !== undefined
            ? Math.round(Math.min(input.faceBbox.w, input.faceBbox.h))
            : 0,
        ...(input.nativeFaceShortSidePx !== undefined
          ? { nativeFaceShortSidePx: Math.round(input.nativeFaceShortSidePx) }
          : {}),
      },
    })
  }

  /**
   * A probe that names no model met a gallery holding more than one (D651).
   * Throttled per camera: it repeats on every face from an old runner while a
   * switch is half-done, and the operator needs the fact per camera, once.
   */
  private logUnnamedProbeRefused(deviceId: number, galleryModelIds: readonly string[]): void {
    const now = Date.now()
    const last = this.lastUnnamedProbeLogAt.get(deviceId) ?? 0
    if (now - last < FACE_MODEL_MISMATCH_LOG_THROTTLE_MS) return
    this.lastUnnamedProbeLogAt.set(deviceId, now)
    this.deps.logger.warn(
      'face: probe names no model and the gallery holds several — not compared, to never match across models',
      {
        tags: { deviceId },
        meta: { galleryModelIds, gallerySamples: this.gallery.length },
      },
    )
  }

  /**
   * The pipeline is embedding faces with a model the gallery holds no sample
   * for, so nobody can be recognised until the gallery is re-enrolled in that
   * model. Every probe is silently unmatchable — the loudest possible symptom
   * with the quietest possible cause, which is precisely the combination this
   * repo has been bitten by.
   *
   * Throttled per model id rather than per device: the fact is cluster-wide and
   * one line states it, while a per-device line would print it once per camera
   * for the same single cause.
   */
  private logModelSpaceMismatch(deviceId: number, probeModelId: string): void {
    const now = Date.now()
    const last = this.lastModelMismatchLogAt.get(probeModelId) ?? 0
    if (now - last < FACE_MODEL_MISMATCH_LOG_THROTTLE_MS) return
    this.lastModelMismatchLogAt.set(probeModelId, now)
    this.deps.logger.warn(
      'face: probe model has no gallery sample — nobody can be recognised until the gallery is re-enrolled',
      {
        tags: { deviceId },
        meta: {
          probeModelId,
          galleryModelIds: [...new Set(this.gallery.map((s) => s.modelId))],
          gallerySamples: this.gallery.length,
        },
      },
    )
  }

  /** Hand a verdict to the observer, if any. Never lets it throw into us. */
  private observeIdentity(verdict: FaceIdentityVerdict): void {
    const observe = this.deps.onIdentityVerdict
    if (observe === undefined) return
    try {
      observe(verdict)
    } catch (err) {
      this.deps.logger.warn('face: identity verdict observer failed', {
        tags: { deviceId: verdict.deviceId, trackId: verdict.trackId },
        meta: { error: String(err) },
      })
    }
  }

  async processFrame(rawInput: FaceProcessInput): Promise<void> {
    const input = this.routeAbsorbedIds(rawInput)
    // No per-device enable gate: the recognizer always runs and simply no-ops
    // when the frame carries no embedding-bearing candidates (a device whose
    // detection pipeline lacks the face-embedding step produces none). The only
    // master switch is GLOBAL, applied by the caller in `index.ts`.
    const { settings } = input
    const candidates = input.tracked.filter(
      (
        t,
      ): t is TrackedDetectionOut & {
        embedding: readonly number[]
        embeddingModelId: string
      } =>
        Array.isArray(t.embedding) &&
        t.embedding.length > 0 &&
        typeof t.embeddingModelId === 'string' &&
        // No face-CONFIDENCE bar here (D662): the score is on the detector
        // model's own scale and the runner already applied that model's floor.
        // The 0.5 that stood here was SCRFD's, re-applied to YuNet scores.
        // Min-face-size gate (#26.1), NATIVE-AWARE (2026-07-22): prefer the
        // runner's native-scale face size — `faceBbox` is detection-frame px
        // (≈6× smaller on a 4K camera) and gating on it discarded every
        // distant-camera face. Detection-space bbox is the fallback for older
        // runners; a candidate with neither measure (embedding inherited onto
        // the person track on a face-less frame) is left to the downstream
        // crop gate, which already refuses to persist it.
        (t.nativeFaceShortSidePx ??
          (t.faceBbox ? Math.min(t.faceBbox.w, t.faceBbox.h) : undefined) ??
          Number.POSITIVE_INFINITY) >= settings.minFacePx,
    )
    if (candidates.length === 0) return

    this.deps.logger.debug('face: frame candidates', {
      tags: { deviceId: input.deviceId },
      meta: {
        tracked: input.tracked.length,
        candidates: candidates.length,
        gallerySize: this.gallery.length,
      },
    })

    // RECOGNITION floor (separate from the DETECTION floor `minFacePx` applied
    // above): only faces whose NATIVE short side ≥ `recognitionMinFacePx` are
    // eligible for AUTO-MATCH. Smaller faces are still collected/cropped/stored
    // below (available for MANUAL assignment) but are excluded from the matcher,
    // so they never receive an identity — fail-safe (recognizedIdentityId stays
    // UNSET). Uses the SAME native-first size derivation as the detection gate;
    // a candidate with no size measure passes (deferred to the detection gate,
    // which already admitted it) rather than being spuriously suppressed.
    const meetsRecognitionFloor = (
      t: TrackedDetectionOut & {
        embedding: readonly number[]
        embeddingModelId: string
      },
    ): boolean =>
      (t.nativeFaceShortSidePx ??
        (t.faceBbox ? Math.min(t.faceBbox.w, t.faceBbox.h) : undefined) ??
        Number.POSITIVE_INFINITY) >= settings.recognitionMinFacePx
    const matchCandidates = candidates.filter(meetsRecognitionFloor)

    // Match (only when the gallery has entries — empty gallery ⇒ collect-only —
    // AND at least one candidate clears the recognition floor).
    const matches =
      this.gallery.length > 0 && matchCandidates.length > 0
        ? assignUniquePerFrame(
            matchCandidates.map((c) => ({
              trackId: c.trackId,
              embedding: c.embedding,
              modelId: c.embeddingModelId,
            })),
            this.gallery,
            {
              threshold: settings.similarityThreshold,
              margin: settings.margin,
              minIdentitySamples: settings.minIdentitySamples,
            },
          )
        : new Map<string, { identityId: string; score: number }>()

    // SEMANTIC best-shot signal: report every candidate that RESOLVED a face
    // on this frame — it cleared `recognitionMinFacePx` and carries an
    // embedding — so the ranking can promote the frame that actually shows
    // the face. D406: this used to be gated on the gallery auto-match, which
    // left every stranger's face frame outside the semantic tier and let a
    // later, bigger, face-less view win on size (track `acad3a3e`, device
    // 101). The identity rides along only when there is one. Synchronous,
    // before any store I/O — the caller may re-fire captures off the
    // still-live frame handle.
    if (this.deps.onSemanticFace !== undefined) {
      for (const c of matchCandidates) {
        const match = matches.get(c.trackId)
        this.deps.onSemanticFace({
          deviceId: input.deviceId,
          trackId: c.trackId,
          timestamp: input.timestamp,
          frameWidth: input.frameWidth,
          frameHeight: input.frameHeight,
          bbox: c.bbox,
          confidence: c.confidence,
          ...(match !== undefined ? { matchScore: match.score, identityId: match.identityId } : {}),
          ...(input.frameHandle !== undefined ? { frameHandle: input.frameHandle } : {}),
        })
      }
    }

    // SUGGESTION band (2026-07-24): a plausible-but-not-confident match that
    // MISSED auto-assignment still surfaces as a SUGGESTION — persisted at close
    // as `suggestedIdentityId`/`suggestedMatchScore`, NEVER an assignment (the
    // row stays unassigned; galleries/NC keep treating the face as unrecognized).
    // For each candidate, compute its best gallery identity at the RELAXED
    // suggestion bar — `deriveSuggestionMinCosine(similarityThreshold)`, 80% of
    // the assignment threshold and NOT a second knob (D222) — with the SAME
    // margin + min-identity-samples eligibility as auto-match, then classify
    // into the band:
    //   • cosine in [suggestion floor, similarityThreshold) AND face ≥ the
    //     recognition size floor — a near-miss on confidence; OR
    //   • cosine ≥ similarityThreshold BUT face < the recognition size floor —
    //     blocked ONLY by the size floor.
    // The per-track PEAK suggestion is kept (mirrors `bestMatchScore`); mutual
    // exclusivity with an auto-assignment is resolved at close (an assigned track
    // discards its suggestion). Unmeasurable faces are treated as clearing the
    // recognition floor (same convention as the matcher), so only the near-miss
    // band can apply to them.
    if (this.gallery.length > 0) {
      for (const c of candidates) {
        const suggestion = matchEmbedding(
          { embedding: c.embedding, modelId: c.embeddingModelId },
          this.gallery,
          {
            threshold: deriveSuggestionMinCosine(settings.similarityThreshold),
            margin: settings.margin,
            minIdentitySamples: settings.minIdentitySamples,
          },
        )
        if (suggestion === null) continue
        const size =
          c.nativeFaceShortSidePx ?? (c.faceBbox ? Math.min(c.faceBbox.w, c.faceBbox.h) : undefined)
        const meetsRecognitionFloor =
          (size ?? Number.POSITIVE_INFINITY) >= settings.recognitionMinFacePx
        const inNearMissBand =
          meetsRecognitionFloor && suggestion.score < settings.similarityThreshold
        const inSizeBlockedBand =
          !meetsRecognitionFloor && suggestion.score >= settings.similarityThreshold
        if (!inNearMissBand && !inSizeBlockedBand) continue
        const prev = this.bestSuggestion.get(c.trackId)
        if (prev === undefined || suggestion.score > prev.score)
          this.bestSuggestion.set(c.trackId, {
            identityId: suggestion.identityId,
            score: suggestion.score,
          })
      }
    }

    // Two passes. Pass 1 does the FRAME-SENSITIVE work (best-face hold + crop
    // capture) FIRST, before any store I/O, so the shm frame the handle points
    // at is resolved in the earliest possible microtask — a `setLabel` /
    // `setLabelForTrack` await between "frame arrived" and "crop captured" would
    // widen the window for the shm ring slot to recycle out from under us. Pass 2
    // does the order-insensitive label propagation.
    const labelWork: {
      trackId: string
      assignedIdentityId: string
      matchScore: number | null
    }[] = []

    for (const c of candidates) {
      const match = matches.get(c.trackId) ?? null
      const prev = this.aggregates.get(c.trackId) ?? EMPTY_AGGREGATE
      const { state, changed } = updateTrackAggregate(prev, match, {
        confirmFrames: settings.confirmFrames,
      })
      this.aggregates.set(c.trackId, state)
      if (changed && state.assignedIdentityId !== null) {
        // D683 (Task 7 review H2): after a fusion, later frames carry the
        // SURVIVOR id — a second identity reaching confirmFrames here would
        // silently relabel the piece this track absorbed. Never refused (a
        // genuine re-attach must still be nameable), but never silent either.
        if (
          this.fusedTrackIds.has(c.trackId) &&
          prev.assignedIdentityId !== null &&
          prev.assignedIdentityId !== state.assignedIdentityId
        ) {
          this.deps.logger.warn('face: fused tracks disagree', {
            tags: { deviceId: input.deviceId },
            meta: {
              trackId: c.trackId,
              previousIdentity: prev.assignedIdentityId,
              newIdentity: state.assignedIdentityId,
            },
          })
        }
        labelWork.push({
          trackId: c.trackId,
          assignedIdentityId: state.assignedIdentityId,
          matchScore: match?.score ?? null,
        })
        // (Re)assignment: seed the best-match tracker with THIS assignment's
        // score — a switch discards the prior identity's peak.
        if (match?.score !== undefined) this.bestMatchScore.set(c.trackId, match.score)
      } else if (
        match !== null &&
        state.assignedIdentityId !== null &&
        match.identityId === state.assignedIdentityId
      ) {
        // Continued frame for the assigned identity — keep the peak cosine.
        const prev = this.bestMatchScore.get(c.trackId)
        if (prev === undefined || match.score > prev)
          this.bestMatchScore.set(c.trackId, match.score)
      }

      // Best-face HOLD: keep the highest-confidence face per track for its
      // embedding and, INDEPENDENTLY, make sure a crop is captured. The two are
      // decoupled on purpose: a transient capture miss on the peak frame (shm
      // slot recycled, decode not RGB) must NOT permanently deny the track a
      // crop, and a later frame that DOES capture one backfills it.
      // ONLY the aggregate's CONFIRMED identity may be stamped onto the held
      // face — never the raw per-frame `match?.identityId`. The old
      // `?? match?.identityId` fallback let a SINGLE above-threshold frame
      // stamp `recognizedIdentityId` before the `confirmFrames` gate had
      // confirmed it, which (a) bypassed confirmFrames entirely — one lucky
      // frame on a small/ambiguous face auto-assigned a wrong identity — and
      // (b) persisted an assignment with NO `bestMatchScore` (the score is only
      // recorded on the confirming/continued frames), breaking the
      // "auto-assign carries its cosine" invariant. Live audit (2026-07-27)
      // found 10/11 auto-assigns had no score and 4/11 were sub-floor faces.
      const recognizedIdentityId = state.assignedIdentityId ?? undefined
      const held = this.bestFace.get(c.trackId)
      // Best-detection decision via the SHARED policy (identical ranking to the
      // best-frame path). A face crop still comes only from a face-bearing frame
      // (the documented FRAME↔FACE seam) — this just unifies the ranking.
      //
      // The size fed here is the DETECTION-FRAME face short side, deliberately
      // NOT `nativeFaceShortSidePx`: what this ranking is trying to protect is
      // the landmark precision the alignment warp consumes, and that is set by
      // the space SCRFD ran in. See `pipeline/face-size-score.ts`. Absent
      // `faceBbox` (an inherited embedding on a frame with no face detail)
      // scores 0, so such a frame can never displace a measured one.
      const detectionFrameShortSidePx =
        c.faceBbox !== undefined ? Math.min(c.faceBbox.w, c.faceBbox.h) : 0
      const isNewBest = this.bestTracker.observe(
        c.trackId,
        c.confidence,
        input.timestamp,
        undefined,
        undefined,
        undefined,
        faceSizeScore(detectionFrameShortSidePx),
      )
      const needsCrop = held !== undefined && held.crop === undefined
      if (isNewBest || needsCrop) {
        // Crop the FACE box (tight). `faceBbox` is the bbox of the `face` detail
        // on THIS frame. A face embedding can be INHERITED onto the person track
        // by the tracker on frames that carry no face detail (face turned away,
        // blur) — on those frames `faceBbox` is absent. We must NOT fall back to
        // the person box then: cropping the torso produces a "face" thumbnail
        // that isn't a face (the observed wrong-content gallery images). Only
        // capture from a frame that actually has a face box; otherwise leave the
        // track crop-less until a later face-bearing frame backfills one (the
        // gallery renders an honest "No crop" state for that window).
        const cropBbox = c.faceBbox ?? c.bbox
        let crop: Buffer | undefined
        if (c.faceAlignedCrop !== undefined) {
          // The EXACT ArcFace input: the executor already warped the face onto the
          // canonical template and embedded THIS crop, then shipped it verbatim.
          // Persist it as the gallery image so what you see is 1:1 with the vector
          // (the debugging goal). Self-contained bytes — no live frame / capture
          // needed, and it is inherently a face (produced from the face detail +
          // landmarks), so it never risks the torso-crop the faceBbox gate guards.
          crop = Buffer.from(c.faceAlignedCrop, 'base64')
        } else if (c.faceBbox !== undefined && input.frameHandle !== undefined) {
          try {
            const captured = await this.deps.captureCrop(
              input.frameHandle,
              c.faceBbox,
              input.frameWidth,
              input.frameHeight,
              input.cropPadding,
              c.trackId,
              input.deviceId,
            )
            crop = captured ?? undefined
          } catch (err) {
            this.deps.logger.debug('FaceRecognizer crop capture failed', {
              tags: { deviceId: input.deviceId },
              meta: { trackId: c.trackId, error: String(err) },
            })
          }
        }
        if (isNewBest) {
          // Never regress a held crop back to null: keep an earlier good crop
          // when this (higher-confidence) frame failed to capture one.
          const bestCrop = crop ?? held?.crop
          const source = this.parkSourceFrame(input, c) ?? held?.source
          this.bestFace.set(c.trackId, {
            score: c.confidence,
            embedding: c.embedding,
            embeddingModelId: c.embeddingModelId,
            bbox: cropBbox,
            timestamp: input.timestamp,
            ...(source !== undefined ? { source } : {}),
            ...(bestCrop !== undefined ? { crop: bestCrop } : {}),
            ...(recognizedIdentityId !== undefined ? { recognizedIdentityId } : {}),
            ...(c.nativeFaceShortSidePx !== undefined
              ? { nativeFaceShortSidePx: c.nativeFaceShortSidePx }
              : {}),
          })
        } else if (crop !== undefined && held !== undefined) {
          // Not a new best, but the track still lacked a crop — backfill it while
          // keeping the best frame's embedding/score/timestamp.
          this.bestFace.set(c.trackId, { ...held, crop })
        }
        if (crop !== undefined && input.frameHandle !== undefined) {
          this.deps.onLiveHierarchy?.({
            deviceId: input.deviceId,
            trackId: c.trackId,
            timestamp: input.timestamp,
            bodyBbox: { x: c.bbox.x, y: c.bbox.y, w: c.bbox.w, h: c.bbox.h },
            frameWidth: input.frameWidth,
            frameHeight: input.frameHeight,
            cropPadding: input.cropPadding,
            frameHandle: input.frameHandle,
          })
        }
        this.deps.logger.debug('face: best-face held', {
          tags: { deviceId: input.deviceId, trackId: c.trackId },
          meta: {
            score: c.confidence,
            isNewBest,
            hasCrop: this.bestFace.get(c.trackId)?.crop !== undefined,
            recognizedIdentityId: recognizedIdentityId ?? null,
          },
        })
      } else if (
        held !== undefined &&
        recognizedIdentityId !== undefined &&
        held.recognizedIdentityId === undefined
      ) {
        this.bestFace.set(c.trackId, { ...held, recognizedIdentityId })
      }
    }

    // Pass 2: label propagation (store writes — order-insensitive, run only
    // after every frame-sensitive crop capture above has completed).
    for (const work of labelWork) {
      this.observeIdentity({
        deviceId: input.deviceId,
        trackId: work.trackId,
        timestamp: input.timestamp,
        identityId: work.assignedIdentityId,
      })
      const name = this.names.get(work.assignedIdentityId)
      this.deps.logger.info('face: identity assigned', {
        tags: { deviceId: input.deviceId, trackId: work.trackId },
        meta: {
          identityId: work.assignedIdentityId,
          name: name ?? null,
          score: work.matchScore,
        },
      })
      if (name === undefined) continue
      // A recognized identity is TIER 2 — the finest thing sayable about the
      // subject — scored by the MATCH, not by the detection: the cosine
      // similarity is what a second, better match has to beat. No operator
      // authority here; this is the machine's answer, and the gallery's manual
      // assignment is the one that outranks it.
      const candidate: LabelCandidate = {
        text: name,
        tier: 2,
        // `matchScore` is null only on a path that produced no name, and we
        // returned above when `name` was undefined. 0 keeps the type honest.
        score: work.matchScore ?? 0,
        stepId: FACE_RECOGNIZER_STEP_ID,
        decidedAt: Date.now(),
        // The id travels WITH the name. A rule matches the id (it survives a
        // rename in the gallery); the name is only ever shown.
        identityId: work.assignedIdentityId,
      }
      // The TRACK decides; the events copy that decision verbatim. A refused
      // track write leaves the rows alone — nothing changed, so there is
      // nothing to copy, and re-deciding per row is exactly what let 407 of 437
      // tracks disagree with their own events.
      let accepted: TieredLabelPatch | undefined
      try {
        const decision = await this.deps.trackStore.applyLabelCandidate(work.trackId, candidate)
        if (decision?.kind === 'write') accepted = decision.patch
      } catch (err) {
        this.deps.logger.warn('track identity label failed', {
          tags: { deviceId: input.deviceId },
          meta: { trackId: work.trackId, error: String(err) },
        })
      }
      if (accepted !== undefined) {
        try {
          await this.deps.eventStore.projectTrackLabel(work.trackId, accepted)
        } catch (err) {
          this.deps.logger.warn('event identity label failed', {
            tags: { deviceId: input.deviceId },
            meta: { trackId: work.trackId, error: String(err) },
          })
        }
      }
      try {
        await this.deps.recomputeImportance?.(work.trackId)
      } catch (err) {
        this.deps.logger.warn('recomputeImportance failed', {
          tags: { deviceId: input.deviceId },
          meta: { trackId: work.trackId, error: String(err) },
        })
      }
    }
  }

  /**
   * Persist the held best face for a finished track as ONE FaceStore buffer
   * entry (crop -> MediaStore under ownerKind 'face'), then drop the track's
   * in-memory state. Best-effort; a track with no held face is a no-op.
   */
  /**
   * Peak identity-match cosine for the track's assigned identity, or undefined
   * when no identity was ever confirmed. Read at close BEFORE {@link onTrackEnd}
   * drops the per-track state (the NC `minLabelConfidence` seam).
   */
  bestLabelMatchConfidence(trackId: string): number | undefined {
    return this.bestMatchScore.get(trackId)
  }

  /**
   * The track's CURRENT aggregate identity verdict: a confirmed identity id,
   * `null` once confirmed as "nobody" (never happens today — `updateTrackAggregate`
   * only assigns, it does not un-assign), or `undefined` before any frame has
   * voted / after the track ended. Read live — unlike {@link bestLabelMatchConfidence}
   * this does not wait for {@link onTrackEnd}.
   */
  assignedIdentityId(trackId: string): string | null | undefined {
    return this.aggregates.get(trackId)?.assignedIdentityId
  }

  /**
   * D692: the frame instant of this track's first face detail, or undefined before any
   * (and after the track ended). Read live by the grouped-notification outlook.
   */
  firstFaceAt(trackId: string): number | undefined {
    return this.firstFace.get(trackId)
  }

  /**
   * Test/debug accessor: the held best face's detection-confidence SCORE for
   * a live track (undefined if none held). Mirrors {@link bestLabelMatchConfidence}
   * at the finer grain of the best-FACE ranking (`bestTracker`/`bestFace`)
   * rather than the identity match.
   */
  heldBestFaceScore(trackId: string): number | undefined {
    return this.bestFace.get(trackId)?.score
  }

  /**
   * D683 §6.3: fold the absorbed piece's face state into the survivor's — the
   * union of both pieces' evidence, field by field, under one rule the binding
   * decisions set: extra ids are preferred over mix-ups, so a named piece is
   * never absorbed into a DIFFERENTLY-named one.
   *
   *  - The survivor's name is its live aggregate's.
   *  - Two different names are a linker defect (L2 should have refused the
   *    fusion): WARN `face: fused tracks disagree` with `tags: { deviceId }`,
   *    and NOTHING identity-bearing of the absorbed piece is adopted — not its
   *    aggregate, not its match score or suggestion, and not its face, which
   *    would otherwise be stored under the survivor's name (review H5).
   *  - Otherwise `aggregates`: confirmations summed per identity, the name the
   *    survivor's when it has one, else the absorbed piece's. `bestMatchScore`
   *    is a peak FOR the kept name: the max of both when the absorbed piece
   *    carried that name too, else the survivor's. `bestSuggestion`: the
   *    higher score.
   *  - `bestFace`/`bestTracker`: the better-ranked face (`BEST_FACE_POLICY`)
   *    is held under `survivorId`, REBUILT with the merged name — never a face
   *    stamped with one name carrying another's score (H5).
   *  - `lastSourceParkAt`: the later; the face SOURCE parcel follows the face
   *    ranking's verdict through `faceSourceFrames.adopt` (review M3).
   *
   * No identity verdict is emitted ({@link FaceRecognizerDeps.onIdentityVerdict}):
   * adoption is not new evidence, and the tracker already holds the absorbed
   * piece's verdict on its own tracklet (Task 11) — a verdict here would be a
   * second, replay-invisible source for the cannot-link.
   */
  adoptTrack(deviceId: number, survivorIdIn: string, absorbedIdIn: string): void {
    const survivorId = this.aliases.get(survivorIdIn) ?? survivorIdIn
    const absorbedId = this.aliases.get(absorbedIdIn) ?? absorbedIdIn
    const a = this.aggregates.get(survivorId)
    const b = this.aggregates.get(absorbedId)
    const liveA = a?.assignedIdentityId ?? null
    const bId = b?.assignedIdentityId ?? null
    const disagree = liveA !== null && bId !== null && liveA !== bId
    let mergedIdentity = liveA
    if (disagree) {
      this.deps.logger.warn('face: fused tracks disagree', {
        tags: { deviceId },
        meta: {
          survivorId,
          absorbedId,
          survivorIdentity: liveA,
          absorbedIdentity: bId,
          absorbedFaceDropped: this.bestFace.has(absorbedId),
        },
      })
      // The absorbed piece's face is someone else's as far as the names say:
      // it must not compete for the survivor's held face.
      this.bestTracker.delete(absorbedId)
      this.bestFace.delete(absorbedId)
      this.bestSuggestion.delete(absorbedId)
    } else if (b !== undefined) {
      const confirmations: Record<string, number> = { ...a?.confirmations }
      for (const [identityId, count] of Object.entries(b.confirmations)) {
        confirmations[identityId] = (confirmations[identityId] ?? 0) + count
      }
      mergedIdentity = liveA ?? bId
      this.aggregates.set(survivorId, { assignedIdentityId: mergedIdentity, confirmations })
      if (mergedIdentity !== null && mergedIdentity === bId) {
        const scoreA = this.bestMatchScore.get(survivorId)
        const scoreB = this.bestMatchScore.get(absorbedId)
        if (scoreB !== undefined) {
          this.bestMatchScore.set(
            survivorId,
            scoreA === undefined ? scoreB : Math.max(scoreA, scoreB),
          )
        }
      }
    }
    this.aggregates.delete(absorbedId)
    this.bestMatchScore.delete(absorbedId)

    const bestShotFrom = this.bestTracker.adopt(survivorId, absorbedId)
    const winningFace =
      bestShotFrom === 'absorbed' ? this.bestFace.get(absorbedId) : this.bestFace.get(survivorId)
    if (winningFace !== undefined) {
      this.bestFace.set(survivorId, restampHeldFace(winningFace, mergedIdentity))
    }
    this.bestFace.delete(absorbedId)

    const sugA = this.bestSuggestion.get(survivorId)
    const sugB = this.bestSuggestion.get(absorbedId)
    if (sugB !== undefined && (sugA === undefined || sugB.score > sugA.score)) {
      this.bestSuggestion.set(survivorId, sugB)
    }
    this.bestSuggestion.delete(absorbedId)

    const parkA = this.lastSourceParkAt.get(survivorId)
    const parkB = this.lastSourceParkAt.get(absorbedId)
    if (parkB !== undefined && (parkA === undefined || parkB > parkA)) {
      this.lastSourceParkAt.set(survivorId, parkB)
    }
    this.lastSourceParkAt.delete(absorbedId)
    // D692: the merged track first showed a face at the EARLIER of the two pieces.
    const faceA = this.firstFace.get(survivorId)
    const faceB = this.firstFace.get(absorbedId)
    if (faceB !== undefined && (faceA === undefined || faceB < faceA)) {
      this.firstFace.set(survivorId, faceB)
    }
    this.firstFace.delete(absorbedId)
    this.deps.faceSourceFrames?.adopt(deviceId, survivorId, absorbedId, bestShotFrom)

    this.fusedTrackIds.add(survivorId)
    this.fusedTrackIds.delete(absorbedId)
    const chained = this.absorbedBy.get(absorbedId) ?? []
    this.absorbedBy.delete(absorbedId)
    this.absorbedBy.set(survivorId, [
      ...(this.absorbedBy.get(survivorId) ?? []),
      absorbedId,
      ...chained,
    ])
    for (const id of [absorbedId, ...chained]) this.aliases.set(id, survivorId)
  }

  /**
   * D683 review M1: a frame still carrying an ABSORBED id (in flight when the
   * fusion ran) is about the survivor now. Rewritten, never re-created under
   * the absorbed id. Allocates only when some id is actually routed.
   */
  private routeAbsorbedIds(input: FaceProcessInput): FaceProcessInput {
    if (this.aliases.size === 0) return input
    let routed = 0
    const tracked = input.tracked.map((t) => {
      const survivorId = this.aliases.get(t.trackId)
      if (survivorId === undefined) return t
      routed += 1
      return { ...t, trackId: survivorId }
    })
    if (routed === 0) return input
    this.deps.logger.debug('face: frame under an absorbed track id routed to its survivor', {
      tags: { deviceId: input.deviceId },
      meta: { routed },
    })
    return { ...input, tracked }
  }

  /** The survivor ended: its absorbed ids stop routing, and any state a frame
   *  in flight across the fusion re-created under one is dropped — said. */
  private endAbsorbedIds(deviceId: number, survivorId: string): void {
    const absorbed = this.absorbedBy.get(survivorId)
    if (absorbed === undefined) return
    this.absorbedBy.delete(survivorId)
    for (const id of absorbed) {
      this.aliases.delete(id)
      const containers: readonly { delete(key: string): boolean }[] = [
        this.aggregates,
        this.bestFace,
        this.bestMatchScore,
        this.bestSuggestion,
        this.lastSourceParkAt,
        this.firstFace,
      ]
      let ghost = false
      for (const container of containers) ghost = container.delete(id) || ghost
      this.bestTracker.delete(id)
      this.fusedTrackIds.delete(id)
      if (ghost) {
        this.deps.logger.info(
          "face: state re-created under an absorbed id dropped at the survivor's end",
          {
            tags: { deviceId },
            meta: { survivorId, absorbedId: id },
          },
        )
      }
    }
  }

  /**
   * A face just became its track's held best: order its frame parked on the
   * node that owns the handle (D644) — only with `keepSourceFrames` on, only a
   * frame with a real face box, and at most once per
   * {@link FACE_SOURCE_PARK_MIN_INTERVAL_MS} per track (each park is a native
   * encode on the runner). `undefined` = not parked now; the held face keeps
   * the frame of the previous park.
   */
  private parkSourceFrame(
    input: FaceProcessInput,
    c: TrackedDetectionOut,
  ): HeldFaceSource | undefined {
    const keeper = this.deps.faceSourceFrames
    if (keeper === undefined || !input.settings.keepSourceFrames) return undefined
    if (c.faceBbox === undefined || input.frameHandle === undefined) return undefined
    const last = this.lastSourceParkAt.get(c.trackId)
    if (!shouldParkSource(last, input.timestamp, FACE_SOURCE_PARK_MIN_INTERVAL_MS)) {
      return undefined
    }
    this.lastSourceParkAt.set(c.trackId, input.timestamp)
    return keeper.park({
      deviceId: input.deviceId,
      trackId: c.trackId,
      frameHandle: input.frameHandle,
      geometry: {
        timestamp: input.timestamp,
        bbox: c.faceBbox,
        frameWidth: input.frameWidth,
        frameHeight: input.frameHeight,
        ...(c.faceLandmarks !== undefined ? { landmarks: c.faceLandmarks } : {}),
      },
    })
  }

  async onTrackEnd(deviceId: number, trackId: string): Promise<void> {
    try {
      await this.persistTrackFace(deviceId, trackId)
    } finally {
      // Every close path — buffered or dropped — lets the node forget the
      // parcel; its own age ceiling covers a lost release.
      this.lastSourceParkAt.delete(trackId)
      this.firstFace.delete(trackId)
      this.deps.faceSourceFrames?.release(deviceId, trackId)
    }
  }

  private async persistTrackFace(deviceId: number, trackId: string): Promise<void> {
    const held = this.bestFace.get(trackId)
    // Capture the winning identity-match cosine BEFORE dropping the per-track
    // state below — persisted onto the face row for auditability (2026-07-23).
    // Undefined when no identity was ever auto-confirmed (collect-only / below
    // threshold / below the recognition floor).
    const bestMatchScore = this.bestMatchScore.get(trackId)
    // Peak SUGGESTION for the track (2026-07-24) — captured alongside
    // bestMatchScore, before the per-track state is dropped. Written to the row
    // ONLY when the track was NOT auto-assigned (mutual exclusivity, resolved
    // below via `held.recognizedIdentityId`).
    const bestSuggestion = this.bestSuggestion.get(trackId)
    this.aggregates.delete(trackId)
    this.bestFace.delete(trackId)
    this.bestTracker.delete(trackId)
    this.bestMatchScore.delete(trackId)
    this.bestSuggestion.delete(trackId)
    this.fusedTrackIds.delete(trackId)
    this.endAbsorbedIds(deviceId, trackId)
    if (held === undefined) {
      this.deps.logger.debug('face: track ended without a held face', {
        tags: { deviceId, trackId },
      })
      return
    }
    // Never persist an IMAGELESS face. A gallery row with no crop is a useless
    // "no image" result: the R1 gate captures a crop ONLY from a real
    // face-bearing frame, so a missing crop after all per-frame backfill
    // attempts means no usable face was ever captured for this track. The
    // embedding-only row adds negligible matching value (the live gallery is
    // crop-driven), so we drop it rather than pollute the gallery. Throttled log.
    if (held.crop === undefined) {
      const now = Date.now()
      if (now - this.lastImagelessLogAt >= FACE_IMAGELESS_LOG_THROTTLE_MS) {
        this.lastImagelessLogAt = now
        this.deps.logger.info('face: dropping imageless track (no crop captured)', {
          tags: { deviceId, trackId },
          meta: { score: held.score },
        })
      }
      return
    }
    const faceId = `face-${trackId}`
    let mediaId: number | undefined
    try {
      mediaId = await this.deps.mediaStore.put({
        deviceId,
        ownerKind: 'face',
        ownerId: faceId,
        kind: 'crop',
        timestamp: held.timestamp,
        data: held.crop,
      })
    } catch (err) {
      this.deps.logger.warn('FaceRecognizer face crop put failed', {
        tags: { deviceId },
        meta: { faceId, error: String(err) },
      })
    }
    // The crop store failed — do not persist a face row that would be imageless
    // in the gallery. (Best-effort: it will be re-captured on a future track.)
    if (mediaId === undefined) {
      this.deps.logger.warn('face: crop store failed — dropping face row', {
        tags: { deviceId, trackId },
        meta: { faceId },
      })
      return
    }
    try {
      await this.deps.copyCropToTrackPreview?.({
        deviceId,
        trackId,
        crop: held.crop,
        timestamp: held.timestamp,
      })
    } catch (err) {
      this.deps.logger.debug('face: track preview copy failed', {
        tags: { deviceId },
        meta: { trackId, error: String(err) },
      })
    }
    // D644: the face IS being buffered — only now is its frame taken off the
    // node and stored (or the track keyFrame of the same instant referenced).
    const source =
      held.source === undefined
        ? null
        : await this.deps.faceSourceFrames?.persist({
            deviceId,
            trackId,
            faceId,
            source: held.source,
          })
    // Design B: link the face to the track's shared native key frame + its face
    // bbox on that frame, so a detail view draws the box over the native frame.
    const keyFrameMediaId = this.deps.getKeyFrameMediaId?.(trackId)
    try {
      await this.deps.faceStore.insert({
        id: faceId,
        deviceId,
        trackId,
        timestamp: held.timestamp,
        embedding: held.embedding,
        // The feature space this vector lives in, persisted so ENROLMENT can
        // stamp the identity sample truthfully instead of assuming a constant.
        embeddingModelId: held.embeddingModelId,
        mediaId,
        ...(held.recognizedIdentityId !== undefined
          ? { recognizedIdentityId: held.recognizedIdentityId }
          : {}),
        assigned: false,
        faceBbox: held.bbox,
        ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
        ...(bestMatchScore !== undefined ? { bestMatchScore } : {}),
        ...(held.nativeFaceShortSidePx !== undefined
          ? { nativeFaceShortSidePx: held.nativeFaceShortSidePx }
          : {}),
        // Suggestion is written ONLY when the track was NOT auto-assigned
        // (mutual exclusivity): an assigned row carries recognizedIdentityId +
        // bestMatchScore, a suggestion row carries suggested*. Below both bands →
        // neither (bestSuggestion undefined).
        ...(held.recognizedIdentityId === undefined && bestSuggestion !== undefined
          ? {
              suggestedIdentityId: bestSuggestion.identityId,
              suggestedMatchScore: bestSuggestion.score,
            }
          : {}),
        ...(source !== null && source !== undefined
          ? {
              sourceFrameMediaId: source.mediaId,
              sourceFrameBbox: source.bbox,
              ...(source.landmarks !== undefined ? { sourceFrameLandmarks: source.landmarks } : {}),
            }
          : {}),
      })
      // The gallery row LANDED — only NOW is this track's face assignable, so
      // only now may `Track.hasEmbeddedFace` say so. Every earlier point in
      // this method is a branch that can still drop the face (imageless track,
      // crop-store failure) and the branches above `onTrackEnd` are gates that
      // can refuse it outright; `Track.hasFace` already covers "a detector
      // fired". Best-effort and separately guarded: a track store that cannot
      // take the mark must not turn a persisted gallery face into a logged
      // insert FAILURE, which the outer catch would report.
      try {
        await this.deps.markEmbeddedFace?.(trackId)
      } catch (err) {
        this.deps.logger.warn('face: hasEmbeddedFace mark failed — row persisted without it', {
          tags: { deviceId, trackId },
          meta: { faceId, error: String(err) },
        })
      }
      this.deps.logger.info('face: buffered to gallery', {
        tags: { deviceId, trackId },
        meta: {
          faceId,
          hasCrop: true,
          recognizedIdentityId: held.recognizedIdentityId ?? null,
          score: held.score,
        },
      })
      // Best-effort live-update notification — emitted AFTER the store write
      // succeeded, never before. An emit failure must not fail the persist.
      try {
        this.deps.emitFaceGalleryChanged?.({
          deviceId,
          faceId,
          kind: 'buffered',
        })
      } catch (err) {
        this.deps.logger.debug('face-gallery-changed emit failed', {
          tags: { deviceId, trackId },
          meta: { faceId, error: String(err) },
        })
      }
    } catch (err) {
      this.deps.logger.warn('FaceRecognizer faceStore insert failed', {
        tags: { deviceId },
        meta: { faceId, error: String(err) },
      })
    }
  }
}
