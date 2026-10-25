/**
 * How a track's `positions[]` becomes bytes, and back (D471).
 *
 * `positions` was 94.9 % of the `tracks` table and 17 % of the whole settings
 * database — 186.5 MB — and most of that was not information. See
 * `__tests__/position-codec.spec.ts` for the measurement and for why rounding
 * is safe only since D399.
 *
 * Pure on purpose: what a MALFORMED stored value decodes to is the decision
 * worth pinning in a test, and it is "an empty trail", never a throw.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import type { TrackPosition } from './track-store.js'

/**
 * Marks a value this module wrote. Chosen so it cannot collide with the plain
 * JSON array every pre-D471 row holds: that always starts `[`.
 */
const ENCODED_PREFIX = 'z1:'

/** Pixels are integers. The float tail is representation noise, not precision. */
export function roundPosition(p: TrackPosition): TrackPosition {
  return {
    ...p,
    x: Math.round(p.x),
    y: Math.round(p.y),
    bbox: {
      ...p.bbox,
      x: Math.round(p.bbox.x),
      y: Math.round(p.bbox.y),
      w: Math.round(p.bbox.w),
      h: Math.round(p.bbox.h),
    },
  }
}

/** Round, serialise, gzip, base64 — in that order, so the compressor sees the
 *  smaller text and the repeated field names it compresses best. */
export function encodePositions(positions: readonly TrackPosition[]): string {
  const json = JSON.stringify(positions.map(roundPosition))
  return ENCODED_PREFIX + gzipSync(Buffer.from(json, 'utf8'), { level: 6 }).toString('base64')
}

/**
 * Read a stored value, whichever era wrote it.
 *
 * THREE shapes reach here and all three are ordinary, which is what makes a
 * migration unnecessary: a `z1:` string this module wrote, a plain array (the
 * store parsed the JSON column for us), and a plain JSON string (it did not).
 * Anything else is a row we cannot read, and the answer is an empty trail —
 * the timeline then draws a track with no path, which an operator can SEE,
 * instead of failing the page, which they cannot.
 */
export function decodePositions(value: unknown): readonly TrackPosition[] {
  if (Array.isArray(value)) return value.filter(isPosition)
  if (typeof value !== 'string') return []
  if (value.startsWith(ENCODED_PREFIX)) {
    try {
      const raw = gunzipSync(Buffer.from(value.slice(ENCODED_PREFIX.length), 'base64')).toString(
        'utf8',
      )
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter(isPosition) : []
    } catch {
      return []
    }
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(isPosition) : []
  } catch {
    return []
  }
}

function isPosition(v: unknown): v is TrackPosition {
  if (typeof v !== 'object' || v === null) return false
  const p: Record<string, unknown> = { ...v }
  return typeof p['x'] === 'number' && typeof p['y'] === 'number' && typeof p['bbox'] === 'object'
}

/**
 * A trajectory reduced to the ONLY thing a zone-filtered reader uses (D471).
 *
 * The client's `parsePositionBoxes` walks `positions[]` and keeps `p.bbox`,
 * discarding `x`, `y`, `timestamp` and `source` the moment they arrive. On the
 * zone path — the one path that ships positions at all — that is **59 % of the
 * payload thrown away by the receiver**: 162 B per position sent, 66 B used.
 *
 * Measured on 20 130 real positions. This is the reduction, applied server-side
 * so the bytes are never spent.
 *
 * NOT applied to any other read: a caller that asked for a full trajectory gets
 * one. This is narrowing on the request that already narrowed.
 */
export function geometryOnlyPositions(
  positions: readonly TrackPosition[],
): readonly TrackPosition[] {
  return positions.map((p) => ({ x: p.bbox.x, y: p.bbox.y, timestamp: 0, bbox: p.bbox }))
}

/**
 * A detection box with integer pixel coordinates (D471).
 *
 * `object-events.bbox` carries the same float tail as `positions` did —
 * `{"w":1089.6000000000001,"h":398.40000000000003}` — and is 18 % of a 30 MB
 * table. Same cause: a pixel scaled by the analysis raster ratio, serialised
 * with every digit JavaScript can print.
 *
 * Returns the input unchanged when there is nothing to round, so a legacy row
 * with no bbox stays exactly what it was.
 */
export function roundBbox(bbox: unknown): unknown {
  if (typeof bbox !== 'object' || bbox === null) return bbox
  const b: Record<string, unknown> = { ...bbox }
  let touched = false
  for (const k of ['x', 'y', 'w', 'h']) {
    const v = b[k]
    if (typeof v === 'number' && Number.isFinite(v)) {
      b[k] = Math.round(v)
      touched = true
    }
  }
  return touched ? b : bbox
}
