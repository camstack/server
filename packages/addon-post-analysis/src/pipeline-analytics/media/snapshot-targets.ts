/**
 * The per-frame media decision: which tracks get a snapshot, a rolling
 * lastFrame, a best thumbnail and a native keyFrame this frame, the D400
 * best-shot promotion record, and the firstFrame retries. Moved out of
 * `pipeline-analytics/index.ts` verbatim (Plan B, extraction 2): only the
 * visibility of the entry points and the calls that now reach
 * `FrameMediaCapture` / the deps object changed.
 */
import {
  canvasFillFraction,
  centralSquareContainmentFraction,
} from '../../shared/frame/wide-central-square-crop.js'
import { isPlausibleRetryBox, isPlausibleThumbnailBox } from '../best-thumbnail-guard.js'
import type { MediaSettings } from '../media-settings.js'
import { planPeriodicMedia } from '../periodic-media-plan.js'
import {
  type BestShotCaptureSuppression,
  type BestShotPromotionAttempt,
  bestShotPromotionMeta,
  shouldLogPromotionAttempt,
} from '../pipeline/best-shot-promotion-log.js'
import type { ClosedRowMediaGate } from '../pipeline/closed-row-media-gate.js'
import type { DebugCropCaptureInput } from '../pipeline/debug-crop-capture.js'
import {
  bboxCenterScore,
  bboxContainment,
  bboxSizeScore,
  isEdgeClear,
} from '../pipeline/edge-clear.js'
import { firstFrameRetryBbox } from '../pipeline/first-frame-retry-bbox.js'
import type { TrackedDetectionOut } from '../pipeline/frame-processor.js'
import type { KeyFrameSelectionKind } from '../pipeline/key-frame-capture.js'
import { decideKeyFrameCapture } from '../pipeline/key-frame-retry.js'
import { patchDisplayLabel } from '../pipeline/label-tier.js'
import { thumbnailWouldShowParkedNotSubject } from '../pipeline/stationary/stationary-match.js'
import type { StationaryObjectRegistry } from '../pipeline/stationary/stationary-registry.js'
import type { ParkDecision } from '../pipeline/track-park.js'
import type { TrackResidentState } from '../pipeline/track-resident-state.js'
import { captureCoalesceKey, type CaptureScheduler } from '../runtime/capture-scheduler.js'
import type { TrackFrameTarget, TrackSnapshotTarget } from '../services/event-media-dispatcher.js'
import { evaluatePeriodicSnapshot } from '../snapshot-movement-gate.js'
import type { TrackStore } from '../store/track-store.js'
import type { AddonContext, FrameHandle, ParkedFrameKind } from '@camstack/types'
import type { FrameMediaCapture } from './frame-media-capture.js'

/** Rolling `lastFrame` cadence — deliberately DENSER than the 5s snapshot
 *  interval: most real tracks live 3–9s, so on the snapshot cadence they
 *  closed with NO `lastFrame` at all (29/68 in the 2026-07-22 4h audit) and
 *  the close-time promotion had nothing to absorb. Rolls are BUCKET-aligned
 *  (see `planPeriodicMedia`) so every active track shares the SAME capture
 *  frame per interval — one shared native fetch per device per 2s, not one
 *  per track (the 1.5s per-track-clock version stampeded the retained-frame
 *  ring under multi-track load: "frame recycled before resolve"). */
const LAST_FRAME_INTERVAL_MS = 2_000

/** `maybeEmitTrackLifecycleUpdate`: the addon's debounced lifecycle update. */
export type EmitTrackLifecycleUpdate = (
  deviceId: number,
  t: TrackedDetectionOut,
  timestamp: number,
  isNewBest: boolean,
) => void

/** What the snapshot-target planner reads from the addon. */
export interface SnapshotTargetPlannerDeps {
  /** The addon context — throws outside the initialized window. */
  readonly ctx: () => AddonContext
  readonly residents: TrackResidentState
  readonly captureScheduler: () => CaptureScheduler
  readonly closedRowMediaGate: ClosedRowMediaGate
  readonly trackStore: () => TrackStore | null
  readonly stationaryRegistry: () => StationaryObjectRegistry | null
  readonly mediaCapture: FrameMediaCapture
  readonly maybeEmitTrackLifecycleUpdate: EmitTrackLifecycleUpdate
  readonly offerDebugCrop: (input: DebugCropCaptureInput) => void
}

export class SnapshotTargetPlanner {
  constructor(private readonly deps: SnapshotTargetPlannerDeps) {}

  private get ctx(): AddonContext {
    return this.deps.ctx()
  }

  private get residents(): TrackResidentState {
    return this.deps.residents
  }

  private get captureScheduler(): CaptureScheduler {
    return this.deps.captureScheduler()
  }

  private get closedRowMediaGate(): ClosedRowMediaGate {
    return this.deps.closedRowMediaGate
  }

  private get trackStore(): TrackStore | null {
    return this.deps.trackStore()
  }

  private get stationaryRegistry(): StationaryObjectRegistry | null {
    return this.deps.stationaryRegistry()
  }

  private get mediaCapture(): FrameMediaCapture {
    return this.deps.mediaCapture
  }

  /**
   * DEFECT A: build `firstFrame` RETRY targets for confirmed-birth tracks whose
   * birth capture never landed. A track qualifies when it is still pending
   * (firstFrame-pending), is OBSERVED this frame (`matchedThisFrame` — a
   * coasted/stale box would crop the empty scene), is NOT already targeted this
   * frame (its birth target), and has no capture in flight (the scheduler's
   * firstFrame hold key, S3). Each target is
   * stamped with the CURRENT frame timestamp so the media carries the real
   * capture instant, not the birth ts — the earliest AVAILABLE view still beats
   * no firstFrame at all.
   */
  collectFirstFrameRetries(
    deviceId: number,
    tracked: readonly TrackedDetectionOut[],
    timestamp: number,
    alreadyTargeted: readonly TrackFrameTarget[],
  ): TrackFrameTarget[] {
    if (!this.residents.anyFirstFramePending()) return []
    const bornThisFrame = new Set(alreadyTargeted.map((t) => t.trackId))
    const retries: TrackFrameTarget[] = []
    for (const t of tracked) {
      if (t.matchedThisFrame === false) continue
      if (!this.residents.isFirstFramePending(t.trackId)) continue
      if (bornThisFrame.has(t.trackId)) continue
      if (this.captureScheduler.isKeyActive(captureCoalesceKey(deviceId, 'firstFrame', t.trackId)))
        continue
      retries.push({
        trackId: t.trackId,
        timestamp,
        bbox: firstFrameRetryBbox(
          t.bbox,
          this.trackStore?.peekActive(t.trackId)?.positions[0]?.bbox,
        ),
        ...(patchDisplayLabel(t.labelPatch) !== undefined
          ? { label: patchDisplayLabel(t.labelPatch) }
          : {}),
        className: t.className,
      })
    }
    return retries
  }

  /**
   * §5 — decide which active tracks need periodic media THIS frame. Pure over
   * TrackStore.lastSnapshotAt + the per-track best-confidence map:
   *  • `snapshot` (append) fires on the snapshotIntervalMs cadence, gated by
   *    `debugMediaEnabled`; the rolling `lastFrame` fires on its own cadence
   *    and is NOT gated (it is in the keep-set);
   *  • `thumbnail` (best) fires when confidence beats the held best per
   *    `BEST_FRAME_POLICY` (hysteresis margin, rate-limited to one per
   *    `minGapMs` — see `pipeline/best-selection-policies.ts`), and is
   *    never gated (a single best still-frame is always useful).
   * The per-track best-confidence map is updated here as a side effect.
   */
  buildSnapshotTargets(
    deviceId: number,
    tracked: readonly TrackedDetectionOut[],
    timestamp: number,
    media: MediaSettings,
    frameWidth: number,
    frameHeight: number,
    /** This frame's handle — what a PARK names. Absent (no decoded frame, or
     *  an owner the registry called offline) ⇒ nothing is parked this frame. */
    frameHandle: FrameHandle | undefined,
  ): TrackSnapshotTarget[] {
    const targets: TrackSnapshotTarget[] = []
    for (const t of tracked) {
      // RC-3: a COASTED track (frozen/extrapolated bbox — subject not observed
      // this frame) is NOT a media-eligible detection. Cropping its stale box
      // yields the empty scene ("crop del nulla"). Skip it entirely: no best-
      // thumbnail / keyFrame seed and no appended snapshot. The next frame where
      // the subject is re-detected (matchedThisFrame === true) captures normally.
      // `matchedThisFrame` is always true off a current tracker; the `!== false`
      // guard keeps a legacy runner (field absent) at the prior behaviour.
      if (t.matchedThisFrame === false) continue
      // A row the store has already CLOSED is not a media destination — this is
      // the capture-side half of the `b50e09f7` fix (2026-08-21). Every kind
      // that incident overwrote is decided in this loop: `thumbnail`,
      // `lastFrame`, the appended `snapshot`, and the native `keyFrame` that
      // `selectKeyFrameCaptures(snapshotTargets)` seeds from it. Skipping the
      // track here therefore closes all four at ONE point, and leaves the
      // close-path's OWN writes (last-frame promotion, the raster and
      // keyFrame-derived thumbnail fallbacks) untouched — they never come
      // through here.
      //
      // The question asked is "is this row closed?", not "how old is this
      // track": the age bound belongs to the tracker and is not duplicated
      // here. And the answer is a positive in-RAM record of a close the store
      // PERFORMED — no answer means write (D49).
      const verdict = this.closedRowMediaGate.evaluate(
        t.trackId,
        this.trackStore!.rowClosedAt(t.trackId),
        Date.now(),
      )
      if (verdict.refuse) {
        if (verdict.log) {
          this.ctx.logger.warn('track media refused: row already closed', {
            tags: { deviceId },
            meta: {
              trackId: t.trackId,
              className: t.className,
              closedAgeMs: verdict.closedAgeMs,
              // Refusals for this track that this one line stands for.
              suppressed: verdict.suppressed,
            },
          })
        }
        continue
      }
      const lastSnap = this.trackStore!.lastSnapshotAt(t.trackId)
      // Periodic cadence + MOVEMENT gate: once snapshotIntervalMs elapsed, only
      // capture when the centroid moved ≥ snapshotMovementThreshold of the frame
      // diagonal since the last snapshot — else skip the near-identical frame.
      // A stationary loiterer still gets one every snapshotMaxIdleMs. Skipping
      // leaves lastSnapshotAt untouched, so the gate re-evaluates every frame
      // and the idle fallback keeps advancing.
      const dueSnapshot = evaluatePeriodicSnapshot({
        lastSnapshotAt: lastSnap,
        lastSnapshotBbox: this.trackStore!.lastSnapshotBbox(t.trackId),
        currentBbox: t.bbox,
        now: timestamp,
        frameWidth,
        frameHeight,
        intervalMs: media.snapshotIntervalMs,
        movementThreshold: media.snapshotMovementThreshold,
        maxIdleMs: media.snapshotMaxIdleMs,
      }).capture

      // Single best-detection policy (shared with the face path), now
      // EDGE-AWARE: a frame whose bbox sits fully inside the frame (whole
      // subject in view) always outranks an edge-touching one (a clipped,
      // partial subject); confidence decides within the same edge tier.
      const edgeClear = isEdgeClear({ bbox: t.bbox, frameWidth, frameHeight })
      // #27-D centering tie-break: among near-equal-confidence, same-edge-tier
      // frames prefer the better-centred subject so a low-importance short track
      // stops locking in an edge-of-frame frame.
      const centerScore = bboxCenterScore(t.bbox, frameWidth, frameHeight)
      // #edge-clip edge-containment: within the touching tier, penalise a
      // border-clipped subject (half out of frame) so a fully-contained frame
      // outranks it unless the clipped one is DECISIVELY higher confidence.
      const containment = bboxContainment(t.bbox, frameWidth, frameHeight)
      // Subject-size term: a bigger/closer view is a better SHOT at equal
      // confidence (raw confidence doesn't track human crop quality); a
      // DECISIVE effective improvement also bypasses the capture rate limit
      // inside the tracker (BEST_SHOT_STALE, 2026-07-22 audit).
      const sizeScore = bboxSizeScore(t.bbox, frameWidth, frameHeight)
      // Subject-on-the-side tier (2026-08-21): how much of the subject the
      // DELIVERED square view would actually show for this frame. A frame
      // under the containment threshold is the weakest tier — best-seen
      // "waits" for a containable frame automatically wherever one exists.
      const squareFraction = centralSquareContainmentFraction(t.bbox, {
        W: frameWidth,
        H: frameHeight,
      })
      // D400 delivered-canvas term: how much of the 16:9 image the operator is
      // SHOWN would be synthesized lateral fill. A bounded within-tier factor —
      // never a tier (fill is anti-correlated with subject size, see
      // `CANVAS_FILL_MAX_PENALTY`).
      const canvasFill = canvasFillFraction(t.bbox, { W: frameWidth, H: frameHeight })
      const firstBox = this.trackStore?.peekActive(t.trackId)?.positions[0]?.bbox
      const skipParkedThumb =
        firstBox !== undefined &&
        thumbnailWouldShowParkedNotSubject({
          currentBbox: t.bbox,
          firstBbox: firstBox,
          className: t.className,
          entries: this.stationaryRegistry?.listViews(deviceId) ?? [],
        })
      // Read the held peak BEFORE observing: after it, the peak IS the
      // candidate and the attempt can no longer be described (D400).
      const heldBest = this.residents.bestFrameHeld(t.trackId)
      const isNewBest = skipParkedThumb
        ? false
        : this.residents.observeBestFrame(
            deviceId,
            t.trackId,
            t.confidence,
            timestamp,
            edgeClear,
            centerScore,
            containment,
            sizeScore,
            squareFraction,
            // The per-frame path knows nothing about recognitions (they arrive
            // over the async detail plane) — semantic promotion is the
            // attribution-time re-score in `promoteSemanticRecognition`.
            false,
            canvasFill,
          )

      // The comparator's decomposed verdict for THIS observe — recorded by the
      // tracker during the call above, read back for the promotion log (D400).
      const comparison = skipParkedThumb
        ? undefined
        : this.residents.bestFrameLastComparison(t.trackId)

      // Unified lifecycle event — `phase:'update'` on a MATERIAL improvement
      // (reuses the SAME isNewBest signal; gated + debounced). Runs regardless
      // of the snapshot gate below.
      this.deps.maybeEmitTrackLifecycleUpdate(deviceId, t, timestamp, isNewBest)

      // Decide snapshot / lastFrame / thumbnail for this frame. `lastFrame`
      // rolls on its OWN cadence and NEVER on a snapshot frame, so it can never
      // duplicate the most recent `snapshot` (end-of-track duplicate fix).
      const plan = planPeriodicMedia({
        debugMediaEnabled: media.debugMediaEnabled,
        dueSnapshot,
        isNewBest,
        thumbnailLanded: this.residents.isThumbnailLanded(t.trackId),
        lastFrameAt: this.residents.lastFrameAt(t.trackId) ?? 0,
        now: timestamp,
        intervalMs: media.snapshotIntervalMs,
        lastFrameIntervalMs: Math.min(LAST_FRAME_INTERVAL_MS, media.snapshotIntervalMs),
        firstFrameLanded: this.residents.isFirstFrameLanded(t.trackId),
      })
      // DEFECT B in-flight gate (RC-1 → S3 scheduler hold key): don't issue a
      // NEW rolling-`lastFrame` capture while one is still resolving for this
      // track. The clock now advances ONLY when the write lands (dispatch
      // `.then`), so without this gate the still-unadvanced clock would
      // satisfy `lastFrameElapsed` every frame and stack N overlapping
      // captures until the first settled. A dropped roll releases the key on
      // settle without advancing → the next eligible frame re-rolls.
      const rollingLastFrame =
        plan.rollingLastFrame &&
        !this.captureScheduler.isKeyActive(captureCoalesceKey(deviceId, 'lastFrame', t.trackId))
      // Advance the snapshot gate reference SYNCHRONOUSLY at decision time so the
      // next few frames see the moved clock/bbox — the real snapshot only lands
      // (and re-stamps) after the async encode/dispatch round-trip, during which
      // several frames would otherwise pass the gate → a burst of near-identical
      // snapshots. Mirrors the synchronous lastFrameAt advance above; a
      // failed write just loses the slot (no rollback).
      if (plan.appendSnapshot) {
        this.trackStore!.markSnapshotPending(t.trackId, timestamp, t.bbox)
      }

      // Void/envArea guard: reject a best `thumbnail` (and the keyFrame it seeds)
      // when this frame's box has exploded to (near-)full-frame — the dawn/night
      // "envelope exploded" signature that yields a useless full-scene void tile.
      // Suppressing it keeps `thumbnailLanded` false, so the #27-A retry picks a
      // plausible frame on a later tick instead of locking in the void frame.
      // Score-aware (2026-07-23): a high-confidence near-full-frame box is a
      // REAL close subject (dev101 driveway cars, score 0.45-0.9) — without the
      // score override those tracks never landed a thumbnail OR keyFrame. The
      // low-confidence artifacts the guard exists for (garden wall, 0.04) stay
      // rejected. Stationary promotion keeps the size-only guard.
      const plausibleBox = isPlausibleThumbnailBox(t.bbox, frameWidth, frameHeight, t.confidence)
      // #27-A degenerate-retry bookkeeping: remember the best-seen PLAUSIBLE
      // subject bbox (full geometry — the retry gate below compares areas; the
      // close-time keyFrame-derived thumbnail crops this exact region). Gated on
      // `plausibleBox` so an envelope-exploded new-best can never poison the
      // reference (mirrors the keyFrame re-shot condition below).
      if (isNewBest && plausibleBox) {
        this.residents.recordBestSeenBbox(deviceId, t.trackId, {
          x: t.bbox.x,
          y: t.bbox.y,
          w: t.bbox.w,
          h: t.bbox.h,
          frameWidth,
          frameHeight,
          timestamp,
        })
      }
      // #27-A degenerate-retry gate (RETRY path only): when the capture fires
      // because no thumbnail LANDED yet (cold-lease retry) — not because this
      // frame is a genuine new best — the current bbox must not have collapsed
      // to a sliver of the best-seen subject (car 78px at birth → 26px when the
      // lease finally warmed → a native-but-useless thumbnail of a distant car,
      // then `thumbnailLanded` stopped retries forever). A rejected retry keeps
      // `thumbnailLanded` false; the close-time keyFrame fallback still
      // guarantees a thumbnail for tracks that never re-grow.
      const retryBoxPlausible =
        isNewBest || isPlausibleRetryBox(t.bbox, this.residents.bestSeenBbox(t.trackId) ?? null)
      // In-flight gate (RC-1 → S3 scheduler hold key): don't issue a NEW
      // best-thumbnail capture while one is still resolving for this track —
      // the #27-A per-frame retry otherwise stacked N overlapping captures
      // (→ duplicate/13 rows). The settled dispatch releases the key; a later
      // frame re-fires if the thumbnail still hasn't landed.
      const bestThumbnail =
        plan.bestThumbnail &&
        plausibleBox &&
        retryBoxPlausible &&
        !this.captureScheduler.isKeyActive(captureCoalesceKey(deviceId, 'thumbnail', t.trackId))
      // The native full-frame keyFrame fires on a GENUINE new-best moment —
      // and, since 2026-08-06, on a BOUNDED catch-up retry when no key frame
      // has landed. `isNewBest` alone is a PEAK signal: 80% of the tracks that
      // logged a native miss got exactly one attempt in their whole life, and
      // 71.6% of the survivors ended with no key frame, hence permanently
      // absent from semantic search after any rebuild (21.7% of stored
      // tracks). The retry is capped, min-gapped and lower-priority — see
      // `key-frame-retry.ts` for why each bound exists.
      //
      // The in-flight side stays the scheduler's coalesceKey, but the demand
      // side is gated here too: without it the per-frame retry would enqueue a
      // fresh request every frame that merely JOINS the running one, inflating
      // `requested` and hiding the real capture rate.
      const keyFrame: KeyFrameSelectionKind = this.captureScheduler.isKeyActive(
        captureCoalesceKey(deviceId, 'keyFrame', t.trackId),
      )
        ? 'skip'
        : decideKeyFrameCapture({
            isNewBest,
            plausibleBox,
            state: this.residents.keyFrameCapture(t.trackId),
            now: timestamp,
          }).kind

      // D422: a frame that matters to this track is PARKED now, at the node
      // that holds its pixels, while the handle is young. A genuine new best
      // parks both parcels (replacing the previous ones — the ranking above
      // is the only authority on "better"). A RETRY — the bounded keyFrame
      // catch-up, or the per-frame thumbnail re-fire while none has landed —
      // parks the CURRENT frame only for a kind that has NO parcel yet: the
      // park at the peak was refused, and this later frame is the retry's
      // whole point. It must never replace a parcel that exists with a frame
      // the ranking did not prefer. The consumers below read the parcel; the
      // in-flight park is awaited there, so a same-frame write cannot race it.
      if (frameHandle !== undefined && plausibleBox) {
        const decision: ParkDecision = {
          deviceId,
          trackId: t.trackId,
          timestamp,
          frameHandle,
          bbox: { x: t.bbox.x, y: t.bbox.y, w: t.bbox.w, h: t.bbox.h },
          frameWidth,
          frameHeight,
        }
        if (isNewBest) {
          this.mediaCapture.issueParkOrders(decision, ['keyFrame', 'thumbnail'], false)
        } else {
          const retryKinds: ParkedFrameKind[] = []
          if (keyFrame === 'retry') retryKinds.push('keyFrame')
          if (bestThumbnail) retryKinds.push('thumbnail')
          if (retryKinds.length > 0) this.mediaCapture.issueParkOrders(decision, retryKinds, true)
        }
      }

      // D400: EVERY best-shot promotion attempt is on the record — the term
      // that decided it, the candidate it considered, and whether a capture
      // was dispatched. Before this, an acceptance whose capture missed and a
      // promotion that never fired produced the same observable (an old best
      // shot), and track 5f5f0f6e closed UNKNOWN for exactly that reason.
      const suppressedBy = ((): BestShotCaptureSuppression | undefined => {
        if (skipParkedThumb) return 'parked-thumbnail'
        if (!isNewBest || bestThumbnail) return undefined
        if (!plan.bestThumbnail) return 'not-planned'
        if (!plausibleBox) return 'implausible-box'
        if (!retryBoxPlausible) return 'retry-box-collapsed'
        return 'capture-in-flight'
      })()
      const promotionAttempt: BestShotPromotionAttempt = {
        trackId: t.trackId,
        className: t.className,
        timestamp,
        candidate: {
          confidence: t.confidence,
          edgeClear,
          centerScore,
          containment,
          sizeScore,
          squareFraction,
          canvasFill,
          semantic: false,
        },
        ...(heldBest !== undefined ? { held: heldBest } : {}),
        ...(comparison !== undefined ? { comparison } : {}),
        accepted: isNewBest,
        ...(suppressedBy !== undefined ? { suppressedBy } : {}),
        thumbnailRequested: bestThumbnail,
        keyFrameRequested: keyFrame !== 'skip',
      }
      const refusalLoggedAt = this.residents.bestShotRefusalLoggedAt(t.trackId)
      if (
        shouldLogPromotionAttempt(promotionAttempt, {
          thumbnailLanded: this.residents.isThumbnailLanded(t.trackId),
          ...(refusalLoggedAt !== undefined ? { lastRefusalLogAtMs: refusalLoggedAt } : {}),
        })
      ) {
        if (!isNewBest) {
          this.residents.noteBestShotRefusalLogged(deviceId, t.trackId, timestamp)
        }
        this.ctx.logger.info('best shot promotion', {
          tags: { deviceId },
          meta: { ...bestShotPromotionMeta(promotionAttempt) },
        })
      }

      // OPERATOR-DEBUG evidence for the best-shot ranking. The line above
      // carries the numbers; this carries the PICTURE those numbers were about,
      // with the neighbourhood around the subject and — where the held peak was
      // measured on a frame of the same dims — the shot it was competing with,
      // drawn beside it. `clippedSides` in the caption is the fact the 2026-09-18
      // mirror trace needed and no stored crop could give: the best shot sat at
      // a border because every frame of that track did, not because a
      // better-placed one was passed over (`compareBestFrame` prefers an
      // edge-clear frame as a hard tier).
      if (frameHandle !== undefined) {
        const heldBbox = this.residents.bestSeenBbox(t.trackId)
        // Only when the held peak was measured in THIS frame's pixel space —
        // a box from a differently-sized frame drawn here would be a rectangle
        // somewhere the subject never was.
        const rival =
          heldBbox !== undefined &&
          heldBbox.frameWidth === frameWidth &&
          heldBbox.frameHeight === frameHeight
            ? { x: heldBbox.x, y: heldBbox.y, w: heldBbox.w, h: heldBbox.h }
            : undefined
        this.deps.offerDebugCrop({
          deviceId,
          trackId: t.trackId,
          decision: 'best-shot',
          subject: { x: t.bbox.x, y: t.bbox.y, w: t.bbox.w, h: t.bbox.h },
          ...(rival !== undefined ? { rival } : {}),
          frameHandle,
          frameWidth,
          frameHeight,
          timestamp,
          evidence: { ...bestShotPromotionMeta(promotionAttempt) },
        })
      }

      if (!plan.appendSnapshot && !rollingLastFrame && !bestThumbnail && keyFrame === 'skip')
        continue
      targets.push({
        trackId: t.trackId,
        timestamp,
        bbox: { ...t.bbox },
        ...(patchDisplayLabel(t.labelPatch) !== undefined
          ? { label: patchDisplayLabel(t.labelPatch) }
          : {}),
        className: t.className,
        appendSnapshot: plan.appendSnapshot,
        rollingLastFrame,
        bestThumbnail,
        keyFrame,
      })
    }
    return targets
  }
}
