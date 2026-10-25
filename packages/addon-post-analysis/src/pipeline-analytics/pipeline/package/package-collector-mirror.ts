/**
 * PackageCollectorMirror — WHO took the parcel.
 *
 * ## The defect this exists to fix (D404)
 *
 * A pick-up notification's picture resolved from the pick-up row's own media
 * owners, and the row named the PACKAGE: `trackId = entry.sourceTrackId`, the
 * stationary-entry's own parcel track, plus the parcel's key frame. So the
 * operator was shown a photograph of the doormat the parcel used to sit on —
 * the one thing they already know — instead of the person who collected it.
 *
 * ## Why a mirror, and not a look at the live tracks
 *
 * A departure is not observed, it is CONCLUDED. `PackageStillnessTracker`
 * retires a promoted candidate only after `PACKAGE_STILLNESS_TTL_MS`
 * (5 minutes of OBSERVED time) with no re-association, and on a
 * session-dispatch camera that is longer still in wall clock. By the time
 * `onDeparted` runs, the collector's track has been closed, its resident state
 * dropped and its detections long gone from the frame. Asking "who is in the
 * frame now" at that moment answers about a scene the pick-up has left.
 *
 * So the answer has to be recorded WHEN IT IS TRUE. This mirror is fed from
 * the same per-frame loop that already stamps `lastNonPackageActivityAt` — the
 * non-package tracks inside a configured drop-off zone, which is exactly the
 * population a collector is drawn from (a walker at the far gate is not a
 * collector; `isDelivererInPackageZone` is the same gate).
 *
 * ## What it stores, and what it deliberately does not
 *
 * Handles only: a trackId and the track's native key-frame media ID (D482). No
 * pixels, ever (D9/D18) — the notification's still ladder redeems the handle on
 * demand through the ordinary `getMediaForOwner('track', …)` path, which is the
 * same vehicle the doorbell marker and the occupancy edge already use
 * (`docs/architecture/notifications.md`). Nothing crosses a process boundary
 * here at frame rate; nothing new is persisted.
 *
 * ## "As close as possible", and which way it trades
 *
 * The operator's requirement is the frame NEAREST the pick-up instant, and the
 * pick-up instant is `entry.lastConfirmedAt` — the last frame the parcel was
 * still there. So the scoring is purely temporal:
 *
 *  - a presence whose observed span CONTAINS the instant scores 0 — the track
 *    was there when the parcel went;
 *  - otherwise the gap to the nearer end of its span.
 *
 * **When a nearer candidate and a better-looking one conflict, the nearer one
 * wins.** A courier who stood on the porch for a minute half an hour earlier
 * has a long, well-lit, high-confidence track, and it is a picture of the
 * wrong person; the eight-frame track that overlapped the parcel's last
 * sighting is the collector even if its key frame is grainy. Nothing here
 * scores confidence, track length or crop area, and that is the trade, stated
 * once: recency over quality.
 *
 * An exact tie breaks toward the LATER presence — of two tracks equidistant
 * from the instant, the one still there after it is the one that could have
 * carried the parcel away.
 */

import type { StationaryEntry } from '../stationary/stationary-types.js'
import { isDelivererInPackageZone } from './package-zone-activity.js'

/**
 * How far from the pick-up instant a presence may sit and still be the
 * collector.
 *
 * The stillness tracker already refuses to call a disappearance a pick-up
 * unless there was zone activity at or after the parcel's last sighting
 * (`lastActivityAt >= lastSeenAt - roundGapMs`, one governor round of slack),
 * so a collector is expected within a few seconds either way. 30 s is an order
 * of magnitude above the act itself — bend down, pick up, walk off — while
 * still refusing the courier from ten minutes before, which is the exact
 * confusion this module exists to prevent.
 */
export const PACKAGE_COLLECTOR_MAX_SKEW_MS = 30_000

/**
 * How long a presence survives in the mirror, in FRAME time.
 *
 * It must outlive the whole detection latency: a pick-up at T is concluded no
 * earlier than T + `PACKAGE_STILLNESS_TTL_MS` (5 min of observed time), and the
 * pick is made at conclusion time. 10 minutes is double that, so a collector
 * noted at the true instant is still there to be named — and a mirror that
 * expires the answer before the question is asked would be the same silent
 * hole in a different place.
 */
export const PACKAGE_COLLECTOR_RETENTION_MS = 10 * 60_000

/**
 * Presences retained per camera. A drop-off zone is a doorstep, not a piazza:
 * 32 distinct tracks inside one within ten minutes is already far beyond any
 * real scene, and the cap is what stops a detector storm from growing this map
 * without bound on a camera nobody is delivering to.
 */
const PACKAGE_COLLECTOR_MAX_PRESENCES = 32

/** One per-frame sighting of a possible collector. */
export interface CollectorObservation {
  readonly deviceId: number
  readonly trackId: string
  readonly className: string
  /** Frame instant — the same clock `StationaryEntry.lastConfirmedAt` uses. */
  readonly at: number
  /** The track's native key-frame media id (D482), when one has landed. A HANDLE. */
  readonly keyFrameMediaId?: number
}

/** The chosen collector, as the pick-up row needs it. */
export interface PackageCollector {
  readonly trackId: string
  readonly className: string
  /** The instant within this track's presence nearest the pick-up. */
  readonly observedAt: number
  /** `|observedAt − pickupAt|`; 0 when the track was present AT the instant. */
  readonly skewMs: number
  /** Media id (D482) of the collector's native key frame, when one landed. */
  readonly keyFrameMediaId?: number
}

/** One track's observed presence inside the drop-off zone. */
interface CollectorPresence {
  readonly trackId: string
  readonly className: string
  readonly firstAt: number
  readonly lastAt: number
  readonly keyFrameMediaId?: number
}

/** One tracked detection of the current frame, as the mirror reads it. */
export interface CollectorFrameTrack {
  readonly trackId: string
  readonly className: string
  readonly zones: readonly string[]
}

/** One frame's worth of candidates, exactly as the pipeline loop has them. */
export interface CollectorFrameInput {
  readonly deviceId: number
  readonly tracked: readonly CollectorFrameTrack[]
  /** Classes that are the PARCEL. A package box never vouches for its own
   *  collection — the same exclusion the activity gate makes. */
  readonly packageClasses: ReadonlySet<string>
  /** Zone ids of the enabled `package`-stage rules. Empty ⇒ nothing is noted:
   *  without a drop-off zone there is no place a collector could stand. */
  readonly packageZoneIds: ReadonlySet<string>
  readonly timestamp: number
  /** The track's native key-frame media id (D482), by handle. */
  readonly keyFrameMediaIdFor: (trackId: string) => number | undefined
}

export interface PickCollectorInput {
  readonly deviceId: number
  /** The pick-up instant — `entry.lastConfirmedAt`, the parcel's last sighting.
   *  NOT the departure timestamp, which is minutes later by construction. */
  readonly pickupAt: number
  /** Override for the skew bound. Absent ⇒ {@link PACKAGE_COLLECTOR_MAX_SKEW_MS}. */
  readonly maxSkewMs?: number
}

/** The pick-up instant a stationary entry implies. One derivation, named. */
export function pickupInstantOf(entry: StationaryEntry): number {
  return entry.lastConfirmedAt
}

export class PackageCollectorMirror {
  /** Per device, per track. Every write replaces the record (immutable). */
  private readonly byDevice = new Map<number, ReadonlyMap<string, CollectorPresence>>()

  /**
   * Record one sighting. Extends the track's presence span and refreshes its
   * key-frame handle (a re-shot key frame is a better one, and the newest is
   * also the nearest to the pick-up — the same trade as above).
   */
  note(obs: CollectorObservation): void {
    const current = this.byDevice.get(obs.deviceId)
    const next = new Map<string, CollectorPresence>()
    const horizon = obs.at - PACKAGE_COLLECTOR_RETENTION_MS
    if (current !== undefined) {
      for (const [id, p] of current) {
        if (p.lastAt < horizon) continue
        next.set(id, p)
      }
    }
    const prev = next.get(obs.trackId)
    next.set(obs.trackId, {
      trackId: obs.trackId,
      className: obs.className,
      firstAt: prev === undefined ? obs.at : Math.min(prev.firstAt, obs.at),
      lastAt: prev === undefined ? obs.at : Math.max(prev.lastAt, obs.at),
      ...(obs.keyFrameMediaId !== undefined
        ? { keyFrameMediaId: obs.keyFrameMediaId }
        : prev?.keyFrameMediaId !== undefined
          ? { keyFrameMediaId: prev.keyFrameMediaId }
          : {}),
    })
    this.byDevice.set(obs.deviceId, evictOldest(next))
  }

  /**
   * The track nearest the pick-up instant, or `null` when nobody qualifies.
   *
   * `null` is a real answer and not an error: a parcel can stop being seen
   * because the light changed or the detector lost it, and naming a person who
   * was not there would be worse than naming nobody. The caller degrades to the
   * parcel's own owner and logs it.
   */
  pickCollector(input: PickCollectorInput): PackageCollector | null {
    const presences = this.byDevice.get(input.deviceId)
    if (presences === undefined || presences.size === 0) return null
    const maxSkewMs = input.maxSkewMs ?? PACKAGE_COLLECTOR_MAX_SKEW_MS
    let best: PackageCollector | null = null
    let bestLastAt = Number.NEGATIVE_INFINITY
    for (const p of presences.values()) {
      const observedAt = clamp(input.pickupAt, p.firstAt, p.lastAt)
      const skewMs = Math.abs(observedAt - input.pickupAt)
      if (skewMs > maxSkewMs) continue
      // Nearest wins; an exact tie goes to the presence that lasted LATER.
      if (
        best !== null &&
        (skewMs > best.skewMs || (skewMs === best.skewMs && p.lastAt <= bestLastAt))
      ) {
        continue
      }
      best = {
        trackId: p.trackId,
        className: p.className,
        observedAt,
        skewMs,
        ...(p.keyFrameMediaId !== undefined ? { keyFrameMediaId: p.keyFrameMediaId } : {}),
      }
      bestLastAt = p.lastAt
    }
    return best
  }

  /**
   * Fold one pipeline frame in. Returns how many presences it touched, so the
   * caller can say "nobody was ever in the drop-off zone" with a number.
   *
   * This is the ONLY place the frame-shaped input is interpreted, so the
   * production path and the test path read the same rules: a non-package class,
   * inside a configured drop-off zone, on this frame.
   */
  noteFrame(input: CollectorFrameInput): number {
    if (input.packageZoneIds.size === 0) return 0
    let noted = 0
    for (const t of input.tracked) {
      if (input.packageClasses.has(t.className)) continue
      if (!isDelivererInPackageZone(t.zones, input.packageZoneIds)) continue
      const keyFrameMediaId = input.keyFrameMediaIdFor(t.trackId)
      this.note({
        deviceId: input.deviceId,
        trackId: t.trackId,
        className: t.className,
        at: input.timestamp,
        ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
      })
      noted += 1
    }
    return noted
  }

  /** Drop a camera's memory (unbind / step disabled / device removal). */
  forgetDevice(deviceId: number): void {
    this.byDevice.delete(deviceId)
  }

  reset(): void {
    this.byDevice.clear()
  }

  /** Retained presences for a camera — diagnostics and tests only. */
  debugPresenceCount(deviceId: number): number {
    return this.byDevice.get(deviceId)?.size ?? 0
  }
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low
  if (value > high) return high
  return value
}

/** Keep the newest {@link PACKAGE_COLLECTOR_MAX_PRESENCES} by `lastAt`. */
function evictOldest(
  presences: ReadonlyMap<string, CollectorPresence>,
): ReadonlyMap<string, CollectorPresence> {
  if (presences.size <= PACKAGE_COLLECTOR_MAX_PRESENCES) return presences
  const ordered = [...presences.values()].sort((a, b) => b.lastAt - a.lastAt)
  const kept = new Map<string, CollectorPresence>()
  for (const p of ordered.slice(0, PACKAGE_COLLECTOR_MAX_PRESENCES)) kept.set(p.trackId, p)
  return kept
}
