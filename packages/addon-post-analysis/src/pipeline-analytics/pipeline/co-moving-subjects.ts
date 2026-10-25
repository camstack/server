/**
 * Two tracks that occupy the same pixels at the same time and disagree about
 * what they are.
 *
 * This shape has now been paid for twice, in opposite directions:
 *
 *   - A person walking a dog produced ONE track. The `animal` label was
 *     produced and then REFUSED (`label tier collapse refused`,
 *     `refusal=macro-class`), so the dog left no trace of its own.
 *   - A person on a bicycle produced TWO — `cb8929d8` (vehicle, 32.3 s) and
 *     `9065ce35` (person, 11.3 s), the second living entirely inside the
 *     first — because person and vehicle are different macro-classes and
 *     nothing associates them.
 *
 * Neither case is a detection failure: both subjects were seen. What is
 * missing is any record that the two are TOGETHER, which is the fact an
 * operator reading the timeline is actually looking for.
 *
 * This module does not change either decision. It measures how often the
 * situation arises and how strongly the boxes agree, so the question "should
 * these be one subject, or two, and which way" can be answered from counts
 * rather than from two anecdotes.
 */

/** The slice of a track this measurement needs. */
export interface CoMovingBox {
  readonly trackId: string
  readonly className: string
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

/** One overlap worth reporting. */
export interface CoMovingPair {
  readonly trackId: string
  readonly className: string
  readonly otherTrackId: string
  readonly otherClassName: string
  /** Intersection over union, 0..1. */
  readonly iou: number
  /**
   * Intersection over the SMALLER box, 0..1 — "how contained is the smaller
   * one". A rider's box inside a bicycle's box has a modest IoU and a
   * containment near 1, and containment is the signal that matters here.
   */
  readonly containment: number
}

/**
 * Report at this much containment. A rider and a bicycle overlap heavily; two
 * people passing each other in the frame do not stay contained for long.
 * Deliberately a REPORTING threshold, not a decision one — nothing branches on
 * it, so it can be loose enough to see the near misses.
 */
export const CO_MOVING_MIN_CONTAINMENT = 0.6

function intersectionArea(a: CoMovingBox['bbox'], b: CoMovingBox['bbox']): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return x * y
}

/**
 * The overlaps a NEWLY born track has with live tracks of a DIFFERENT class.
 *
 * Same-class overlaps are excluded: those are the tracker's own duplicate
 * problem and are already measured elsewhere. A zero-area box reports nothing
 * rather than dividing by zero.
 */
export function findCoMovingPairs(
  born: readonly CoMovingBox[],
  live: readonly CoMovingBox[],
  minContainment: number = CO_MOVING_MIN_CONTAINMENT,
): readonly CoMovingPair[] {
  const out: CoMovingPair[] = []
  for (const b of born) {
    const areaB = b.bbox.w * b.bbox.h
    if (areaB <= 0) continue
    for (const o of live) {
      if (o.trackId === b.trackId) continue
      if (o.className === b.className) continue
      const areaO = o.bbox.w * o.bbox.h
      if (areaO <= 0) continue
      const inter = intersectionArea(b.bbox, o.bbox)
      if (inter <= 0) continue
      const union = areaB + areaO - inter
      const containment = inter / Math.min(areaB, areaO)
      if (containment < minContainment) continue
      out.push({
        trackId: b.trackId,
        className: b.className,
        otherTrackId: o.trackId,
        otherClassName: o.className,
        iou: union > 0 ? inter / union : 0,
        containment,
      })
    }
  }
  return out
}
