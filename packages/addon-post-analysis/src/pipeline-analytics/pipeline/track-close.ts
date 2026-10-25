/**
 * `TrackCloser` — the PER-TRACK close-path orchestration (refactor S2, spec
 * `2026-07-22-post-analysis-maintainability-refactor-design.md`).
 *
 * Extracts the `sweepExpiredTracks` loop body out of the addon god class into a
 * deps-injected, unit-testable module. The addon keeps only the interval; the
 * single-flight sweep latch lives HERE (the ONE latch — the observed live
 * "sweep ×20 concurrent" failure mode is asserted by a unit test now).
 *
 * The close sequence is preserved EXACTLY as it ran inline (spec A2/A3 — no
 * behavior change):
 *  1. media `listByOwner` → `decideZeroMediaPolicy`
 *     - `suppress`       → recognizer ends (deferred keyFrame-key drop) →
 *                          `residents.close('suppress')` → dispatcher/overlay
 *                          teardown → cascade delete (row + events + media)
 *     - `raster-fallback`→ commit the retained detection-raster crop as the
 *                          track's `thumbnail`, then the normal end flow
 *  2. `decideLastFramePromotion` → `promoteToLastFrame` (genuinely-last view)
 *  3. 'track ended' log
 *  4. face/plate `onTrackEnd` with the Design-B DEFERRED keyFrame-key drop:
 *     the key is captured BEFORE the recognizers start, stays readable (the
 *     residents' deferred park) until the face promise settles, and only then
 *     drops — the recognizer rows link the SAME single native key frame.
 *  5. importance scoring (`peakForTrack` + `computeStaticTrackMetrics` +
 *     `computeImportance` + `setImportance` on BOTH stores) — best-effort.
 *  6. `residents.close('end')` (the ONE S1 litany), dispatcher/overlay
 *     teardown, media-capture-log window flush on the device's LAST track.
 *  7. the thin `TrackEnded` event + the unified lifecycle `end` event, both
 *     via injected emitters.
 *
 * Error semantics preserved: an error thrown by one track's close aborts the
 * remainder of THAT sweep (caught + debug-logged by `sweep`); the inner
 * raster-put / promotion / importance / cascade failures stay best-effort with
 * their own catch + debug log, exactly as before.
 */

import type {
  IScopedLogger,
  MediaFileBytes,
  PipelineAnalyticsTrackLifecyclePayload,
  Track,
  TrackEnvelope,
} from '@camstack/types'
import type { MediaCaptureAggregate } from '../media-capture-log.js'
import type { EventOwnedMediaIds } from '../store/event-store.js'
import { type MediaProvenance, mediaProvenanceRank } from '../store/media-store.js'
import { computeTrackEnvelope } from '../store/zone-geometry.js'
import { buildTrackLifecyclePayload } from '../track-lifecycle.js'
import { decideZeroMediaPolicy } from '../zero-media-policy.js'
import { cascadeDeleteTrack, type TrackScopedStore } from './delete-track-cascade.js'
import { computeImportance } from './key-event-scoring.js'
import type { KeyFrameCropMotionVerdict } from './keyframe-crop.js'
import { displayLabel } from './label-tier.js'
import { decideLastFramePromotion } from './last-frame-promotion.js'
import { decideFirstLastFrameOrder } from './first-last-frame-order.js'
import type { PendingPreviewUpgrade } from './preview-upgrade.js'
import { computeStaticTrackMetrics } from './static-track-gate.js'
import type { SubjectPathSample } from './subject-agreement.js'
import type { SweptTrack } from './tracker-sweep.js'
import type { TrackResidentState } from './track-resident-state.js'

/**
 * The only fields the parked probe may read.
 *
 * NOT `Track`. The store calls this predicate with its own in-flight
 * `MutableTrackState`, which keeps `audioLabels` as a `Map` for aggregation
 * while the published `Track` carries the flattened array — two genuinely
 * different shapes, and tsc had been reporting the mismatch on every call.
 * Narrowing to what the probe actually reads fixes it without a cast and
 * states the contract: a parked check looks at where the box IS, never at
 * what the track accumulated.
 */
export type ParkedProbeTrack = Pick<Track, 'positions' | 'className' | 'deviceId'>

/** Track-store surface the close path touches. `deletePersisted` is the
 *  cascade's root delete (see `delete-track-cascade.ts` — root LAST). */
export interface TrackCloseTrackStore {
  expireStale(
    nowMs: number,
    opts?: {
      readonly isKnownParked?: (track: ParkedProbeTrack) => boolean
      readonly onDiscard?: (track: Track) => void
      readonly canClose?: (track: SweptTrack) => boolean
      readonly canCloseReason?: (track: SweptTrack) => 'live' | 'tail-not-final' | undefined
      readonly maxMissedMsOf?: (track: SweptTrack) => number
      readonly beforePersist?: (track: Track) => Promise<void>
    },
  ): Promise<readonly Track[]>
  getActive(deviceId: number): readonly Track[]
  setImportance(
    trackId: string,
    importance: number,
    reason: string,
    bestEventId?: string,
  ): Promise<void>
  deletePersisted(trackId: string): Promise<void>
}

/** A stored media row as the close path reads it: the stored shape `MediaFileBytes` plus
 *  the store-internal thumbnail provenance (D276). */
export type TrackCloseMediaRow = MediaFileBytes & { readonly provenance?: MediaProvenance }

/** A close-time `thumbnail`/`thumbnailSmall` commit input — used by the
 *  zero-media raster fallback AND the keyFrame-derived thumbnail fallback.
 *  Every close-time write STATES its provenance (D276): `raster` for the
 *  detection-raster fallback, `native` for the keyFrame derive. */
export interface TrackCloseRasterPut {
  readonly deviceId: number
  readonly ownerKind: 'track'
  readonly ownerId: string
  readonly kind: 'thumbnail' | 'thumbnailSmall'
  readonly timestamp: number
  readonly data: Buffer
  readonly provenance: MediaProvenance
}

/** Input of the injected close-time keyFrame→thumbnail derive (the crop of the
 *  best-seen subject bbox out of the persisted native `keyFrame`). */
export interface TrackCloseKeyFrameThumbnailInput {
  /** Owning device — the derive's refusal lines are asked per-camera. */
  readonly deviceId: number
  /** Media id (D482) of the track's persisted native `keyFrame`. */
  readonly mediaId: number
  /** Best-seen subject bbox, in ITS detection frame's pixel space. */
  readonly bbox: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
  readonly frameWidth: number
  readonly frameHeight: number
  /**
   * The instant the best-seen bbox was MEASURED (ms) — never the keyFrame's
   * own timestamp.
   *
   * It WAS the keyFrame's timestamp between 2026-08-24 and this
   * fix, which made the guard compare the keyFrame with itself: `skewMs` 0 by
   * construction, no cross-time cut refusable, and `ba12ed7b` closed with a
   * thumbnail of pavement and parked cars because the person's best-seen box
   * was from +5.8 s. The 20da3195 case that motivated that change (a good
   * keyFrame refused for pure clock skew) is answered by the MOTION guard —
   * a subject that stood still agrees across any skew — not by handing the
   * temporal guard a pair of identical instants.
   */
  readonly timestamp: number
  /** The track's position trail, so the derive can ask whether the subject
   *  actually stayed put between the two instants. */
  readonly subjectPath: readonly SubjectPathSample[]
}

/** Result of the injected keyFrame→thumbnail derive: BOTH persisted variants
 *  (the native 16:9 window + its 480 fast-load downscale) or `null` on any
 *  miss (no media, subject moved, temporal skew, decode failure). */
export interface TrackCloseKeyFrameThumbnail {
  readonly thumbnail: Buffer
  readonly thumbnailSmall: Buffer
  readonly skewMs: number
  /** Whether the position trail PROVED the subject stood still across the skew
   *  (`agrees`) or carried no evidence and the temporal bound alone let the
   *  crop through (`unknown`). Optional for version-skew/test callers. */
  readonly motion?: KeyFrameCropMotionVerdict
  readonly subjectIou?: number
}

/**
 * WHY a closing track ended without a `thumbnail`. Each value is a distinct
 * branch of the close-time derive and a distinct fix:
 *
 *  - `derive-not-wired` — a version-skew build with no derive closure at all.
 *  - `no-key-frame` — nothing native was ever persisted for this track, so
 *    there is nothing to cut a preview from. The upstream problem is the
 *    keyFrame capture, not this fallback.
 *  - `no-best-seen-bbox` — a keyFrame exists but no subject box was ever
 *    recorded, so any crop would be a guess.
 *  - `derive-returned-null` — temporal skew or a decode failure in the derive.
 *  - `no-media-store` — shutting down mid-close.
 *  - `derive-threw` — the derive itself failed; the error rides the same line.
 */
export type TrackCloseThumbnailMissReason =
  | 'derive-not-wired'
  | 'no-key-frame'
  | 'no-best-seen-bbox'
  | 'derive-returned-null'
  | 'no-media-store'
  | 'derive-threw'

/** What the close-time derive did: landed a native tile, or WHY not — the
 *  reason feeds the persisted `previewMissReason` (D276/B2). */
export interface TrackCloseThumbnailDeriveOutcome {
  readonly landed: boolean
  readonly missReason?: TrackCloseThumbnailMissReason
}

/** The close-time lastFrame promotion input (genuinely-last view). */
export interface TrackClosePromotionInput {
  readonly deviceId: number
  readonly trackId: string
  readonly snapshot: MediaFileBytes
  /**
   * `true` = COPY the snapshot's bytes into the empty `lastFrame` slot and
   * leave the source row serving its own kind; `false`/absent = move, deleting
   * the source (`MediaStore.promoteToLastFrame` → `deleteByKey`).
   *
   * The short-track `keyFrameSmall` fallback needs the copy. This interface is
   * the structural mirror of the real media store and had fallen behind it —
   * the field existed and was honoured at runtime, so the only symptom was a
   * `tsc` error on the caller.
   */
  readonly keepSource?: boolean
}

/**
 * The close-time first/last ORDERING repair input. The two rows exchange bytes
 * and instants; see `first-last-frame-order.ts` for why a swap and not a
 * delete.
 */
export interface TrackCloseFrameSwapInput {
  readonly deviceId: number
  readonly trackId: string
  /** The row currently in the `firstFrame` slot — the NEWER bytes. */
  readonly firstFrame: MediaFileBytes
  /** The row currently in the `lastFrame` slot — the OLDER bytes. */
  readonly lastFrame: MediaFileBytes
}

/** Media-store surface the close path touches (incl. the cascade legs). */
export interface TrackCloseMediaStore {
  listByOwner(ownerKind: 'track', ownerId: string): Promise<readonly TrackCloseMediaRow[]>
  put(params: TrackCloseRasterPut): Promise<number>
  promoteToLastFrame(input: TrackClosePromotionInput): Promise<number>
  swapFirstAndLastFrame(input: TrackCloseFrameSwapInput): Promise<void>
  deleteForEvents(ids: EventOwnedMediaIds): Promise<number>
  deleteForTracks(ids: readonly string[]): Promise<number>
}

/** The importance peak summary read off the event store at close. */
export interface TrackClosePeakSummary {
  readonly peakConfidence: number
  readonly peakBboxAreaFrac: number
  readonly bestEventId: string | undefined
}

/** Event-store surface the close path touches (incl. the cascade leg). */
export interface TrackCloseEventStore {
  peakForTrack(trackId: string): Promise<TrackClosePeakSummary>
  setImportanceForTrack(trackId: string, importance: number): Promise<number>
  deleteByTrack(trackId: string): Promise<readonly string[]>
}

/** Face/plate recognizer end hook (reads the keyFrame key — Design B). */
export interface TrackEndRecognizer {
  /**
   * @param subjectPath the closing track's position trail. The plate
   * recognizer's durable keyFrame crop cuts a rectangle measured at the OCR
   * read out of pixels captured at another instant, and this is the only
   * moment the trail is still reachable — `expireStale` has already removed
   * the track from the live map, so nothing downstream can look it up.
   * Optional: a caller that omits it leaves the temporal bound in charge.
   */
  onTrackEnd(
    deviceId: number,
    trackId: string,
    subjectPath?: readonly SubjectPathSample[],
  ): Promise<void>
  /**
   * Peak recognition MATCH confidence for the track's label (identity cosine /
   * plate OCR score), read synchronously at close BEFORE `onTrackEnd` drops the
   * per-track state. Optional (version-skew / test callers omit it); absent or
   * undefined ⇒ the track carries no recognized label from this recognizer.
   */
  bestLabelMatchConfidence?(trackId: string): number | undefined
}

/** Detail dispatcher / overlay-state per-track teardown hook. */
export interface TrackEndObserver {
  onTrackEnded(deviceId: number, trackId: string): void
}

/** Windowed media-capture diagnostic aggregator (flush-on-last-track). */
export interface TrackCloseCaptureLog {
  flush(deviceId: number, nowMs: number): MediaCaptureAggregate | null
}

/** Last-seen detection-frame dimensions for a device (static-object gate). */
export interface TrackCloseFrameDims {
  readonly w: number
  readonly h: number
}

/** Payload of the thin `TrackEnded` event (emitter-injected;
 *  the envelope/category stays with the addon's event bus wiring). */
export interface TrackEndedAliasData {
  readonly deviceId: number
  readonly trackId: string
  readonly className: string
  readonly durationMs: number
}

/**
 * Injected dependencies. Nullable collaborators (stores, recognizers, the
 * detail dispatcher — all `null` until the addon's `onInitialize` finishes)
 * are injected as GETTERS so the closer always sees the live reference and
 * preserves the original optional-chaining semantics.
 */
export interface TrackCloserDeps {
  readonly logger: IScopedLogger
  readonly residents: TrackResidentState
  readonly trackStore: () => TrackCloseTrackStore | null
  readonly mediaStore: () => TrackCloseMediaStore | null
  readonly eventStore: () => TrackCloseEventStore | null
  readonly faceRecognizer: () => TrackEndRecognizer | null
  readonly plateRecognizer: () => TrackEndRecognizer | null
  readonly detailDispatcher: () => TrackEndObserver | null
  readonly overlayState: TrackEndObserver
  readonly mediaCaptureLog: TrackCloseCaptureLog
  readonly frameDims: (deviceId: number) => TrackCloseFrameDims | undefined
  readonly isShuttingDown: () => boolean
  readonly emitTrackEnded: (data: TrackEndedAliasData, timestampMs: number) => void
  readonly emitTrackLifecycle: (
    payload: PipelineAnalyticsTrackLifecyclePayload,
    timestampMs: number,
  ) => void
  /**
   * Notification Center track-end hook (D-3): fired ONCE per REAL track
   * close, after the full close litany (never on the zero-media suppress
   * path). Injected and optional so the closer stays dumb about rules;
   * the callee owns its own error handling. `ownedMedia` is the media set
   * fetched at close entry; `info.bestConfidence` is the tracker peak.
   */
  readonly onTrackClosed?: (
    track: Track,
    ownedMedia: readonly MediaFileBytes[],
    info: {
      readonly bestConfidence?: number
      readonly importance?: number
      /** Best identity/plate recognition match confidence at close (max of the
       *  face + plate recognizers). Absent ⇒ the track ended un-recognized. */
      readonly labelConfidence?: number
      /** Normalized 0..1 trajectory envelope computed at close from the live
       *  `positions` + frame dims. The `Track` clone carries NO `envelope` on
       *  the close path (it lands only on persisted-row projections), so a
       *  live `track-end` `customZones` rule needs this threaded value to have
       *  a subject bbox. Absent ⇒ frame dims were unknown at close. */
      readonly envelope?: TrackEnvelope
    },
  ) => void
  /**
   * Close-time keyFrame→thumbnail derive (#27-A degenerate-retry fix, part 3):
   * when a track closes with NO persisted `thumbnail` but a durable native
   * `keyFrame` (the retry gate suppressed every implausible sliver retry, or
   * every live capture missed), cut the best-seen subject region out of the
   * persisted keyFrame with the standard 16:9 central-square framing so the
   * track STILL gets a real subject tile. Optional (version-skew/test callers)
   * and best-effort — a failure never blocks the close litany.
   */
  readonly deriveThumbnailFromKeyFrame?: (
    input: TrackCloseKeyFrameThumbnailInput,
  ) => Promise<TrackCloseKeyFrameThumbnail | null>
  /**
   * Last capture-failure note the residents hold for a track (D276/B2):
   * `<kind>:<cause>` and how often. Read at close, BEFORE `residents.close`
   * drops the record, so the persisted miss reason can distinguish a dead
   * lease from a shed queue.
   */
  readonly previewCaptureMiss?: (trackId: string) => TrackClosePreviewCaptureMiss | undefined
  /**
   * Register a closed track still owed a native tile (D276): the late
   * keyFrame exec redeems it through `runPreviewUpgrade`. Optional —
   * version-skew/test callers simply never upgrade.
   */
  readonly recordPendingPreviewUpgrade?: (entry: PendingPreviewUpgrade) => void
  /**
   * Persist WHY the track ended without a native tile on the track row
   * (`previewMissReason`, D276/B2) — `null` clears it. The operator asked to
   * understand the misses per track; a log line that scrolls away is not
   * that. Optional and best-effort: a failed write never blocks the close.
   */
  readonly setPreviewMiss?: (
    deviceId: number,
    trackId: string,
    reason: string | null,
  ) => Promise<void>
  /**
   * Close-time parked-box probe: a track whose last bbox matches a live
   * stationary registry entry is stamped `stationary-promotion` even when it
   * lived past the short-motionless window. Optional so tests/version-skew
   * callers keep the previous TTL behaviour.
   */
  readonly isKnownParked?: (track: ParkedProbeTrack) => boolean
  /**
   * Cascade what the tracks `expireStale` DISCARDED wrote while they lived
   * (D547): media, events, crops, vector. Without it a discarded track's media
   * would be exactly the orphan D161 measured — so a closer built without this
   * hook keeps persisting instead (see `sweep`), and says so once.
   */
  readonly discardTracks?: (tracks: readonly Track[]) => Promise<void>
  /**
   * D683 §6.4 (review C2/M2): a row closes only when the TRACKER says its
   * chain is not live and its tail is final — asked through the ONE
   * production gate, `TrackerSweep.canClose`, in the processor's OWN frame
   * clock (`index.ts`: `(t) => this.trackerSweep.canClose(t, Date.now())`).
   * Optional so a version-skew/test closer keeps the previous
   * every-TTL-expired-row-closes behaviour.
   */
  readonly canClose?: (track: SweptTrack) => boolean
  /** D683 review M2: see `TrackStore.expireStale`'s own doc. */
  readonly canCloseReason?: (track: SweptTrack) => 'live' | 'tail-not-final' | undefined
  /** D683 review N5: see `TrackStore.expireStale`'s own doc. */
  readonly maxMissedMsOf?: (track: SweptTrack) => number
  /**
   * D683 (review H2): the alias leg + its widener, for the zero-media
   * suppression cascade (`suppressZeroMedia` → `cascadeDeleteTrack`) — the
   * one production cascade path this closer runs directly rather than
   * through `index.ts`'s shared `buildTrackCascadeRegistry`. Absent ⇒ no
   * alias collection bound (version-skew/test callers).
   */
  readonly aliasStore?: () => TrackScopedStore | null
  readonly expandLeafIds?: (ids: readonly string[]) => Promise<readonly string[]>
  /**
   * D683 Task 18 (review 2 L7): awaited per closing track right before
   * `expireStale` persists its row — the fusion service's sweep-up
   * (`index.ts`: `(t) => this.trackFusion.sweepUp(t.deviceId, t.trackId)`).
   * Optional so a version-skew/test closer keeps the previous behaviour.
   */
  readonly beforePersist?: (track: Track) => Promise<void>
  /** Clock override for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/** The capture-miss note as the residents hold it (see `notePreviewCaptureMiss`). */
export interface TrackClosePreviewCaptureMiss {
  readonly reason: string
  readonly count: number
}

/** What the close path left as the track's tile, for the miss record. */
export type TrackCloseTileProvenance = 'native' | 'raster' | 'standin' | 'none'

/**
 * Compose the persisted `previewMissReason` (D276/B2, extended by D400). One
 * line, greppable tokens: the derive's own miss branch (or what tile stands
 * in), then whether the NATIVE KEY FRAME landed, then the capture-side failure
 * with its count. Examples:
 *   `no-key-frame no-key-frame-at-close capture=keyframe:native-missx4`
 *   `derive-returned-null tile=standin`
 *   `native-tile tile=native no-key-frame-at-close`
 *
 * **Why the key-frame token (D400).** The reason used to be written ONLY when
 * the best-shot TILE ranked below native, so a track whose thumbnail landed
 * natively while its key frame missed carried no reason at all — three of the
 * four `MISSING_KEYFRAME` tracks in the 2026-09-07 audit were exactly that, and
 * the operator's "niente ultimo" had no cause anywhere on the row. The key
 * frame IS the native best-shot FRAME, and its absence is the head of the
 * cascade (`keyFrame ⇒ keyFrameSmall ⇒ the lastFrame copy source`), so it
 * belongs on this line whatever the tile ended up being.
 */
export function composePreviewMissReason(
  tile: TrackCloseTileProvenance,
  deriveMiss: TrackCloseThumbnailMissReason | undefined,
  captureMiss: TrackClosePreviewCaptureMiss | undefined,
  keyFrameLanded = true,
): string {
  const parts: string[] = []
  parts.push(deriveMiss ?? (tile === 'none' ? 'no-thumbnail' : `${tile}-tile`))
  if (tile !== 'none') parts.push(`tile=${tile}`)
  // Not repeated when the derive branch already said it — one line, one token
  // per fact.
  if (!keyFrameLanded && deriveMiss !== 'no-key-frame') parts.push('no-key-frame-at-close')
  if (captureMiss !== undefined) parts.push(`capture=${captureMiss.reason}x${captureMiss.count}`)
  return parts.join(' ')
}

/** Final importance numbers carried into the lifecycle `end` payload. */
interface EndImportanceSummary {
  readonly importance?: number
  readonly reason?: string
  readonly bestEventId?: string
}

export class TrackCloser {
  /**
   * Reentrancy latch — one sweep at a time (THE single latch, S2). The sweep
   * runs on a fixed interval but its body awaits (media listByOwner, native
   * promotions, importance queries). When one sweep stalled past the interval
   * — e.g. on a hung native-crop RPC — every queued tick started ANOTHER sweep
   * over the SAME expired rows, and one track's close was processed ~20× in
   * parallel (duplicate 'track ended' events, importance writes, face/plate
   * onTrackEnd — observed live 2026-07-22 on track d4dc1209). A skipped tick
   * is harmless (the next one picks the rows up).
   */
  private sweepInFlight = false
  private readonly now: () => number

  constructor(private readonly deps: TrackCloserDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * One TTL sweep: expire stale active tracks and run the full close sequence
   * on each. Single-flight — a call while a sweep is in progress returns
   * immediately. An error in one track's close aborts the remainder of the
   * sweep (debug-logged unless shutting down), matching the legacy inline
   * try/catch envelope.
   */
  async sweep(): Promise<void> {
    if (this.sweepInFlight) return
    this.sweepInFlight = true
    try {
      const trackStore = this.deps.trackStore()
      if (!trackStore) return
      const discarded: Track[] = []
      const discardTracks = this.deps.discardTracks
      const expired = await trackStore.expireStale(this.now(), {
        ...(this.deps.isKnownParked !== undefined
          ? { isKnownParked: this.deps.isKnownParked }
          : {}),
        // Only a closer that can cascade may discard: a discarded track whose
        // media nobody deletes is the D161 orphan, and the store must not be
        // asked to create one.
        ...(discardTracks !== undefined
          ? {
              onDiscard: (t: Track) => {
                discarded.push(t)
              },
            }
          : {}),
        ...(this.deps.canClose !== undefined ? { canClose: this.deps.canClose } : {}),
        ...(this.deps.canCloseReason !== undefined
          ? { canCloseReason: this.deps.canCloseReason }
          : {}),
        ...(this.deps.maxMissedMsOf !== undefined
          ? { maxMissedMsOf: this.deps.maxMissedMsOf }
          : {}),
        ...(this.deps.beforePersist !== undefined
          ? { beforePersist: this.deps.beforePersist }
          : {}),
      })
      for (const t of expired) {
        await this.closeExpired(t)
      }
      if (discardTracks !== undefined && discarded.length > 0) {
        await discardTracks(discarded)
      }
    } catch (err) {
      if (this.deps.isShuttingDown()) return
      this.deps.logger.debug('sweepExpiredTracks failed', {
        meta: { error: String(err) },
      })
    } finally {
      this.sweepInFlight = false
    }
  }

  /**
   * The FULL per-track close sequence for one expired track (see the module
   * docstring for the exact preserved ordering).
   */
  async closeExpired(t: Track): Promise<void> {
    const duration = t.lastSeen - t.firstSeen
    // Zero-media track policy (spec §"Zero-media track policy"): a track that
    // ends with NO persisted media is either false-birth noise to SUPPRESS
    // (ultra-short + never confirmed) or a real track kept with a last-resort
    // detection-raster preview. `expireStale` already wrote the row; suppress
    // undoes it (cascade delete) so there is no dangling list row/media/event.
    const closure = this.deps.residents.closure(t.trackId)
    const ownedMedia = (await this.deps.mediaStore()?.listByOwner('track', t.trackId)) ?? []
    // A `keyFrame` counts as a best shot even with no thumbnail yet: the
    // keyFrame-derived tile below turns it into one, and it is native-resolution
    // so it must always win over the raster crop.
    const hasBestMedia = ownedMedia.some((m) => m.kind === 'thumbnail' || m.kind === 'keyFrame')
    const outcome = decideZeroMediaPolicy({
      durationMs: duration,
      hasMedia: ownedMedia.length > 0,
      hasBestMedia,
      confirmed: closure?.confirmed ?? false,
      hasRasterFallback: closure?.rasterFallback !== undefined,
    })
    if (outcome === 'suppress') {
      this.deps.logger.info('track suppressed (zero-media false birth)', {
        tags: { deviceId: t.deviceId },
        meta: {
          trackId: t.trackId,
          className: t.className,
          durationMs: duration,
          positions: t.positions.length,
        },
      })
      await this.suppressZeroMedia(t.deviceId, t.trackId)
      return
    }
    // A keyFrame counts as `hasBestMedia`, so the zero-media policy skips
    // raster-fallback even when a detection-raster crop was retained. Derive
    // first (native); if that also misses, spend the raster so the gallery
    // never has to paint the raw keyFrame as a tile.
    //
    // D276: "landed" means a NATIVE-ranked tile. A stored `thumbnail` whose
    // provenance ranks below `native` (a face-crop stand-in, a raster crop) is
    // an IOU, not a best shot — the derive below may replace it, and only a
    // rank-native tile (or a legacy NULL row, which ranks native) is final.
    const storedThumb = ownedMedia.find((m) => m.kind === 'thumbnail')
    const storedThumbRank =
      storedThumb === undefined ? undefined : mediaProvenanceRank(storedThumb.provenance)
    let tile: TrackCloseTileProvenance =
      storedThumb === undefined ? 'none' : (storedThumb.provenance ?? 'native')
    let thumbnailLanded =
      storedThumbRank !== undefined && storedThumbRank >= mediaProvenanceRank('native')
    if (outcome === 'raster-fallback' && closure?.rasterFallback) {
      await this.commitRasterFallback(
        t,
        closure.rasterFallback.jpeg,
        closure.rasterFallback.timestamp,
      )
      thumbnailLanded = true
      tile = 'raster'
    }
    await this.maybePromoteLastFrame(t, ownedMedia)
    // AFTER the promotion, never before: the promotion is what fills an empty
    // `lastFrame` slot on a sub-interval track, and it is that copy the late
    // `firstFrame` post-dates. Ordering a pair one of whose halves does not
    // exist yet would simply find nothing to repair.
    await this.repairFirstLastFrameOrder(t)
    // #27-A part 3: a track that never landed a plausible best `thumbnail`
    // (cold-lease misses + the degenerate-retry gate) but owns a durable native
    // keyFrame still gets a real subject tile, derived from that keyFrame.
    // Best-effort; must run BEFORE residents.close (reads the best-seen bbox).
    const hasRasterFallback = closure?.rasterFallback !== undefined
    let deriveMiss: TrackCloseThumbnailMissReason | undefined
    if (!thumbnailLanded) {
      const derived = await this.maybeDeriveThumbnailFromKeyFrame(t, ownedMedia, hasRasterFallback)
      thumbnailLanded = derived.landed
      if (derived.landed) tile = 'native'
      deriveMiss = derived.missReason
    }
    // Spend the raster only where it IMPROVES the tile: over nothing, or over
    // a detail-crop stand-in. Never over a tile that already shows the
    // subject at raster rank or better.
    const rasterImproves =
      storedThumbRank === undefined || storedThumbRank < mediaProvenanceRank('raster')
    if (!thumbnailLanded && rasterImproves && closure?.rasterFallback) {
      await this.commitRasterFallback(
        t,
        closure.rasterFallback.jpeg,
        closure.rasterFallback.timestamp,
      )
      tile = 'raster'
    }
    // D276/B2: a close that leaves anything but a native tile records WHY on
    // the track row (readable, not a scrolled-away log line) and registers the
    // track for the late-keyFrame upgrade. Both read resident state, so this
    // stays BEFORE `residents.close`.
    // D400: ALSO when the tile landed native but the key frame did not. A
    // track with a picture and no key frame still lost its lastFrame (no
    // `keyFrameSmall` to copy) and is still absent from every rebuild — a row
    // with no reason on it is unanswerable, and that was 3 of the 4 affected
    // tracks in the 2026-09-07 audit.
    const keyFrameLanded = ownedMedia.some((m) => m.kind === 'keyFrame')
    if (tile !== 'native' || !keyFrameLanded) {
      const captureMiss = this.deps.previewCaptureMiss?.(t.trackId)
      const reason = composePreviewMissReason(tile, deriveMiss, captureMiss, keyFrameLanded)
      if (this.deps.setPreviewMiss !== undefined) {
        try {
          await this.deps.setPreviewMiss(t.deviceId, t.trackId, reason)
        } catch (err) {
          this.deps.logger.warn('preview miss reason persist failed', {
            tags: { deviceId: t.deviceId },
            meta: { trackId: t.trackId, reason, error: String(err) },
          })
        }
      }
      // The late-keyFrame UPGRADE is about the TILE: a native tile has nothing
      // to upgrade to, even when the key frame is missing.
      const bestSeen = tile === 'native' ? undefined : this.deps.residents.bestSeenBbox(t.trackId)
      if (tile !== 'native')
        this.deps.recordPendingPreviewUpgrade?.({
          deviceId: t.deviceId,
          trackId: t.trackId,
          ...(bestSeen !== undefined
            ? {
                bestSeen: {
                  x: bestSeen.x,
                  y: bestSeen.y,
                  w: bestSeen.w,
                  h: bestSeen.h,
                  frameWidth: bestSeen.frameWidth,
                  frameHeight: bestSeen.frameHeight,
                  // The box's OWN instant travels with it, or the late redeem
                  // has nothing to bound its cross-time cut against.
                  timestamp: bestSeen.timestamp,
                },
              }
            : {}),
          recordedAtMs: this.now(),
        })
    }
    this.deps.logger.info('track ended', {
      tags: { deviceId: t.deviceId },
      meta: {
        trackId: t.trackId,
        className: t.className,
        durationMs: duration,
        positions: t.positions.length,
      },
    })
    // Face onTrackEnd reads the track's key-frame media id (design B); drop it
    // only AFTER that fire-and-forget write settles so the link isn't lost.
    // Capture the id BEFORE the (possibly synchronous) drop so the `end`
    // lifecycle payload below still carries the track's best image.
    const keyFrameMediaId = this.deps.residents.keyFrameMediaId(t.trackId)
    // NC `minLabelConfidence` seam: capture the best face/plate recognition
    // match confidence BEFORE `fireRecognizerEnds` drops the per-track state.
    const labelConfidence = this.bestLabelMatchConfidence(t.deviceId, t.trackId)
    this.fireRecognizerEnds(t.deviceId, t.trackId, t.positions)
    // Final summary numbers carried into the `end` lifecycle event.
    const trackerPeak = this.deps.residents.bestFramePeak(t.trackId)
    const importanceSummary = await this.scoreImportance(t, duration, trackerPeak?.confidence)
    // ONE close runs the FULL per-track litany (S1); the keyFrame key is
    // parked for the deferred drop wired above until faceEnd settles.
    this.deps.residents.close(t.trackId, 'end')
    // Two-plane detail scheduling: drop the track's scheduler + queued state.
    this.deps.detailDispatcher()?.onTrackEnded(t.deviceId, t.trackId)
    this.deps.overlayState.onTrackEnded(t.deviceId, t.trackId)
    // Last live track on the device → drain the pending media-capture
    // aggregate so short activity bursts still surface one info line.
    this.flushCaptureWindowIfIdle(t.deviceId)
    this.emitEndEvents(t, duration, trackerPeak?.confidence, keyFrameMediaId, importanceSummary)
    // Notification Center hook — LAST, after the row/media/importance are
    // final, so track-end rules evaluate the completed record (D-2/D-3).
    // The `Track` clone `t` was captured by `expireStale` BEFORE
    // `scoreImportance`→`setImportance` ran, so it never carries the value
    // scored this close. Thread the freshly-computed importance explicitly so
    // track-end rules (`minImportance`) evaluate the real number.
    //
    // Same clone-staleness applies to the normalized `envelope`: it is
    // computed ONLY at persist time and lands on persisted-row projections,
    // never on the live close clone. Compute it here (the SAME
    // `computeTrackEnvelope` the store persists) and thread it so a LIVE
    // `track-end` `customZones` rule gets a subject bbox instead of failing
    // closed — a silent live/dry-run divergence otherwise.
    const dims = this.deps.frameDims(t.deviceId)
    const envelope = computeTrackEnvelope(t.positions, dims?.w, dims?.h)
    this.deps.onTrackClosed?.(t, ownedMedia, {
      ...(trackerPeak?.confidence !== undefined ? { bestConfidence: trackerPeak.confidence } : {}),
      ...(importanceSummary.importance !== undefined
        ? { importance: importanceSummary.importance }
        : {}),
      ...(labelConfidence !== undefined ? { labelConfidence } : {}),
      ...(envelope !== null ? { envelope } : {}),
    })
  }

  /** Max recognition match confidence over the face + plate recognizers for a
   *  closing track (undefined when neither recognized a label). */
  private bestLabelMatchConfidence(_deviceId: number, trackId: string): number | undefined {
    const face = this.deps.faceRecognizer()?.bestLabelMatchConfidence?.(trackId)
    const plate = this.deps.plateRecognizer()?.bestLabelMatchConfidence?.(trackId)
    if (face === undefined) return plate
    if (plate === undefined) return face
    return Math.max(face, plate)
  }

  /**
   * Undo a zero-media false-birth track (spec §"Zero-media track policy"): tear
   * down its live per-track state (mirroring the natural end MINUS importance
   * scoring + the lifecycle `end`/`TrackEnded` events) and cascade-delete the
   * just-persisted row + any events/media so nothing dangles. Best-effort.
   */
  async suppressZeroMedia(deviceId: number, trackId: string): Promise<void> {
    // Recognizers still get their normal end (they read the key frame first) so
    // no per-track recognizer state leaks.
    this.fireRecognizerEnds(deviceId, trackId)
    // ONE close runs the FULL per-track litany (S1); the keyFrame key stays
    // readable until the deferred drop above settles.
    this.deps.residents.close(trackId, 'suppress')
    this.deps.detailDispatcher()?.onTrackEnded(deviceId, trackId)
    this.deps.overlayState.onTrackEnded(deviceId, trackId)
    // Cascade the persisted row + any object events/media (there is almost never
    // any media on a suppressed track — that is the premise — but events could
    // exist for a borderline case; deleting them keeps history undangled).
    const eventStore = this.deps.eventStore()
    const mediaStore = this.deps.mediaStore()
    const trackStore = this.deps.trackStore()
    if (eventStore && mediaStore && trackStore) {
      try {
        await cascadeDeleteTrack(
          { eventStore, mediaStore, trackStore, aliasStore: this.deps.aliasStore?.() ?? null },
          trackId,
          {
            ...(this.deps.expandLeafIds !== undefined
              ? { expandLeafIds: this.deps.expandLeafIds }
              : {}),
          },
        )
      } catch (err) {
        this.deps.logger.debug('zero-media suppression cascade failed', {
          tags: { deviceId },
          meta: { trackId, error: String(err) },
        })
      }
    }
  }

  /** Start face/plate `onTrackEnd` and wire the Design-B DEFERRED
   *  keyFrame-key drop (drop only once the face promise settles — or
   *  immediately when no face recognizer is active). */
  private fireRecognizerEnds(
    deviceId: number,
    trackId: string,
    subjectPath?: readonly SubjectPathSample[],
  ): void {
    const faceEnd = this.deps.faceRecognizer()?.onTrackEnd(deviceId, trackId)
    const dropKeyFrameMediaId = (): void => {
      this.deps.residents.dropKeyFrameMediaId(trackId)
    }
    if (faceEnd) void faceEnd.finally(dropKeyFrameMediaId)
    else dropKeyFrameMediaId()
    // The plate recognizer's durable keyFrame crop needs the trail to tell a
    // parked car from a crossing one; this is the last moment it exists.
    void this.deps.plateRecognizer()?.onTrackEnd(deviceId, trackId, subjectPath)
  }

  /** Last-resort preview: commit the retained detection-raster subject crop
   *  as the track's `thumbnail` (honest sub-native, never upscaled). */
  private async commitRasterFallback(t: Track, jpeg: Buffer, timestamp: number): Promise<void> {
    try {
      await this.deps.mediaStore()?.put({
        deviceId: t.deviceId,
        ownerKind: 'track',
        ownerId: t.trackId,
        kind: 'thumbnail',
        timestamp,
        data: jpeg,
        provenance: 'raster',
      })
    } catch (err) {
      this.deps.logger.debug('zero-media raster fallback put failed', {
        tags: { deviceId: t.deviceId },
        meta: { trackId: t.trackId, error: String(err) },
      })
    }
  }

  /**
   * Close-time keyFrame-derived `thumbnail` fallback (#27-A part 3): when the
   * closing track's owned media has NO `thumbnail` but HAS a native `keyFrame`,
   * derive the thumbnail (+ `thumbnailSmall`) from the persisted keyFrame,
   * cropping the BEST-seen subject bbox with the standard 16:9 central-square
   * framing (the derive is injected — `createKeyFrameCrop` composed with the
   * wide-central-square layout in the addon wiring). Best-effort with its own
   * catch: any failure leaves the track as it was and never blocks the close.
   *
   * EVERY branch that leaves the track without a thumbnail says so, at `info`,
   * with `tags: { deviceId }` and a reason. This is the LAST chance a track has
   * at a preview, and the branches used to be four bare `return`s and a `debug`
   * — so the 13.5% of tracks that end with no thumbnail produced not one line
   * and the rate could only ever be counted from the database, after the fact.
   * A branch that drops work silently reads as "never happened".
   */
  private async maybeDeriveThumbnailFromKeyFrame(
    t: Track,
    ownedMedia: readonly TrackCloseMediaRow[],
    hasRasterFallback: boolean,
  ): Promise<TrackCloseThumbnailDeriveOutcome> {
    // The healthy case first: a track already holding a NATIVE-ranked
    // thumbnail (a live capture, or a legacy NULL-provenance row) is not a
    // miss and must stay silent, or the line means nothing. A tile ranking
    // BELOW native — the face-crop stand-in, the raster crop — is exactly
    // what this derive exists to replace (D276): the stand-in was acceptable
    // only while nothing better existed, and the keyFrame is better.
    const held = ownedMedia.find((m) => m.kind === 'thumbnail')
    if (
      held !== undefined &&
      mediaProvenanceRank(held.provenance) >= mediaProvenanceRank('native')
    ) {
      return { landed: true }
    }
    const derive = this.deps.deriveThumbnailFromKeyFrame
    if (!derive) {
      if (!hasRasterFallback) this.logNoThumbnailAtClose(t, 'derive-not-wired')
      return { landed: false, missReason: 'derive-not-wired' }
    }
    const keyFrame = ownedMedia.find((m) => m.kind === 'keyFrame')
    if (!keyFrame) {
      if (!hasRasterFallback) this.logNoThumbnailAtClose(t, 'no-key-frame')
      return { landed: false, missReason: 'no-key-frame' }
    }
    const bestSeen = this.deps.residents.bestSeenBbox(t.trackId)
    if (!bestSeen) {
      if (!hasRasterFallback) this.logNoThumbnailAtClose(t, 'no-best-seen-bbox')
      return { landed: false, missReason: 'no-best-seen-bbox' }
    }
    try {
      const derived = await derive({
        deviceId: t.deviceId,
        mediaId: keyFrame.mediaId,
        bbox: { x: bestSeen.x, y: bestSeen.y, w: bestSeen.w, h: bestSeen.h },
        frameWidth: bestSeen.frameWidth,
        frameHeight: bestSeen.frameHeight,
        // The bbox's OWN instant — see TrackCloseKeyFrameThumbnailInput.timestamp.
        timestamp: bestSeen.timestamp,
        subjectPath: t.positions,
      })
      if (!derived) {
        if (!hasRasterFallback) {
          this.logNoThumbnailAtClose(t, 'derive-returned-null', {
            keyFrameMediaId: keyFrame.mediaId,
          })
        }
        return { landed: false, missReason: 'derive-returned-null' }
      }
      const mediaStore = this.deps.mediaStore()
      if (!mediaStore) {
        if (!hasRasterFallback) this.logNoThumbnailAtClose(t, 'no-media-store')
        return { landed: false, missReason: 'no-media-store' }
      }
      await mediaStore.put({
        deviceId: t.deviceId,
        ownerKind: 'track',
        ownerId: t.trackId,
        kind: 'thumbnail',
        timestamp: keyFrame.timestamp,
        data: derived.thumbnail,
        provenance: 'native',
      })
      await mediaStore.put({
        deviceId: t.deviceId,
        ownerKind: 'track',
        ownerId: t.trackId,
        kind: 'thumbnailSmall',
        timestamp: keyFrame.timestamp,
        data: derived.thumbnailSmall,
        provenance: 'native',
      })
      this.deps.logger.info('thumbnail derived from keyFrame at close (no live best-shot landed)', {
        tags: { deviceId: t.deviceId },
        meta: {
          trackId: t.trackId,
          keyFrameMediaId: keyFrame.mediaId,
          skewMs: derived.skewMs,
          // How the cross-time cut was justified: `agrees` = the trail proved
          // the subject stood still, `unknown` = temporal bound only. The
          // split is what makes the guard's regime auditable per camera
          // instead of readable only as "it stopped complaining".
          motion: derived.motion ?? null,
          subjectIou: derived.subjectIou ?? null,
          // Which below-native tile this native derive replaced, or null when
          // the track had no tile at all — the D276 upgrade made visible.
          replaced: held?.provenance ?? null,
        },
      })
      return { landed: true }
    } catch (err) {
      this.deps.logger.debug('close-time keyFrame thumbnail derive failed', {
        tags: { deviceId: t.deviceId },
        meta: { trackId: t.trackId, error: String(err) },
      })
      if (!hasRasterFallback) {
        this.logNoThumbnailAtClose(t, 'derive-threw', {
          keyFrameMediaId: keyFrame.mediaId,
          error: String(err),
        })
      }
      return { landed: false, missReason: 'derive-threw' }
    }
  }

  /**
   * The ONE line for "this track ended with no preview, and here is why".
   *
   * One message, one `reason` field, so the rate is a single Loki query and the
   * breakdown is a `sum by (reason)` rather than five differently-worded lines
   * nobody thinks to correlate. Always tagged with the device: "why is 102
   * worse than 101" is the only form this question has ever been asked in.
   */
  private logNoThumbnailAtClose(
    t: Track,
    reason: TrackCloseThumbnailMissReason,
    extra?: Readonly<Record<string, unknown>>,
  ): void {
    this.deps.logger.info('track closed with no thumbnail (last preview chance missed)', {
      tags: { deviceId: t.deviceId },
      meta: {
        trackId: t.trackId,
        className: t.className,
        reason,
        durationMs: t.lastSeen - t.firstSeen,
        ...extra,
      },
    })
  }

  /**
   * Genuinely-last view (operator, 2026-07-22): the rolling `lastFrame` never
   * fires on a `snapshot` frame and rolls on its own cadence, so at close it
   * can trail the newest appended snapshot by up to one interval. If a newer
   * snapshot exists (or there is no lastFrame but ≥1 snapshot), PROMOTE it
   * into the single lastFrame slot and drop the snapshot row — one
   * genuinely-last view, no duplicate pair. Reuses the `ownedMedia` list
   * already fetched by the caller (base64 present → no re-read).
   */
  private async maybePromoteLastFrame(
    t: Track,
    ownedMedia: readonly MediaFileBytes[],
  ): Promise<void> {
    const promotion = decideLastFramePromotion(ownedMedia)
    if (!promotion.promote) {
      // A branch that DROPS media says why (D400) — but only the branches that
      // DROP something. TWO of the three declines are healthy:
      //
      //  - `already-last`  — the held lastFrame is newer than any snapshot;
      //  - `no-source`     — no snapshot and no keyFrameSmall, and a lastFrame
      //                      IS HELD (see `decideLastFramePromotion`: the value
      //                      is only returned when `lastFrame !== undefined`).
      //
      // `no-source` used to warn "no lastFrame at close" on a track that had
      // one, and on 2026-09-08 it was the loudest line in the hub's log — every
      // instance on a camera holding a lastFrame, because a camera with the
      // filmstrip off appends no snapshots and therefore never has anything
      // newer to promote. A warning that says the opposite of the truth trains
      // the operator to skip the ones that mean something.
      //
      // `no-key-frame` is the real one: nothing at all to show for the end of
      // the track, and the cause is one level up.
      if (promotion.declinedBecause === 'no-key-frame') {
        this.deps.logger.warn('no lastFrame at close', {
          tags: { deviceId: t.deviceId },
          meta: {
            trackId: t.trackId,
            declinedBecause: promotion.declinedBecause,
            hasKeyFrame: ownedMedia.some((m) => m.kind === 'keyFrame'),
            hasKeyFrameSmall: ownedMedia.some((m) => m.kind === 'keyFrameSmall'),
            snapshots: ownedMedia.filter((m) => m.kind === 'snapshot').length,
          },
        })
      }
      return
    }
    const snapshot = ownedMedia.find((m) => m.mediaId === promotion.snapshotMediaId)
    if (!snapshot) {
      this.deps.logger.warn('no lastFrame at close', {
        tags: { deviceId: t.deviceId },
        meta: {
          trackId: t.trackId,
          declinedBecause: 'promotion-source-vanished',
          sourceMediaId: promotion.snapshotMediaId,
          mode: promotion.mode,
        },
      })
      return
    }
    try {
      await this.deps.mediaStore()?.promoteToLastFrame({
        deviceId: t.deviceId,
        trackId: t.trackId,
        snapshot,
        // 'copy' = the short-track keyFrameSmall fallback: the source row keeps
        // serving its own kind, only its bytes are copied into the empty slot.
        keepSource: promotion.mode === 'copy',
      })
    } catch (err) {
      this.deps.logger.debug('lastFrame promotion failed', {
        tags: { deviceId: t.deviceId },
        meta: { trackId: t.trackId, error: String(err) },
      })
    }
  }

  /**
   * A track's "primo" tile is never newer than its "ultimo" tile
   * (`first-last-frame-order.ts`). Filed by hand three times on device 3829,
   * 2026-09-08 — `d035f251`, `448678bb`, `7628b19d`.
   *
   * The media list is RE-READ rather than reusing the caller's `ownedMedia`:
   * `maybePromoteLastFrame` has just run and is precisely what may have put the
   * older bytes in the `lastFrame` slot, so the caller's copy predates the pair
   * being ordered here. Best-effort — a failure never blocks the close.
   */
  private async repairFirstLastFrameOrder(t: Track): Promise<void> {
    const store = this.deps.mediaStore()
    if (!store) return
    const media = await store.listByOwner('track', t.trackId)
    const decision = decideFirstLastFrameOrder(media)
    if (!decision.swap) return
    const firstFrame = media.find((m) => m.mediaId === decision.firstFrameMediaId)
    const lastFrame = media.find((m) => m.mediaId === decision.lastFrameMediaId)
    if (!firstFrame || !lastFrame) return
    try {
      await store.swapFirstAndLastFrame({
        deviceId: t.deviceId,
        trackId: t.trackId,
        firstFrame,
        lastFrame,
      })
      // The repair is LOUD on purpose. It is a symptom of a capture that
      // arrived out of order upstream, and a silent correction would hide the
      // rate at which that happens behind a tile that now looks fine.
      this.deps.logger.warn('firstFrame/lastFrame were out of order — slots swapped', {
        tags: { deviceId: t.deviceId },
        meta: {
          trackId: t.trackId,
          className: t.className,
          inversionMs: decision.inversionMs,
          firstFrameAt: decision.firstFrameTimestamp,
          lastFrameAt: decision.lastFrameTimestamp,
          /** How far the late capture ran past the track itself. Positive means
           *  it was cut from a frame the subject was no longer observed in. */
          pastTrackEndMs: decision.firstFrameTimestamp - t.lastSeen,
          durationMs: t.lastSeen - t.firstSeen,
        },
      })
    } catch (err) {
      this.deps.logger.warn('firstFrame/lastFrame order repair failed', {
        tags: { deviceId: t.deviceId },
        meta: { trackId: t.trackId, error: String(err) },
      })
    }
  }

  /**
   * Key-event importance: score the just-expired track and persist. Peak
   * confidence comes from the shared best-detection tracker; peak bbox area
   * + the winning object-event id from one indexed queryObject(trackId) —
   * no 4th "best" notion is introduced. Best-effort; a failure never blocks
   * track teardown or the TrackEnded event.
   */
  private async scoreImportance(
    t: Track,
    duration: number,
    trackerPeakConfidence: number | undefined,
  ): Promise<EndImportanceSummary> {
    try {
      const peak = await this.deps.eventStore()?.peakForTrack(t.trackId)
      if (!peak) return {}
      // Static-object gate: measure how far the track's centroid actually
      // travelled over its life, normalized to the device's frame diagonal,
      // so a stationary object read as a subject (a pile of clothes as a
      // "person") is demoted below the key-event threshold. Identified
      // tracks are never suppressed (handled inside computeImportance).
      const dims = this.deps.frameDims(t.deviceId)
      const staticMetrics = dims
        ? computeStaticTrackMetrics(
            t.positions.map((p) => ({ x: p.x, y: p.y })),
            Math.hypot(dims.w, dims.h),
          )
        : undefined
      const { importance, reason } = computeImportance({
        peakConfidence: trackerPeakConfidence ?? peak.peakConfidence,
        className: t.className,
        durationMs: duration,
        peakBboxAreaFrac: peak.peakBboxAreaFrac,
        totalDistance: t.totalDistance,
        zonesVisited: t.zonesVisited,
        // The two tiers travel SEPARATELY (2026-08-20). `label` is the display
        // caption and feeds the identity WEIGHT; `identityLabel` is tier 2 only
        // and is the ONLY thing that exempts a motionless track from the static
        // gate. Handing `displayLabel(t)` to both is what let the vehicle
        // classifier's "Car" veto the demotion on 68 parked-scenery tracks a day.
        ...(displayLabel(t) !== undefined ? { label: displayLabel(t) } : {}),
        ...(t.subLabel !== undefined ? { identityLabel: t.subLabel } : {}),
        ...(staticMetrics
          ? {
              netDisplacementFrac: staticMetrics.netDisplacementFrac,
              pathSpanFrac: staticMetrics.pathSpanFrac,
            }
          : {}),
      })
      await this.deps.trackStore()?.setImportance(t.trackId, importance, reason, peak.bestEventId)
      if (peak.bestEventId !== undefined) {
        await this.deps.eventStore()?.setImportanceForTrack(t.trackId, importance)
      }
      return {
        importance,
        reason,
        ...(peak.bestEventId !== undefined ? { bestEventId: peak.bestEventId } : {}),
      }
    } catch (err) {
      this.deps.logger.debug('importance scoring failed', {
        meta: { trackId: t.trackId, error: String(err) },
      })
      return {}
    }
  }

  /** Last live track on the device → drain the pending media-capture
   *  aggregate so short activity bursts still surface one info line. */
  private flushCaptureWindowIfIdle(deviceId: number): void {
    if ((this.deps.trackStore()?.getActive(deviceId).length ?? 0) !== 0) return
    const captureAgg = this.deps.mediaCaptureLog.flush(deviceId, this.now())
    if (captureAgg === null) return
    this.deps.logger.info('media capture (window)', {
      tags: { deviceId },
      meta: {
        windowSec: Math.round(captureAgg.windowMs / 1000),
        frames: captureAgg.frames,
        ...captureAgg.sums,
      },
    })
  }

  /** Emit the thin `TrackEnded` event + the unified lifecycle `end` event
   *  (the FULL final summary — fires ONCE per real track). */
  private emitEndEvents(
    t: Track,
    duration: number,
    trackerPeakConfidence: number | undefined,
    keyFrameMediaId: number | undefined,
    summary: EndImportanceSummary,
  ): void {
    // Live, not a leftover: the admin-ui events list refreshes on it
    // (`use-events-live-refresh.ts`).
    this.deps.emitTrackEnded(
      {
        deviceId: t.deviceId,
        trackId: t.trackId,
        className: t.className,
        durationMs: duration,
      },
      t.lastSeen,
    )
    const endPayload = buildTrackLifecyclePayload({
      deviceId: t.deviceId,
      trackId: t.trackId,
      phase: 'end',
      classes: t.classes ?? [t.className],
      bestClassName: t.className,
      bestConfidence: trackerPeakConfidence ?? 0,
      firstSeen: t.firstSeen,
      lastSeen: t.lastSeen,
      ...(displayLabel(t) !== undefined ? { label: displayLabel(t) } : {}),
      zonesVisited: t.zonesVisited,
      totalDistance: t.totalDistance,
      positionsCount: t.positions.length,
      ...(summary.importance !== undefined ? { importance: summary.importance } : {}),
      ...(summary.reason !== undefined ? { importanceReason: summary.reason } : {}),
      ...(t.audioLabels !== undefined ? { audioLabels: t.audioLabels } : {}),
      ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
      ...(summary.bestEventId !== undefined ? { bestEventId: summary.bestEventId } : {}),
    })
    this.deps.emitTrackLifecycle(endPayload, t.lastSeen)
  }
}
