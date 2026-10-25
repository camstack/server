export interface Point {
  readonly x: number
  readonly y: number
}

export interface LineSegment {
  readonly p1: Point
  readonly p2: Point
}

export interface BboxRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface TripwireResult {
  readonly crossed: boolean
  readonly direction: 'left' | 'right'
}

/** Ray-casting point-in-polygon test */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x,
      yi = polygon[i]!.y
    const xj = polygon[j]!.x,
      yj = polygon[j]!.y
    const intersect =
      yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** Parametric line-segment intersection. Returns intersection point or null. */
function lineIntersection(a: LineSegment, b: LineSegment): Point | null {
  const dx1 = a.p2.x - a.p1.x
  const dy1 = a.p2.y - a.p1.y
  const dx2 = b.p2.x - b.p1.x
  const dy2 = b.p2.y - b.p1.y

  const denom = dx1 * dy2 - dy1 * dx2
  if (Math.abs(denom) < 1e-10) return null

  const t = ((b.p1.x - a.p1.x) * dy2 - (b.p1.y - a.p1.y) * dx2) / denom
  const u = ((b.p1.x - a.p1.x) * dy1 - (b.p1.y - a.p1.y) * dx1) / denom

  if (t < 0 || t > 1 || u < 0 || u > 1) return null

  return { x: a.p1.x + t * dx1, y: a.p1.y + t * dy1 }
}

/** Detect tripwire crossing and direction via cross product. */
export function tripwireCrossing(
  prev: Point,
  curr: Point,
  wire: LineSegment,
): TripwireResult | null {
  const movement: LineSegment = { p1: prev, p2: curr }
  const intersection = lineIntersection(movement, wire)
  if (!intersection) return null

  const cross =
    (curr.x - prev.x) * (wire.p2.y - wire.p1.y) - (curr.y - prev.y) * (wire.p2.x - wire.p1.x)

  return { crossed: true, direction: cross > 0 ? 'right' : 'left' }
}

/** Centroid of a bounding box { x, y, w, h } */
export function bboxCentroid(bbox: BboxRect): Point {
  return { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 }
}

/** Convert normalized (0–1) coordinates to pixel coordinates */
export function normalizeToPixel(p: Point, width: number, height: number): Point {
  return { x: p.x * width, y: p.y * height }
}
