// ---------------------------------------------------------------------------
// recording-timeline-model — pure, testable logic for the navigable timeline:
// server-driven density bucketization, seek-target resolution against
// recorded spans, ms→percent positioning, and view-state helpers. No React, no I/O.
// ---------------------------------------------------------------------------

import type { PlaybackSpan } from './recording-spans'

/** Fixed heatmap bucket size: 15 minutes → 96 buckets over 24h. */
export const BUCKET_MS: number = 15 * 60 * 1000

/** Event kinds the timeline understands. */
export type TimelineKind = 'motion' | 'object' | 'audio'

/** Tie-break precedence for a bucket's dominant kind (first wins on equal count). */
const KIND_PRECEDENCE: readonly TimelineKind[] = ['object', 'motion', 'audio']

export interface DensityBucket {
  readonly index: number
  readonly startMs: number
  readonly endMs: number
  readonly counts: Readonly<Record<TimelineKind, number>>
  readonly total: number
  /** Highest-count kind, or null when the bucket is empty. */
  readonly dominant: TimelineKind | null
}

/** Row returned by the server `getEventDensity` call (one per non-empty bucket). */
export interface EventDensityRow {
  readonly bucketStart: number
  readonly motion: number
  readonly object: number
  readonly audio: number
}

/**
 * Convert server-side density rows into `DensityBucket[]` for the timeline
 * heatmap. Rows with total === 0 are skipped (defensive; server already omits
 * them). Returns a sparse, ascending-by-index array — EventHeatmap positions
 * each bar by `b.startMs` rather than array index, so gaps are fine.
 */
export function densityRowsToBuckets(
  rows: readonly EventDensityRow[],
  windowFrom: number,
  bucketMs: number,
): DensityBucket[] {
  const buckets: DensityBucket[] = []
  for (const row of rows) {
    const counts: Record<TimelineKind, number> = {
      motion: row.motion,
      object: row.object,
      audio: row.audio,
    }
    const total = counts.motion + counts.object + counts.audio
    if (total === 0) continue

    const index = Math.floor((row.bucketStart - windowFrom) / bucketMs)
    let dominant: TimelineKind | null = null
    let best = -1
    // First kind in KIND_PRECEDENCE wins equal counts (strict `>` below).
    for (const kind of KIND_PRECEDENCE) {
      if (counts[kind] > best) {
        best = counts[kind]
        dominant = kind
      }
    }

    buckets.push({
      index,
      startMs: row.bucketStart,
      endMs: row.bucketStart + bucketMs,
      counts,
      total,
      dominant,
    })
  }
  return buckets.toSorted((a, b) => a.index - b.index)
}

export interface SeekTarget {
  readonly fromMs: number
  readonly toMs: number
}

/** Distance from `ms` to the interval `[startMs, endMs]` (0 if inside). */
function distanceToSpan(ms: number, span: PlaybackSpan): number {
  if (ms < span.startMs) return span.startMs - ms
  if (ms > span.endMs) return ms - span.endMs
  return 0
}

/**
 * Resolve a playback window for a click at `clickMs` against recorded `spans`.
 * Inside a span → play from the click to that span's end. In a gap / outside →
 * snap to the WHOLE nearest span. No spans → null (nothing to play).
 * `spans` are expected ascending by start (as `mergeAvailabilitySpans` returns).
 */
export function seekTargetForSpans(
  clickMs: number,
  spans: readonly PlaybackSpan[],
): SeekTarget | null {
  if (spans.length === 0) return null
  // Inclusive end: clicking the exact end of a span plays from there, not snap.
  const containing = spans.find((s) => clickMs >= s.startMs && clickMs <= s.endMs)
  if (containing) return { fromMs: clickMs, toMs: containing.endMs }

  let nearest: PlaybackSpan | null = null
  let bestDist = Infinity
  for (const s of spans) {
    const d = distanceToSpan(clickMs, s)
    if (d < bestDist) {
      bestDist = d
      nearest = s
    }
  }
  return nearest ? { fromMs: nearest.startMs, toMs: nearest.endMs } : null
}

/**
 * Position `ms` inside the window `[fromMs, toMs]` as a clamped percentage
 * (0–100). A zero/negative-width window yields 0. Callers use this for `left:`.
 */
export function pctForMs(ms: number, fromMs: number, toMs: number): number {
  const span = toMs - fromMs
  if (span <= 0) return 0
  const pct = ((ms - fromMs) / span) * 100
  if (pct < 0) return 0
  if (pct > 100) return 100
  return pct
}

// ---------------------------------------------------------------------------
// D2 — DayWindow + dayWindow
// ---------------------------------------------------------------------------

/** A [fromMs, toMs) window spanning (at most) one calendar day. */
export interface DayWindow {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * Build a DayWindow for the given calendar `date` using local time.
 * For any day strictly in the past: `fromMs` = local midnight, `toMs` =
 * next local midnight (exactly 24 h).
 * For today (or any future day that contains `nowMs`): `toMs = nowMs` so the
 * window never extends into the future.
 */
export function dayWindow(date: Date, nowMs: number): DayWindow {
  const fromMs = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime()
  const nextMidnight = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
    0,
    0,
    0,
    0,
  ).getTime()
  const toMs = Math.min(nextMidnight, nowMs)
  // If the caller passes a date in the future (nowMs < fromMs) clamp toMs to
  // at least fromMs so we never have a negative-width window.
  return { fromMs, toMs: Math.max(fromMs, toMs) }
}

// ---------------------------------------------------------------------------
// D3 — zoom / pan / adaptive bucketing
// ---------------------------------------------------------------------------

/** Available zoom levels in ms, from widest (24h) to narrowest (15 min). */
export const ZOOM_LEVELS: readonly number[] = [
  24 * 3600_000, // 24h
  12 * 3600_000, // 12h
  6 * 3600_000, // 6h
  3600_000, // 1h
  15 * 60_000, // 15min
]

/**
 * Produce a `levelMs`-wide window whose RIGHT edge stays anchored at
 * `rightEdgeMs` (clamped within `dayBounds`), rather than centring on the view
 * midpoint. On today's timeline the view's right edge is "now", so zooming this
 * way keeps the most recent footage pinned to the right instead of drifting to
 * a midday range that no longer contains now. Panning then moves back/forward.
 *
 * Falls back to `dayBounds` when `levelMs` meets or exceeds the day span (can't
 * show a wider window than the day holds — e.g. early morning with little
 * elapsed time).
 */
export function zoomWindowAnchoredRight(
  dayBounds: DayWindow,
  levelMs: number,
  rightEdgeMs: number,
): DayWindow {
  const daySpan = dayBounds.toMs - dayBounds.fromMs
  if (levelMs >= daySpan) return dayBounds

  // Clamp the right edge into bounds (never past the day end, never so early
  // that a full levelMs window would start before the day begins), then place
  // the window immediately to its left.
  const toMs = Math.min(Math.max(rightEdgeMs, dayBounds.fromMs + levelMs), dayBounds.toMs)
  return { fromMs: toMs - levelMs, toMs }
}

/**
 * Shift `win` by `deltaMs`, preserving width, clamped within `dayBounds`.
 */
export function panWindow(win: DayWindow, dayBounds: DayWindow, deltaMs: number): DayWindow {
  const width = win.toMs - win.fromMs
  let fromMs = win.fromMs + deltaMs
  let toMs = win.toMs + deltaMs

  if (fromMs < dayBounds.fromMs) {
    fromMs = dayBounds.fromMs
    toMs = fromMs + width
  }
  if (toMs > dayBounds.toMs) {
    toMs = dayBounds.toMs
    fromMs = toMs - width
  }

  return { fromMs, toMs }
}

/** Candidate bucket sizes in ms (coarsest first). */
const BUCKET_CANDIDATES: readonly number[] = [
  15 * 60_000, // 15 min
  5 * 60_000, // 5 min
  60_000, // 1 min
  30_000, // 30 s
  15_000, // 15 s
  5_000, // 5 s
]

/**
 * Choose a sensible heatmap bucket size for a visible span of `spanMs`,
 * targeting ~96-120 buckets. Always picks from `BUCKET_CANDIDATES`.
 */
export function bucketMsForSpan(spanMs: number): number {
  // Target ~100 buckets; find the coarsest candidate that stays below that.
  const targetBucket = spanMs / 100

  // Walk coarse→fine; take the first candidate <= targetBucket, else the finest.
  for (const candidate of BUCKET_CANDIDATES) {
    if (candidate <= targetBucket) return candidate
  }
  // Span is very narrow — use the finest bucket.
  const finest = BUCKET_CANDIDATES[BUCKET_CANDIDATES.length - 1]
  return finest ?? 5_000
}

// ---------------------------------------------------------------------------
// D4 — axis ticks
// ---------------------------------------------------------------------------

/** One labelled tick on the time axis. */
export interface AxisTick {
  readonly pct: number
  readonly label: string
}

/**
 * Produce `count` evenly-spaced axis ticks spanning [fromMs, toMs].
 * - `pct` is via pctForMs (first=0, last=100).
 * - `label` is a localised HH:MM clock string.
 */
export function axisTicks(fromMs: number, toMs: number, count: number): AxisTick[] {
  if (count <= 1) {
    const label = new Date(fromMs).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })
    return [{ pct: 0, label }]
  }

  const ticks: AxisTick[] = []
  for (let i = 0; i < count; i++) {
    const ms = fromMs + (i / (count - 1)) * (toMs - fromMs)
    const pct = pctForMs(ms, fromMs, toMs)
    const label = new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    ticks.push({ pct, label })
  }
  return ticks
}
