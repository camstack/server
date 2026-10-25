/**
 * static-track-gate — pure geometry for the key-event static-object gate.
 *
 * A track that never actually moved over its whole life (a pile of clothes read
 * as "person", a kitchen object read as "animal") should not become a salient
 * key event. This measures two complementary signals over the track's centroid
 * path, each normalized to a reference length so the threshold is scale-
 * invariant (independent of resolution):
 *
 *  - `netDisplacementFrac` — straight-line distance from the first to the last
 *    centroid (did the object end up anywhere else?).
 *  - `pathSpanFrac` — the diagonal of the bounding box of ALL centroids (did the
 *    object roam at all, even in a loop that returns near its start?).
 *
 * Requiring BOTH to be tiny keeps a big-loop walker (small net, large span)
 * out of the "static" bucket while catching a genuinely stationary object.
 *
 * The reference length is the frame diagonal when known; when it isn't (e.g.
 * on-read scoring of a legacy row with no frame geometry) the caller can pass
 * the track's average bbox diagonal via {@link averageBboxDiagonal}. Mirrors the
 * `centroidMovedFraction` normalization in `snapshot-movement-gate.ts`.
 */

export interface StaticTrackPoint {
  readonly x: number
  readonly y: number
}

export interface StaticTrackBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface StaticTrackMetrics {
  /** First→last centroid distance as a fraction of the reference diagonal. */
  readonly netDisplacementFrac: number
  /** Diagonal of the centroid bounding box as a fraction of the reference. */
  readonly pathSpanFrac: number
}

/**
 * Net displacement + path span for a track's centroid path, normalized to
 * `referenceDiagonalPx`. Returns undefined when there is nothing meaningful to
 * measure (fewer than two points, or a degenerate ≤0 reference) so the caller
 * leaves the importance score untouched.
 */
export function computeStaticTrackMetrics(
  centroids: readonly StaticTrackPoint[],
  referenceDiagonalPx: number,
): StaticTrackMetrics | undefined {
  if (!(referenceDiagonalPx > 0) || centroids.length < 2) return undefined

  const first = centroids[0]!
  const last = centroids[centroids.length - 1]!
  const netDisplacementFrac = Math.hypot(last.x - first.x, last.y - first.y) / referenceDiagonalPx

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of centroids) {
    if (c.x < minX) minX = c.x
    if (c.x > maxX) maxX = c.x
    if (c.y < minY) minY = c.y
    if (c.y > maxY) maxY = c.y
  }
  const pathSpanFrac = Math.hypot(maxX - minX, maxY - minY) / referenceDiagonalPx

  return { netDisplacementFrac, pathSpanFrac }
}

/** Average bbox diagonal (px) across a track's positions — the scale reference
 *  when frame dimensions aren't available. Returns 0 for an empty list. */
export function averageBboxDiagonal(boxes: readonly StaticTrackBox[]): number {
  if (boxes.length === 0) return 0
  let sum = 0
  for (const b of boxes) sum += Math.hypot(b.w, b.h)
  return sum / boxes.length
}
