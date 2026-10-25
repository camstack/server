/**
 * Which of the boxes the operator's class floor dropped may be handed to the
 * tracker as LOW-SCORE continuation evidence (D665).
 *
 * The executor already carries every refused box on `FrameResult.discarded`
 * (for the viewer's ghost overlay), so no new wire field is needed: a
 * `below-threshold` entry at or above {@link LOW_SCORE_CONTINUATION_FLOOR_DEFAULT}
 * of an eligible class becomes a `SpatialDetection` on the tracker's separate
 * `lowScore` list. It never enters `frame.detections`, so nothing that reads
 * detections — zones, events, notifications, best shot, enrichment — sees it.
 *
 * The floor, 0.35: on 2026-09-27 the person boxes the tracker was given formed
 * a distribution TRUNCATED at the 0.65 cut, with its mode in the first band
 * (0.65–0.70 = 583, 0.70–0.75 = 372, 0.75–0.80 = 242) — mass is piling up
 * against the floor, so there is mass just below it. 0.35 takes the 0.30-wide
 * band under the cut and stays below the tracker's old `byteTrackHighThreshold`
 * (0.4), which was set with such a tier under it in mind. A box that can only
 * continue an already-confirmed track, on the predicted box, is bounded in the
 * harm it can do; the per-band counts on `pipeline stats` (`belowFloor`) are
 * what re-tune it.
 *
 * `vehicle` is excluded on purpose: the stationary registry holds parked cars,
 * and a sub-floor box on a parked car beside a passing one is exactly the hop
 * D410 refuses a held box.
 */
import type { BoundingBox, DiscardedDetection, SpatialDetection } from '@camstack/types'
import { LINGERING_CLASSES } from '../tracker-v2/constants.js'

export const LOW_SCORE_CONTINUATION_FLOOR_DEFAULT = 0.35

/** `[x1, y1, x2, y2]` (the discard trail's tuple) → the tracker's rectangle. */
function toRect(bbox: DiscardedDetection['bbox']): BoundingBox {
  const [x1, y1, x2, y2] = bbox
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/**
 * The continuation candidates of one frame. `floor === null` means the tier is
 * off for this camera and nothing is selected.
 */
export function selectLowScoreContinuations(
  discarded: readonly DiscardedDetection[] | undefined,
  floor: number | null,
): SpatialDetection[] {
  if (floor === null || discarded === undefined) return []
  const out: SpatialDetection[] = []
  for (const d of discarded) {
    if (d.reason !== 'below-threshold') continue
    if (d.score < floor) continue
    if (!LINGERING_CLASSES.has(d.macroClass)) continue
    const bbox = toRect(d.bbox)
    if (bbox.w <= 0 || bbox.h <= 0) continue
    out.push({ class: d.macroClass, originalClass: d.macroClass, score: d.score, bbox })
  }
  return out
}
