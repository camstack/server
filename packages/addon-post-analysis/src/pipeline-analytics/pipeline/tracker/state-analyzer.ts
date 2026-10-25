import type { ObjectState, TrackedDetection, TrackedObjectState } from '@camstack/types'
import { LINK_WINDOW_MS } from '../tracker-v2/constants.js'
import { bboxCentroid } from '../zones/geometry.js'

/**
 * How far back the "did this thing actually go anywhere" question looks.
 *
 * Long enough to span several breaths of a flickering box (the measured cycle
 * on 102 runs about five analysed frames), short enough that a car which stops
 * is called stopped while the operator is still watching it.
 */
const DEFAULT_STILL_WINDOW_MS = 6_000

/**
 * The span the centroid may wander inside that window and still count as
 * still, as a fraction of the subject's smaller side.
 *
 * Measured on 102: the parked car's centroid band is 105 px on a 461x536 box —
 * 0.23 of the short side. A car crossing the frame covers roughly 1.8 box
 * widths in the same window. 0.35 sits in the gap with room on both sides, and
 * scaling by the subject means one number serves a 40 px person and a 461 px
 * car without a per-camera dial.
 */
export const DEFAULT_STILL_SPAN_FRACTION = 0.35

export interface StateAnalyzerConfig {
  readonly stationaryThresholdSec: number
  readonly loiteringThresholdSec: number
  readonly velocityThreshold: number
  readonly enteringFrames: number
  /** See {@link DEFAULT_STILL_WINDOW_MS}. */
  readonly stillWindowMs: number
  /** See {@link DEFAULT_STILL_SPAN_FRACTION}. */
  readonly stillSpanFraction: number
  /**
   * This camera's CALIBRATED "not travelling" bar: centroid speed as a
   * fraction of the subject's own box diagonal, per SECOND. See
   * `stillness-scale.ts` for why a camera needs its own number and how it is
   * measured.
   *
   * **`undefined` means uncalibrated, and uncalibrated is byte-for-byte
   * today**: the absolute `velocityThreshold` decides, exactly as it did
   * before this field existed. It is deliberately not in
   * {@link DEFAULT_STATE_ANALYZER_CONFIG} — a default here would silently
   * calibrate every camera in the fleet to one number, which is the bug.
   *
   * When it IS set it REPLACES `velocityThreshold` rather than joining it: an
   * operator who has calibrated a camera at 0.001 diagonals/s does not also
   * want the 2 px/update rule quietly passing subjects the calibration
   * rejects. The subject-relative span window (`windowSaysStill`) is untouched
   * either way — it already carries its own scale.
   */
  readonly stillSpeedFracPerSec?: number
}

export const DEFAULT_STATE_ANALYZER_CONFIG: StateAnalyzerConfig = {
  stationaryThresholdSec: 10,
  loiteringThresholdSec: 60,
  velocityThreshold: 2,
  enteringFrames: 5,
  stillWindowMs: DEFAULT_STILL_WINDOW_MS,
  stillSpanFraction: DEFAULT_STILL_SPAN_FRACTION,
}

/** One centroid, and when it was seen. */
interface CentroidSample {
  readonly x: number
  readonly y: number
  readonly at: number
}

interface TrackState {
  enteredAt: number
  stationarySince: number | undefined
  totalDistancePx: number
  lastPosition: { x: number; y: number }
  /** Shorter side of the last bbox — the still-span scale (D683 §5). */
  lastShortSide: number
  frameCount: number
  /** Recent centroids, oldest first, trimmed to the still window. */
  recent: CentroidSample[]
}

/**
 * An ended piece's movement state, kept for as long as L2 may still fuse a
 * successor onto it (`LINK_WINDOW_MS`). Deleting on `leaving` is what made a
 * parked car that L1 split across a detection gap forget the idle dwell it
 * had already earned (102 audit 2026-10-04, H1).
 */
interface ParkedTrackState {
  readonly state: TrackState
  readonly parkedAt: number
}

function shortSideOf(bbox: { w: number; h: number }): number {
  return Math.min(bbox.w, bbox.h)
}

export class StateAnalyzer {
  private readonly config: StateAnalyzerConfig
  private readonly states = new Map<string, TrackState>()
  private readonly parked = new Map<string, ParkedTrackState>()

  constructor(config: Partial<StateAnalyzerConfig> = {}) {
    this.config = { ...DEFAULT_STATE_ANALYZER_CONFIG, ...config }
  }

  /**
   * D683: a fused continuation keeps its movement state under the survivor id.
   *
   * The absorbed piece is the live continuation, but a still subject that L1
   * split must not lose the dwell the survivor already paid — `rename` MERGES
   * the stillness clocks when the geometry across the gap is still still, and
   * only takes the live piece alone when the subject actually moved.
   */
  rename(from: string, to: string): void {
    const live = this.states.get(from) ?? this.parked.get(from)?.state
    if (live === undefined) return
    this.states.delete(from)
    this.parked.delete(from)
    const survivor = this.states.get(to) ?? this.parked.get(to)?.state
    this.parked.delete(to)
    if (survivor === undefined) {
      this.states.set(to, live)
      return
    }
    this.states.set(to, this.mergeContinuation(survivor, live))
  }

  analyze(tracks: readonly TrackedDetection[], timestamp: number): TrackedObjectState[] {
    this.pruneParked(timestamp)
    const currentIds = new Set(tracks.map((t) => t.trackId))
    const results: TrackedObjectState[] = []

    for (const track of tracks) {
      let ts = this.states.get(track.trackId)
      if (ts === undefined) {
        // Same id returning inside the link window (or a fusion that already
        // rewrote the emission's trackId onto the survivor): revive the parked
        // dwell rather than minting a fresh entering clock.
        const parked = this.parked.get(track.trackId)
        if (parked !== undefined) {
          this.parked.delete(track.trackId)
          ts = parked.state
          this.states.set(track.trackId, ts)
        }
      }
      const center = bboxCentroid({
        x: track.bbox.x,
        y: track.bbox.y,
        w: track.bbox.w,
        h: track.bbox.h,
      })
      const shortSide = shortSideOf(track.bbox)

      if (!ts) {
        ts = {
          enteredAt: timestamp,
          stationarySince: undefined,
          totalDistancePx: 0,
          lastPosition: center,
          lastShortSide: shortSide,
          frameCount: 1,
          recent: [{ x: center.x, y: center.y, at: timestamp }],
        }
        this.states.set(track.trackId, ts)
      } else {
        const dx = center.x - ts.lastPosition.x
        const dy = center.y - ts.lastPosition.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        ts.totalDistancePx += dist
        ts.lastPosition = center
        ts.lastShortSide = shortSide
        ts.frameCount++
        ts.recent.push({ x: center.x, y: center.y, at: timestamp })
        this.trimRecent(ts, timestamp)
      }

      const velocity = track.velocity
        ? Math.sqrt(track.velocity.dx ** 2 + track.velocity.dy ** 2)
        : 0
      const dwellTimeMs = timestamp - ts.enteredAt

      // A box that BREATHES is not a subject that travels. Measured on 102:
      // a parked car whose lower edge flickers between bodywork and shadow
      // swings its height 25 %, moving the centroid 60-75 px per update —
      // thirty times `velocityThreshold` — while the centre itself stays put
      // (3 px of net travel in 37 s on one of the operator's marked tracks).
      // Judged on the single-frame velocity alone, such a track takes the
      // `moving` branch forever, and that branch also clears
      // `stationarySince`, so it can never mature the ten seconds that would
      // make it still. A gate that shuts itself on every flicker.
      const settled =
        this.speedSaysSettled(ts, track.bbox, velocity) ||
        this.windowSaysStill(ts, track.bbox, timestamp)

      let state: ObjectState
      if (ts.frameCount <= this.config.enteringFrames) {
        state = 'entering'
      } else if (settled) {
        if (!ts.stationarySince) {
          ts.stationarySince = timestamp
        }
        const stationaryDurationSec = (timestamp - ts.stationarySince) / 1000
        // `stationary` COSTS the dwell, for every track. A never-moved shortcut
        // (a58da617) used to grant it the moment net travel was ~0 after the
        // entering window, and that is how a scene flicker voted as a parked
        // object: on 102, vehicle detections at the top of the frame living 1
        // to 6 seconds, identical boxes under different ids, all `stationary`
        // from their sixth frame, minted an entry on ten agreements (D508).
        // `stationaryThresholdSec` is the operator's per-device number for
        // "this has settled"; nothing gets there early.
        if (stationaryDurationSec >= this.config.loiteringThresholdSec) {
          state = 'loitering'
        } else if (stationaryDurationSec >= this.config.stationaryThresholdSec) {
          state = 'stationary'
        } else {
          state = 'moving'
        }
      } else {
        ts.stationarySince = undefined
        state = 'moving'
      }

      results.push({
        trackId: track.trackId,
        state,
        stationarySince: ts.stationarySince,
        enteredAt: ts.enteredAt,
        totalDistancePx: ts.totalDistancePx,
        dwellTimeMs,
      })
    }

    for (const [trackId, ts] of this.states) {
      if (!currentIds.has(trackId)) {
        results.push({
          trackId,
          state: 'leaving',
          stationarySince: ts.stationarySince,
          enteredAt: ts.enteredAt,
          totalDistancePx: ts.totalDistancePx,
          dwellTimeMs: timestamp - ts.enteredAt,
        })
        this.states.delete(trackId)
        // Park, do not forget: L2 may fuse a successor onto this id for up to
        // LINK_WINDOW_MS, and the idle dwell (if any) has to be there to merge.
        this.parked.set(trackId, { state: ts, parkedAt: timestamp })
      }
    }

    return results
  }

  /**
   * Fold a live continuation into its ended survivor.
   *
   * Stillness is what the parked-object ledger votes on (`idle` only). A gap
   * past L1's coast budget that L2 later heals must not restart that clock
   * when the centroid never left the still span. A continuation that DID move
   * drops the survivor's `stationarySince` so a walk after a pause is still
   * `moving`.
   */
  private mergeContinuation(survivor: TrackState, live: TrackState): TrackState {
    const gapTravel = Math.hypot(
      live.lastPosition.x - survivor.lastPosition.x,
      live.lastPosition.y - survivor.lastPosition.y,
    )
    const subject = Math.max(survivor.lastShortSide, live.lastShortSide)
    const stillAcrossGap =
      survivor.stationarySince !== undefined &&
      subject > 0 &&
      gapTravel <= subject * this.config.stillSpanFraction

    const lastAt = live.recent[live.recent.length - 1]?.at
    if (stillAcrossGap && survivor.stationarySince !== undefined && lastAt !== undefined) {
      // Re-anchor the still window on the live position so the next frame does
      // not have to re-fill 6 s after an L1 gap before `windowSaysStill` can
      // defend the dwell the survivor already paid.
      const anchorAt = lastAt - this.config.stillWindowMs
      const recent: CentroidSample[] = [
        { x: live.lastPosition.x, y: live.lastPosition.y, at: anchorAt },
        ...live.recent.filter((s) => s.at > anchorAt),
      ]
      return {
        enteredAt: Math.min(survivor.enteredAt, live.enteredAt),
        stationarySince:
          live.stationarySince !== undefined
            ? Math.min(survivor.stationarySince, live.stationarySince)
            : survivor.stationarySince,
        totalDistancePx: survivor.totalDistancePx + live.totalDistancePx,
        lastPosition: live.lastPosition,
        lastShortSide: live.lastShortSide,
        // Past enteringFrames: the subject is not new, only re-bound.
        frameCount: Math.max(survivor.frameCount + live.frameCount, this.config.enteringFrames + 1),
        recent,
      }
    }

    return {
      enteredAt: live.enteredAt,
      stationarySince: live.stationarySince,
      totalDistancePx: survivor.totalDistancePx + live.totalDistancePx,
      lastPosition: live.lastPosition,
      lastShortSide: live.lastShortSide,
      frameCount: live.frameCount,
      recent: [...live.recent],
    }
  }

  private trimRecent(ts: TrackState, timestamp: number): void {
    const cutoff = timestamp - this.config.stillWindowMs
    // Keep one sample older than the cutoff so the window is known to be
    // FULL — an empty history and a genuinely still second look alike
    // otherwise, and calling an unknown "still" is the failure mode that
    // matters here.
    while (ts.recent.length > 2 && ts.recent[1]!.at < cutoff) ts.recent.shift()
  }

  private pruneParked(timestamp: number): void {
    for (const [id, parked] of this.parked) {
      if (timestamp - parked.parkedAt > LINK_WINDOW_MS) this.parked.delete(id)
    }
  }

  /**
   * The SPEED half of the settled test.
   *
   * Uncalibrated (`stillSpeedFracPerSec` undefined) this is the original line
   * verbatim — the tracker's px-per-update velocity against the flat
   * `velocityThreshold`. Nothing about an uncalibrated camera changes.
   *
   * Calibrated, the same question is asked in the camera's own units: how far
   * the centroid moved between the last two OBSERVED samples, over the
   * subject's own box diagonal, over the elapsed SECONDS. Per second and not
   * per update because these cameras are `armed:on-motion` and deliver a
   * settle burst plus a poll — 56 ms to 2135 ms between stored positions on
   * one subject (D399) — so a per-update figure says more about the cadence
   * than about the subject.
   *
   * An interval that cannot be measured (a single sample, a non-positive
   * elapsed time, a box with no size) is UNKNOWN, and unknown never reads as
   * settled. A track that young is still inside `enteringFrames` anyway.
   */
  private speedSaysSettled(
    ts: TrackState,
    bbox: { w: number; h: number },
    velocity: number,
  ): boolean {
    const bar = this.config.stillSpeedFracPerSec
    if (bar === undefined) return velocity <= this.config.velocityThreshold

    const last = ts.recent[ts.recent.length - 1]
    const prev = ts.recent[ts.recent.length - 2]
    if (!last || !prev) return false
    const elapsedSec = (last.at - prev.at) / 1000
    if (!(elapsedSec > 0)) return false
    const diagonal = Math.hypot(bbox.w, bbox.h)
    if (!(diagonal > 0)) return false
    const fracPerSec = Math.hypot(last.x - prev.x, last.y - prev.y) / diagonal / elapsedSec
    return fracPerSec <= bar
  }

  /**
   * Whether the centroid has stayed inside a small span for the whole window.
   *
   * The span is measured across the samples themselves (their bounding box),
   * not against any single reference point, so a slow drift is caught as
   * surely as a jump. It is compared to the subject's SHORTER side: a 461 px
   * car and a 40 px person get the same rule without a per-camera dial.
   *
   * `false` until the window is actually full — a track three frames old has
   * not yet earned the verdict, and unknown must never read as still.
   */
  private windowSaysStill(
    ts: TrackState,
    bbox: { w: number; h: number },
    timestamp: number,
  ): boolean {
    const oldest = ts.recent[0]
    if (!oldest || timestamp - oldest.at < this.config.stillWindowMs) return false
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const s of ts.recent) {
      if (s.x < minX) minX = s.x
      if (s.x > maxX) maxX = s.x
      if (s.y < minY) minY = s.y
      if (s.y > maxY) maxY = s.y
    }
    const span = Math.hypot(maxX - minX, maxY - minY)
    const subject = Math.min(bbox.w, bbox.h)
    if (subject <= 0) return false
    return span <= subject * this.config.stillSpanFraction
  }

  reset(): void {
    this.states.clear()
    this.parked.clear()
  }
}
