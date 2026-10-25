import { pointInPolygon, type Point, type BboxRect } from './geometry.js'

/**
 * Calculate overlap of a bounding box with a polygon.
 * Uses sampling: divides bbox into grid, counts points inside polygon.
 * Returns fraction 0–1 (intersection area / bbox area).
 */
export function bboxPolygonOverlap(bbox: BboxRect, polygon: readonly Point[]): number {
  const area = bbox.w * bbox.h
  if (area <= 0) return 0

  const gridSize = 8
  let inside = 0
  const total = gridSize * gridSize

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const px = bbox.x + (col + 0.5) * (bbox.w / gridSize)
      const py = bbox.y + (row + 0.5) * (bbox.h / gridSize)
      if (pointInPolygon({ x: px, y: py }, polygon)) {
        inside++
      }
    }
  }

  return inside / total
}

/**
 * Calculate overlap of a segmentation mask with a polygon.
 * Mask is a binary array (0/1) at maskWidth×maskHeight resolution,
 * positioned at bbox within a frame of frameWidth×frameHeight.
 * Polygon points are in pixel coordinates.
 * Returns fraction 0–1 (mask pixels inside polygon / total mask pixels).
 */
export function maskPolygonOverlap(
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  bbox: BboxRect,
  polygon: readonly Point[],
  _frameWidth: number,
  _frameHeight: number,
): number {
  let totalMaskPixels = 0
  let insidePolygon = 0

  for (let my = 0; my < maskHeight; my++) {
    for (let mx = 0; mx < maskWidth; mx++) {
      if (mask[my * maskWidth + mx] === 0) continue
      totalMaskPixels++

      const frameX = bbox.x + (mx / maskWidth) * bbox.w
      const frameY = bbox.y + (my / maskHeight) * bbox.h

      if (pointInPolygon({ x: frameX, y: frameY }, polygon)) {
        insidePolygon++
      }
    }
  }

  if (totalMaskPixels === 0) return 0
  return insidePolygon / totalMaskPixels
}
