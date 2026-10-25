import type {
  FrameHandle,
  IScopedLogger,
  PipelineAnalyticsPlateGalleryChangedPayload,
} from '@camstack/types'
import type { LiveHierarchyCapture } from './ensure-track-hierarchy.js'
import type { TrackedDetectionOut } from './pipeline/frame-processor.js'
import type { KeyFrameCropFn } from './pipeline/keyframe-crop.js'
import { isPlausiblePlateRead, normalizePlate } from './pipeline/plate-clustering.js'
import {
  DEFAULT_PLATE_MATCH_OPTS,
  matchPlateText,
  type PlateGallerySample,
  type PlateMatchOpts,
} from './pipeline/plate-matcher.js'
import { MAX_VOTING_READS, type PlateReadVote, votePlateText } from './pipeline/plate-vote.js'
import type { SubjectPathSample } from './pipeline/subject-agreement.js'
import { REASON_BELOW_MIN_CONFIDENCE, REASON_IMPLAUSIBLE } from './runtime/failure-report.js'

/** Held plate state for a track: EVERY read it produced (the vote), plus the
 *  max-score read's crop + geometry (the gallery tile). */
interface HeldPlate {
  /** Max-score read — the crop/bbox/timestamp anchor, NOT the stored text. */
  text: string
  score: number
  /** Every read the track produced, in arrival order, capped at
   *  {@link MAX_VOTING_READS}. The stored plate text is the per-character vote
   *  over these, never a single read (see `plate-vote.ts`). */
  reads: PlateReadVote[]
  bbox: { x: number; y: number; w: number; h: number }
  timestamp: number
  /** Detail-frame dims + padding retained so a keyFrame-derived last-resort crop
   *  (`deriveCropFromKeyFrame`) can normalize the pixel-space bbox at close. */
  frameWidth: number
  frameHeight: number
  cropPadding: number
  crop?: Buffer
}

/** Test/debug snapshot of a track's held plate — see {@link PlateRecognizer.heldPlate}. */
export interface HeldPlateSnapshot {
  readonly text: string
  readonly score: number
  readonly readCount: number
}

/** One plate row write — the shape `PlateRecognizerDeps.plateStore.insert` takes. */
export interface PlateStoreInsertInput {
  readonly id: string
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly text: string
  readonly score: number
  /** Media id (D482) of the buffered crop. */
  readonly mediaId?: number
  readonly corrected: boolean
  readonly assigned: boolean
  readonly recognizedVehicleId?: string
  /** Media id (D482) of the track's native key frame (Design B). */
  readonly keyFrameMediaId?: number
  readonly plateBbox?: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
}

/** The plate-row store surface this recognizer touches. */
export interface PlateRecognizerPlateStore {
  insert(p: PlateStoreInsertInput): Promise<void>
}

/** The vehicle-gallery store surface this recognizer touches. */
export interface PlateRecognizerVehicleStore {
  loadGallery(): Promise<readonly PlateGallerySample[]>
  listVehicles(): Promise<readonly { id: string; name: string }[]>
}

/** One plate-crop media write — the shape `PlateRecognizerDeps.mediaStore.put` takes. */
export interface PlateCropMediaPutInput {
  readonly deviceId: number
  readonly ownerKind: 'plate'
  readonly ownerId: string
  readonly kind: 'crop'
  readonly timestamp: number
  readonly data: Buffer
}

/** The media-store surface this recognizer touches. */
export interface PlateRecognizerMediaStore {
  put(input: PlateCropMediaPutInput): Promise<number>
}

export interface PlateRecognizerDeps {
  readonly plateStore: PlateRecognizerPlateStore
  readonly vehicleStore: PlateRecognizerVehicleStore
  readonly mediaStore: PlateRecognizerMediaStore
  /** DISPLAY-crop capture for the plate gallery tile: native-first with a
   *  bounded full-frame fallback (keyframe-native or ≤640 RAM tier, honest
   *  sub-native — never upscaled), `null` only on a total miss. `ownerId` (the
   *  trackId) keys the once-per-track fallback info log. `deviceId` (S4) keys
   *  the injected CaptureScheduler's per-device lane — the wrapper in
   *  `index.ts` routes this fetch through the scheduler, so a `null` may also
   *  mean "dropped stale / cancelled" (treated exactly like a capture miss). */
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
   * Per-camera OCR outcome counter (`failure-contribution`, family
   * `plate-ocr`). `reason` absent = the read was ACCEPTED — that call is the
   * denominator, and a refusal rate published without it would move with
   * traffic instead of with quality. Optional so the recognizer stays
   * constructible in isolation.
   */
  readonly notePlateRead?: (deviceId: number, reason?: string) => void
  /** Design B: the track's native key frame media id (D482), captured by the
   *  object-embedding best path — stamped onto the plate row so the detail
   *  view renders the plate box over the native frame. Field name kept for the
   *  wiring closure in `index.ts`; the value is `TrackResidentState.
   *  keyFrameMediaId`. */
  readonly getKeyFrameMediaId?: (trackId: string) => number | undefined
  /** DURABLE last-resort crop: when the live gallery-crop capture missed every
   *  tier (cross-node frame eviction before the async detail read routed back),
   *  cut the plate ROI out of the track's persisted native `keyFrame` instead.
   *  Guarded inside the impl (`createKeyFrameCrop`) on subject MOTION first and
   *  temporal skew second; returns the JPEG + the |keyFrame−read| skew, or
   *  `null` when unavailable / the vehicle had moved off the rectangle.
   *  Optional so tests + version-skew callers can omit it. */
  readonly deriveCropFromKeyFrame?: KeyFrameCropFn
  /** Best-effort live-update notification (D8 telemetry). */
  readonly emitPlateGalleryChanged?: (payload: PipelineAnalyticsPlateGalleryChangedPayload) => void
  /**
   * A plate crop just landed from a still-live handle. The vehicle crop and
   * full frame must come from that same handle. Optional so tests can omit it.
   */
  readonly onLiveHierarchy?: (input: LiveHierarchyCapture) => void
  readonly matchOpts?: PlateMatchOpts
  readonly logger: IScopedLogger
}

export interface PlateProcessInput {
  readonly deviceId: number
  readonly timestamp: number
  readonly frameWidth: number
  readonly frameHeight: number
  readonly tracked: readonly TrackedDetectionOut[]
  readonly cropPadding: number
  /** Drop plate reads below this OCR confidence (default 0 = keep all). */
  readonly minConfidence?: number
  readonly frameHandle?: FrameHandle
}

/**
 * PlateRecognizer — collects EVERY license-plate OCR read a vehicle track
 * produces and stores their per-character VOTE (`plate-vote.ts`) at close, plus
 * the max-score read's crop for the gallery tile. Unlike faces there is NO
 * gallery matching: the OCR text IS the label and already rides on the event via
 * the detection pipeline. Mirrors FaceRecognizer's hold→onTrackEnd lifecycle.
 */
export class PlateRecognizer {
  private readonly bestPlate = new Map<string, HeldPlate>()
  private gallery: readonly PlateGallerySample[] = []
  private nameById = new Map<string, string>()
  private readonly matchOpts: PlateMatchOpts

  constructor(private readonly deps: PlateRecognizerDeps) {
    this.matchOpts = deps.matchOpts ?? DEFAULT_PLATE_MATCH_OPTS
  }

  /** Reload the in-memory vehicle gallery + name map (after a gallery mutation). */
  async refreshGallery(): Promise<void> {
    try {
      this.gallery = await this.deps.vehicleStore.loadGallery()
      this.nameById = new Map(
        (await this.deps.vehicleStore.listVehicles()).map((v) => [v.id, v.name]),
      )
    } catch (err) {
      this.deps.logger.warn('PlateRecognizer.refreshGallery failed', {
        meta: { error: String(err) },
      })
    }
  }

  private matchVehicle(text: string, score: number): { vehicleId: string; name: string } | null {
    const m = matchPlateText({ text: normalizePlate(text), score }, this.gallery, this.matchOpts)
    if (m === null) return null
    const name = this.nameById.get(m.vehicleId)
    return name !== undefined ? { vehicleId: m.vehicleId, name } : null
  }

  /** Live label for a plate read: the recognized vehicle NAME when matched,
   *  else the NORMALIZED (uppercase, alnum-only) OCR text — never the raw read,
   *  so lowercase/separator residue can't reach track labels. Returns `null`
   *  for an implausible read (junk OCR off a distant/oblique plate) — the
   *  caller must NOT stamp a label then. */
  resolveLabel(text: string, score: number): string | null {
    return this.resolveLabelWithVehicle(text, score)?.text ?? null
  }

  /**
   * {@link resolveLabel} plus the GALLERY ROW it named, when a vehicle claimed
   * the read.
   *
   * The id is what a notification rule matches on — a display name is
   * renameable and a rule authored on the old spelling goes silently dark
   * (`LabelAttribution.identityId`). An unclaimed but plausible read still
   * returns its normalized text with NO `vehicleId`: it is a plate, it is just
   * nobody's plate.
   */
  resolveLabelWithVehicle(
    text: string,
    score: number,
  ): { readonly text: string; readonly vehicleId?: string } | null {
    if (!isPlausiblePlateRead(text, score)) return null
    const matched = this.matchVehicle(text, score)
    return matched !== null
      ? { text: matched.name, vehicleId: matched.vehicleId }
      : { text: normalizePlate(text) }
  }

  async processFrame(input: PlateProcessInput): Promise<void> {
    const minConfidence = input.minConfidence ?? 0
    const candidates = input.tracked.filter(
      (
        t,
      ): t is TrackedDetectionOut & {
        plateText: string
        plateScore: number
        plateBbox: { x: number; y: number; w: number; h: number }
      } =>
        typeof t.plateText === 'string' &&
        t.plateText.length > 0 &&
        typeof t.plateScore === 'number' &&
        t.plateScore >= minConfidence &&
        t.plateBbox !== undefined,
    )
    if (candidates.length === 0) return

    for (const c of candidates) {
      await this.observeRead({
        deviceId: input.deviceId,
        trackId: c.trackId,
        text: c.plateText,
        score: c.plateScore,
        bbox: c.plateBbox,
        bodyBbox: { x: c.bbox.x, y: c.bbox.y, w: c.bbox.w, h: c.bbox.h },
        timestamp: input.timestamp,
        frameWidth: input.frameWidth,
        frameHeight: input.frameHeight,
        cropPadding: input.cropPadding,
        ...(input.frameHandle !== undefined ? { frameHandle: input.frameHandle } : {}),
      })
    }
  }

  /**
   * Detail-plane entry point (two-plane design): plate-ocr runs on demand per
   * track via `pipelineRunner.runDetailSubtree`, NOT per frame, so the OCR read
   * never lands on the per-frame `tracked[]` that {@link processFrame} scans.
   * The dispatcher's result router calls this with each plate detail so the
   * gallery still collects the best read + tight crop (persisted on
   * {@link onTrackEnd}). Without it the plate label rides the event but the
   * gallery stays empty (0 plateCrop) — the observed live gap.
   */
  async observePlateRead(input: {
    readonly deviceId: number
    readonly trackId: string
    readonly text: string
    readonly score: number
    readonly bbox: { x: number; y: number; w: number; h: number }
    readonly timestamp: number
    readonly frameWidth: number
    readonly frameHeight: number
    readonly cropPadding: number
    readonly minConfidence?: number
    readonly frameHandle?: FrameHandle
    readonly bodyBbox?: { x: number; y: number; w: number; h: number }
  }): Promise<void> {
    // A discarded read is logged, never dropped in silence: a camera whose
    // reads are all rejected here looks EXACTLY like a camera that never saw a
    // plate, and the two need very different fixes.
    const minConfidence = input.minConfidence ?? 0
    const reason = !isPlausiblePlateRead(input.text, input.score)
      ? REASON_IMPLAUSIBLE
      : input.score < minConfidence
        ? REASON_BELOW_MIN_CONFIDENCE
        : null
    if (reason !== null) {
      this.deps.notePlateRead?.(input.deviceId, reason)
      this.deps.logger.info('plate: read discarded', {
        tags: { deviceId: input.deviceId, trackId: input.trackId },
        meta: { text: input.text, score: input.score, minConfidence, reason },
      })
      return
    }
    // THE DENOMINATOR. Noted before `observeRead` because acceptance is decided
    // here: everything past this line is storage, and a storage failure is a
    // different family from an OCR refusal.
    this.deps.notePlateRead?.(input.deviceId)
    await this.observeRead(input)
  }

  /**
   * Record one plate read for a track (shared by the per-frame + detail-plane
   * paths).
   *
   * EVERY read is kept for the close-time vote — a track's reads disagree, and
   * the disagreement is the signal. The crop + geometry still track the
   * MAX-SCORE read: the vote decides the text, but the picture the operator
   * reviews should be the sharpest frame the track produced.
   *
   * The read list is capped at {@link MAX_VOTING_READS} in ARRIVAL order, not
   * by score: evicting the lowest-scoring read would re-introduce the very
   * ranking this vote exists to stop trusting.
   */
  private async observeRead(input: {
    readonly deviceId: number
    readonly trackId: string
    readonly text: string
    readonly score: number
    readonly bbox: { x: number; y: number; w: number; h: number }
    readonly timestamp: number
    readonly frameWidth: number
    readonly frameHeight: number
    readonly cropPadding: number
    readonly frameHandle?: FrameHandle
    readonly bodyBbox?: { x: number; y: number; w: number; h: number }
  }): Promise<void> {
    const held = this.bestPlate.get(input.trackId)
    const vote: PlateReadVote = { text: input.text, score: input.score }
    if (held !== undefined && input.score <= held.score) {
      if (held.reads.length < MAX_VOTING_READS) held.reads.push(vote)
      return
    }
    const reads = held?.reads ?? []
    if (reads.length < MAX_VOTING_READS) reads.push(vote)

    let crop: Buffer | undefined
    if (input.frameHandle !== undefined) {
      try {
        const captured = await this.deps.captureCrop(
          input.frameHandle,
          input.bbox,
          input.frameWidth,
          input.frameHeight,
          input.cropPadding,
          input.trackId,
          input.deviceId,
        )
        crop = captured ?? undefined
      } catch (err) {
        this.deps.logger.debug('PlateRecognizer crop capture failed', {
          tags: { deviceId: input.deviceId },
          meta: { trackId: input.trackId, error: String(err) },
        })
      }
    }
    if (crop !== undefined && input.frameHandle !== undefined && input.bodyBbox !== undefined) {
      this.deps.onLiveHierarchy?.({
        deviceId: input.deviceId,
        trackId: input.trackId,
        timestamp: input.timestamp,
        bodyBbox: input.bodyBbox,
        frameWidth: input.frameWidth,
        frameHeight: input.frameHeight,
        cropPadding: input.cropPadding,
        frameHandle: input.frameHandle,
      })
    }
    this.bestPlate.set(input.trackId, {
      text: input.text,
      score: input.score,
      reads,
      bbox: input.bbox,
      timestamp: input.timestamp,
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      cropPadding: input.cropPadding,
      ...(crop !== undefined ? { crop } : {}),
    })
  }

  /**
   * Best OCR read score for the track's held plate (`plateText.confidence`),
   * or undefined when no plausible plate was read. Read at close BEFORE
   * {@link onTrackEnd} drops the per-track state (the NC `minLabelConfidence`
   * seam — mirrors the face recognizer's identity-match confidence).
   */
  bestLabelMatchConfidence(trackId: string): number | undefined {
    return this.bestPlate.get(trackId)?.score
  }

  /**
   * Test/debug accessor: the held plate's text, score and vote-read count for
   * a live track (undefined if none held).
   */
  heldPlate(trackId: string): HeldPlateSnapshot | undefined {
    const held = this.bestPlate.get(trackId)
    if (held === undefined) return undefined
    return { text: held.text, score: held.score, readCount: held.reads.length }
  }

  /**
   * D683 §6.3: a fused vehicle's plate reads vote TOGETHER — both pieces'
   * reads, in timestamp order (the survivor's earlier reads first, the
   * absorbed piece's later ones after), capped at {@link MAX_VOTING_READS}
   * keeping the NEWEST when over. The crop/geometry anchor (`text`, `score`,
   * `bbox`, `timestamp`, dims, padding, crop) comes from whichever piece's
   * held read scored higher — the sharpest picture, not necessarily the
   * survivor's.
   *
   * Deliberate (review L6): the reads are concatenated survivor-then-absorbed
   * rather than re-sorted by timestamp — the two are the same order because L2
   * only fuses pieces that do not overlap in time. A linker that ever fuses
   * overlapping pieces must sort here.
   */
  adoptTrack(_deviceId: number, survivorId: string, absorbedId: string): void {
    const a = this.bestPlate.get(survivorId)
    const b = this.bestPlate.get(absorbedId)
    if (b !== undefined) {
      const merged = [...(a?.reads ?? []), ...b.reads]
      const reads =
        merged.length > MAX_VOTING_READS ? merged.slice(merged.length - MAX_VOTING_READS) : merged
      const anchor = a === undefined || b.score > a.score ? b : a
      this.bestPlate.set(survivorId, { ...anchor, reads })
    }
    this.bestPlate.delete(absorbedId)
  }

  /**
   * Persist the held best plate for a finished track as one PlateStore row
   * (crop → MediaStore under ownerKind 'plate'), then drop in-memory state.
   *
   * @param subjectPath the closing track's position trail, supplied by the
   * closer. It is what tells a parked car (whose plate rect is still honest
   * seconds later) from a crossing one (whose rect points at the road it has
   * already left) — the distinction the pure time bound could not make.
   */
  async onTrackEnd(
    deviceId: number,
    trackId: string,
    subjectPath?: readonly SubjectPathSample[],
  ): Promise<void> {
    const held = this.bestPlate.get(trackId)
    this.bestPlate.delete(trackId)
    if (held === undefined) return

    const plateId = `plate-${trackId}`
    // Resolved BEFORE the put so it can double as the durable last-resort crop
    // source (the id is dropped from the caller's map only after onTrackEnd's
    // synchronous prefix — see sweepExpiredTracks ordering).
    const keyFrameMediaId = this.deps.getKeyFrameMediaId?.(trackId)

    // DURABLE last-resort: the live gallery-crop capture (observeRead) missed every
    // tier — cross-node frame eviction before the async detail read routed back.
    // Cut the plate ROI out of the persisted native keyFrame instead (temporally
    // guarded). Honest native image; never upscaled, never wrong-scene.
    let cropData = held.crop
    if (
      cropData === undefined &&
      keyFrameMediaId !== undefined &&
      this.deps.deriveCropFromKeyFrame
    ) {
      try {
        const derived = await this.deps.deriveCropFromKeyFrame({
          deviceId,
          mediaId: keyFrameMediaId,
          bbox: held.bbox,
          frameWidth: held.frameWidth,
          frameHeight: held.frameHeight,
          padding: held.cropPadding,
          // The OCR read's instant — the moment the rectangle was measured.
          timestamp: held.timestamp,
          ...(subjectPath !== undefined ? { subjectPath } : {}),
        })
        if (derived) {
          cropData = derived.jpeg
          this.deps.logger.info('plate crop recovered from keyFrame (live capture missed)', {
            tags: { deviceId, trackId },
            meta: {
              plateId,
              skewMs: derived.skewMs,
              // Which bound admitted the cross-time cut: `agrees` = the trail
              // proved the vehicle stood still, `unknown` = no trail evidence
              // and the temporal bound carried it alone.
              motion: derived.motion,
              subjectIou: derived.subjectIou ?? null,
            },
          })
        } else {
          // A refused derive means the plate row persists with NO image. That
          // is a visible hole in the gallery, so it is never silent — and the
          // refusal's own reason line (motion vs skew) is already written by
          // the derive, tagged with the same deviceId.
          this.deps.logger.info('plate crop not recovered — keyFrame derive refused or missed', {
            tags: { deviceId, trackId },
            meta: { plateId },
          })
        }
      } catch (err) {
        this.deps.logger.debug('PlateRecognizer keyFrame crop derive failed', {
          tags: { deviceId },
          meta: { plateId, error: String(err) },
        })
      }
    }

    let mediaId: number | undefined
    if (cropData !== undefined) {
      try {
        mediaId = await this.deps.mediaStore.put({
          deviceId,
          ownerKind: 'plate',
          ownerId: plateId,
          kind: 'crop',
          timestamp: held.timestamp,
          data: cropData,
        })
      } catch (err) {
        this.deps.logger.warn('PlateRecognizer plate crop put failed', {
          tags: { deviceId },
          meta: { plateId, error: String(err) },
        })
      }
    }
    // The stored text is the per-character VOTE over the track's reads — not
    // the max-score read. A vote that comes back implausible (too short, no
    // digit/letter mix) falls back to the max-score read rather than storing
    // something no read actually said.
    const voted = votePlateText(held.reads)
    const text =
      voted.length > 0 && isPlausiblePlateRead(voted, held.score)
        ? voted
        : normalizePlate(held.text)
    const match = this.matchVehicle(text, held.score)
    try {
      await this.deps.plateStore.insert({
        id: plateId,
        deviceId,
        trackId,
        timestamp: held.timestamp,
        text,
        score: held.score,
        ...(mediaId !== undefined ? { mediaId } : {}),
        corrected: false,
        assigned: false,
        ...(match !== null ? { recognizedVehicleId: match.vehicleId } : {}),
        ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
        plateBbox: held.bbox,
      })
      this.deps.emitPlateGalleryChanged?.({
        deviceId,
        plateId,
        kind: 'buffered',
      })
      // The reads themselves are logged, not just the winner: intra-track
      // concordance ("how many of the 5 reads agreed?") is the only cheap
      // measure of whether this camera's plate pixels are good enough, and it
      // was invisible while only the argmax survived to the log.
      this.deps.logger.info('plate: buffered to gallery', {
        tags: { deviceId, trackId },
        meta: {
          plateId,
          text,
          bestRead: normalizePlate(held.text),
          reads: held.reads.map((r) => `${normalizePlate(r.text)}@${r.score.toFixed(2)}`),
          votedFromReads: held.reads.length,
          score: held.score,
          hasCrop: mediaId !== undefined,
          recognizedVehicleId: match?.vehicleId ?? null,
        },
      })
    } catch (err) {
      this.deps.logger.warn('PlateRecognizer plateStore insert failed', {
        tags: { deviceId },
        meta: { plateId, error: String(err) },
      })
    }
  }
}
