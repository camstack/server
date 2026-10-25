/**
 * Pure geometry helpers for the zone-filtered track query (Part A).
 *
 * Coordinate model:
 *   - Track positions are PIXEL coords in the detection-frame space, with a
 *     per-detection bbox `{x, y, w, h}` (top-left origin).
 *   - Zones are NORMALIZED 0..1 of the camera frame (the shared MaskShape
 *     vocabulary: rect / polygon).
 *   - The persisted track envelope is the normalized min/max over all
 *     positions' bboxes (bbox x/w ÷ frameWidth, y/h ÷ frameHeight).
 *
 * All functions are pure and side-effect free.
 */
import type { TrackZoneFilter } from '@camstack/types'

export interface NormalizedEnvelope {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

interface PositionLike {
  readonly x: number
  readonly y: number
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

interface PointLike {
  readonly x: number
  readonly y: number
}

/**
 * Normalized min/max envelope over every position's bbox. Returns `null`
 * when the frame dimensions are unknown/degenerate or there are no
 * positions — the caller persists NULL envelope columns in that case.
 */
export function computeTrackEnvelope(
  positions: readonly PositionLike[],
  frameWidth: number | undefined,
  frameHeight: number | undefined,
): NormalizedEnvelope | null {
  if (
    frameWidth === undefined ||
    frameHeight === undefined ||
    !(frameWidth > 0) ||
    !(frameHeight > 0) ||
    positions.length === 0
  ) {
    return null
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const p of positions) {
    const x0 = p.bbox.x / frameWidth
    const y0 = p.bbox.y / frameHeight
    const x1 = (p.bbox.x + p.bbox.w) / frameWidth
    const y1 = (p.bbox.y + p.bbox.h) / frameHeight
    if (x0 < minX) minX = x0
    if (y0 < minY) minY = y0
    if (x1 > maxX) maxX = x1
    if (y1 > maxY) maxY = y1
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Axis-aligned bounds of a zone filter (rect: itself; polygon: vertex
 * min/max). A degenerate polygon (< 3 points) yields the full frame so the
 * SQL prefilter never silently drops rows the precise test would keep.
 */
export function zoneBounds(zone: TrackZoneFilter): NormalizedEnvelope {
  if (zone.kind === 'rect') {
    return { minX: zone.x, minY: zone.y, maxX: zone.x + zone.width, maxY: zone.y + zone.height }
  }
  if (zone.points.length < 3) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const p of zone.points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/** Whether two axis-aligned envelopes overlap (touching edges count). */
export function envelopesOverlap(a: NormalizedEnvelope, b: NormalizedEnvelope): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

/**
 * Ray-casting point-in-polygon (even-odd rule). Points on an edge may
 * resolve either way — acceptable for zone filtering. A polygon with
 * fewer than 3 vertices contains nothing.
 */
export function pointInPolygon(point: PointLike, polygon: readonly PointLike[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!
    const b = polygon[j]!
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (intersects) inside = !inside
  }
  return inside
}

/**
 * Precise per-position zone test.
 *
 *   - rect zone     → any position bbox (normalized) intersects the rect.
 *   - polygon zone  → any position CENTER (normalized `x`/`y` — positions
 *                     store the bbox center) falls inside the polygon.
 *
 * Unknown/degenerate frame dims → `true` (the track cannot be tested, so it
 * PASSES — mirroring the NULL-envelope-matches rule).
 */
export function positionsIntersectZone(
  positions: readonly PositionLike[],
  frameWidth: number | undefined,
  frameHeight: number | undefined,
  zone: TrackZoneFilter,
): boolean {
  if (
    frameWidth === undefined ||
    frameHeight === undefined ||
    !(frameWidth > 0) ||
    !(frameHeight > 0)
  ) {
    return true
  }
  if (zone.kind === 'rect') {
    const rect = zoneBounds(zone)
    for (const p of positions) {
      const box: NormalizedEnvelope = {
        minX: p.bbox.x / frameWidth,
        minY: p.bbox.y / frameHeight,
        maxX: (p.bbox.x + p.bbox.w) / frameWidth,
        maxY: (p.bbox.y + p.bbox.h) / frameHeight,
      }
      if (envelopesOverlap(box, rect)) return true
    }
    return false
  }
  for (const p of positions) {
    const center: PointLike = { x: p.x / frameWidth, y: p.y / frameHeight }
    if (pointInPolygon(center, zone.points)) return true
  }
  return false
}
