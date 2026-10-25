/**
 * The notification still must show the subject IN the zone that fired the rule.
 *
 * ## The defect this exists to fix
 *
 * A rule named "Persona su Uscio" fires on one condition — a person whose box
 * overlaps the Uscio polygon — and then attaches a picture chosen by a ladder
 * that has never heard of Uscio. The ladder's first rung for `frame:'full'` is
 * the TRACK's `keyFrame`, i.e. the track's best shot: a whole-track quantity,
 * ranked for the gallery (square containment D212, semantic promotion D213),
 * and routinely a LATER frame than the trigger — not least because a native
 * key-frame capture that misses retries and lands on whatever is on screen
 * when it finally succeeds.
 *
 * Measured on the live install (device 101, 18–21/08/2026, 54 fires, delivered
 * bytes read back off the artefact shelf and each frame's instant read off the
 * camera's own burnt-in clock): **9 of 54 (17%)** shipped a still whose subject
 * box had ZERO overlap with Uscio. The report that produced this file — 21/08
 * 18:57:29, track d0f63887… — delivered the frame 4.9 s after the trigger, with
 * the subject 144 px (22% of the frame width) outside the zone and the doorstep
 * visibly empty. Trigger→enqueue was 14 ms and enqueue→sent 7.7 s that day, both
 * nominal: nothing was late, the picture was simply about a different moment.
 *
 * ## The rule
 *
 * FILTER, never re-rank. The existing ladder keeps deciding which KIND of
 * picture a rule gets; this only removes the candidates that would make the
 * notification lie about its own reason. When no candidate qualifies — the
 * subject only ever existed outside the zone in a frame we hold pixels for —
 * every candidate comes back and the ladder runs exactly as it did before: a
 * real picture beats no picture.
 *
 * The track's own best shot is NOT touched. It answers a different question
 * (which frame of this track is the best likeness) and D212/D213 tuned it for
 * that question; the notification asks a narrower one (which frame is about the
 * thing I am telling you) and is allowed a different answer.
 */

import type { MediaFileKind } from '@camstack/types'
import { bboxPolygonOverlap } from '../pipeline-analytics/pipeline/zones/overlap.js'

/** A point of the subject's trail — normalized 0..1, the same space
 *  `NcDispatcherDeps.getZonePolygons` returns. */
export interface NcSubjectTrailPoint {
  readonly timestamp: number
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

/** One picture the ladder is willing to attach, with the instant it shows. */
export interface NcStillCandidate {
  readonly kind: MediaFileKind
  readonly timestamp: number
}

/** Normalized zone polygon, as `getZonePolygons` returns it. */
export type NcZonePolygon = ReadonlyArray<{ readonly x: number; readonly y: number }>

export interface NcTriggerZoneInput<C extends NcStillCandidate> {
  /** The ladder's candidates, IN LADDER ORDER. */
  readonly candidates: readonly C[]
  readonly trail: readonly NcSubjectTrailPoint[]
  readonly polygons: readonly NcZonePolygon[]
  /** The instant the rule fired, for the log line that reports a substitution. */
  readonly triggerAt: number
  /**
   * NOTHING QUALIFYING MEANS "NOT YET", NOT "SHIP THE WRONG PLACE".
   *
   * The caller sets this while a better frame can still land, and the empty
   * list tells it to keep waiting. Left unset — the give-up pass, and every
   * caller that cannot wait — the filter degrades as it always has: when nobody
   * qualifies the whole list comes back, because a real picture beats no
   * picture.
   */
  readonly strict?: boolean
}

/**
 * How far a candidate's instant may sit from the nearest trail point before the
 * trail stops speaking for it.
 *
 * 2 s. The live detection cadence on this install is 100–300 ms and the widest
 * real gap inside a track is a couple of seconds (a session gap); beyond that
 * the nearest point is about a different moment, and answering "in the zone"
 * from it would be a guess. An unanswerable candidate is treated as NOT
 * qualifying — never as disqualifying the others, and never as a reason to ship
 * nothing.
 */
export const TRAIL_MATCH_MAX_MS = 2_000

/** Overlap of a normalized box with the union of the zones — the maximum over
 *  the polygons, which is what "any of these zones" means for one box. */
function zoneOverlap(point: NcSubjectTrailPoint, polygons: readonly NcZonePolygon[]): number {
  let best = 0
  for (const polygon of polygons) {
    if (polygon.length < 3) continue
    // Both the box and the polygon are in the SAME normalized 0..1 space, so
    // the sampler needs no frame dimensions: it samples the box's own grid.
    const overlap = bboxPolygonOverlap(point.bbox, polygon)
    if (overlap > best) best = overlap
  }
  return best
}

/** The trail point closest to `timestamp`, or null when none is within `maxMs`
 *  (default {@link TRAIL_MATCH_MAX_MS}). */
export function trailAt(
  trail: readonly NcSubjectTrailPoint[],
  timestamp: number,
  maxMs: number = TRAIL_MATCH_MAX_MS,
): NcSubjectTrailPoint | null {
  let best: NcSubjectTrailPoint | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (const point of trail) {
    const delta = Math.abs(point.timestamp - timestamp)
    if (delta < bestDelta) {
      bestDelta = delta
      best = point
    }
  }
  return best !== null && bestDelta <= maxMs ? best : null
}

/**
 * The candidates that show the subject inside the triggering zone, in the order
 * they were given. Every candidate comes back unchanged when the question
 * cannot be asked (no trail, no polygon) or when nobody qualifies.
 */
export function selectTriggerZoneCandidates<C extends NcStillCandidate>(
  input: NcTriggerZoneInput<C>,
): readonly C[] {
  const { candidates, trail, polygons, strict } = input
  // Unanswerable, at any strictness: a question we cannot ask must never drop
  // the right frame.
  if (candidates.length === 0 || trail.length === 0 || polygons.length === 0) return candidates
  const qualifying = candidates.filter((candidate) => {
    const point = trailAt(trail, candidate.timestamp)
    return point !== null && zoneOverlap(point, polygons) > 0
  })
  if (qualifying.length > 0) return qualifying
  return strict === true ? [] : candidates
}
