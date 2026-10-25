/**
 * event-child-crops — pure helpers for joining ObjectEvent→childCrops.
 *
 * The join uses IoU (Intersection-over-Union) between the event bbox and the
 * first-level detection bbox, because `det.track?.trackId` is NEVER populated
 * on raw `frame.detections`: trackId is assigned downstream by the tracker and
 * only lives on `result.objectEvents`/`result.tracked`, not back-written onto
 * `frame.detections`. Any approach relying on trackId/sourceId from the
 * detection side silently produces an empty map.
 *
 * IoU is the correct spatial join key here because:
 *   - ObjectEvent.bbox is the tracker-smoothed position at emit time, which
 *     should be close (but not pixel-identical) to the raw detector bbox in the
 *     same frame.
 *   - A threshold of 0.3 is permissive enough to tolerate tracker smoothing
 *     while rejecting accidental near-misses between distinct objects.
 */

import type { ObjectDetection } from '@camstack/types'

/** Pixel-space bounding box with (x,y,w,h) semantics — matches ObjectEvent.bbox. */
export interface PixelBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface ChildCrop {
  readonly kind: 'faceCrop' | 'plateCrop'
  readonly bbox: PixelBox
}

/**
 * Compute Intersection-over-Union between two (x,y,w,h) bounding boxes.
 * Returns 0 when either box has zero area or there is no overlap.
 */
export function iou(a: PixelBox, b: PixelBox): number {
  const ax2 = a.x + a.w
  const ay2 = a.y + a.h
  const bx2 = b.x + b.w
  const by2 = b.y + b.h

  const ix1 = Math.max(a.x, b.x)
  const iy1 = Math.max(a.y, b.y)
  const ix2 = Math.min(ax2, bx2)
  const iy2 = Math.min(ay2, by2)

  const interW = ix2 - ix1
  const interH = iy2 - iy1
  if (interW <= 0 || interH <= 0) return 0

  const intersection = interW * interH
  const areaA = a.w * a.h
  const areaB = b.w * b.h
  const union = areaA + areaB - intersection
  if (union <= 0) return 0

  return intersection / union
}

/** Minimum IoU required to accept a first-level detection as the spatial match
 *  for a given event bbox. Below this value the event gets no childCrops. */
const MIN_IOU = 0.3

/**
 * Build a Map<eventId, ChildCrop[]> by spatially joining each ObjectEvent to
 * the best-matching first-level detection in `detections`, then attaching that
 * detection's face/plate detail crops.
 *
 * Algorithm:
 *   1. Scan `detections` once to build:
 *      - `firstLevelBoxes`: Map<detId, PixelBox> for all first-level entries
 *      - `detectionChildCrops`: Map<detId, ChildCrop[]> for detail entries
 *        (face/plate only, first-per-kind)
 *   2. For each event that carries a bbox, find the first-level detection with
 *      the highest IoU; require IoU >= MIN_IOU.
 *   3. Return the assembled Map.
 *
 * @param objectEvents  Lightweight event descriptors — only `id` and `bbox` are
 *                      consumed.  The full ObjectEvent type satisfies this shape.
 * @param detections    Raw frame detections (ObjectDetection[]) — the same array
 *                      passed as `frame.detections` at the call-site.
 */
export function buildEventChildCrops(
  objectEvents: ReadonlyArray<{ readonly id: number; readonly bbox?: PixelBox }>,
  detections: readonly ObjectDetection[],
): Map<number, ChildCrop[]> {
  // --- pass 1: index detections ---
  const firstLevelBoxes = new Map<string, PixelBox>()
  const detectionChildCrops = new Map<string, ChildCrop[]>()

  for (const det of detections) {
    if (det.kind === 'first-level') {
      firstLevelBoxes.set(det.id, {
        x: det.bbox.x,
        y: det.bbox.y,
        w: det.bbox.width,
        h: det.bbox.height,
      })
    } else if (det.kind === 'detail' && det.parentId) {
      const macro = det.macroClass
      if (macro !== 'face' && macro !== 'plate') continue
      const kind: 'faceCrop' | 'plateCrop' = macro === 'face' ? 'faceCrop' : 'plateCrop'
      const existing = detectionChildCrops.get(det.parentId) ?? []
      // Keep only the first entry per kind (whichever appears first in the array).
      if (!existing.some((c) => c.kind === kind)) {
        existing.push({
          kind,
          bbox: {
            x: det.bbox.x,
            y: det.bbox.y,
            w: det.bbox.width,
            h: det.bbox.height,
          },
        })
      }
      detectionChildCrops.set(det.parentId, existing)
    }
  }

  // --- pass 2: match each event to its best first-level detection ---
  // Keyed by the NUMERIC event id (D474): this map never leaves the frame
  // path, so there is nothing here to stringify for.
  const result = new Map<number, ChildCrop[]>()

  for (const event of objectEvents) {
    if (!event.bbox) continue

    let bestDetId: string | undefined
    let bestIou = MIN_IOU // must beat this to be accepted

    for (const [detId, detBox] of firstLevelBoxes) {
      const score = iou(event.bbox, detBox)
      if (score > bestIou) {
        bestIou = score
        bestDetId = detId
      }
    }

    if (bestDetId === undefined) continue
    const crops = detectionChildCrops.get(bestDetId)
    if (crops && crops.length > 0) {
      result.set(event.id, crops)
    }
  }

  return result
}
