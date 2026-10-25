/**
 * Rollup arithmetic (D850, plan §4/§5.5). PURE: rows in, rows out.
 *
 * Two operations, both a RECOMPUTE from the lower tier — never an increment —
 * so running one twice, or after a late write, gives the same answer:
 *
 *  - {@link rawToFiveMinuteRows}: change-only raw points into 5-minute rows,
 *    with the time-weighted sum `tw_sum` (Σ value·ms) a change-only gauge
 *    needs: 4m59s at 50 and 1s at 100 is a time-weighted mean of ~50, not 75.
 *  - {@link combineRows}: rows of the child tier into one row of the next.
 *
 * Held values. A change-only series writes a point only when the value
 * changes, so a quiet bucket has NO row and the value in force across it is
 * the last one before. Both operations take that value in (`carryIn`) and
 * credit the gap with it; without that, an hour that sat at 10 for 55 minutes
 * and jumped to 100 in the last five would be averaged over those five alone.
 * The held value also counts toward `min`/`max` when it was in force at the
 * start of a bucket, because it really was the series' value then.
 */
import { FIVE_MINUTES_MS, floorTo } from '../time/bucket-time.js'

export interface RollupRow {
  readonly seriesId: number
  readonly bucketStart: number
  readonly samples: number
  readonly sum: number
  readonly min: number
  readonly max: number
  /** `null` is unknown, never zero (D393). */
  readonly last: number | null
  readonly lastTs: number | null
  /** Σ value·ms over the covered time; `null` for bucket-ingested series. */
  readonly twSum: number | null
  /** Milliseconds `twSum` covers. */
  readonly twMs: number | null
  /** `enum` series: ms spent in each state (keyed by ordinal) over the covered time; `null` otherwise. */
  readonly states: Readonly<Record<string, number>> | null
}

export interface RawPoint {
  readonly ts: number
  readonly value: number
}

export interface RawToFiveMinuteInput {
  readonly seriesId: number
  /** Ascending by `ts`. */
  readonly points: readonly RawPoint[]
  /** The newest point strictly before the first bucket in `points`, if any. */
  readonly carryIn: RawPoint | null
  /** Time-weighting stops here for a bucket that has not closed yet. */
  readonly horizon: number
  /** An `enum` series: also keep the ms spent in each state (keyed by ordinal). */
  readonly trackStates?: boolean
}

function credit(states: Record<string, number> | null, value: number, ms: number): void {
  if (states === null || ms <= 0) return
  const key = String(value)
  states[key] = (states[key] ?? 0) + ms
}

/** One row per 5-minute bucket that has at least one point. */
export function rawToFiveMinuteRows(input: RawToFiveMinuteInput): readonly RollupRow[] {
  const rows: RollupRow[] = []
  const { points, seriesId, horizon } = input
  let held: number | null = input.carryIn === null ? null : input.carryIn.value
  let i = 0
  while (i < points.length) {
    const first = points[i]
    if (first === undefined) break
    const bucketStart = floorTo(first.ts, FIVE_MINUTES_MS)
    const bucketEnd = bucketStart + FIVE_MINUTES_MS
    const coverageEnd = Math.min(bucketEnd, Math.max(horizon, bucketStart))

    let samples = 0
    let sum = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let twSum = 0
    let twMs = 0
    const states: Record<string, number> | null = input.trackStates === true ? {} : null
    let cursor = bucketStart
    let value: number | null = held
    if (value !== null) {
      min = value
      max = value
    }
    let last = first
    while (i < points.length) {
      const p = points[i]
      if (p === undefined || p.ts >= bucketEnd) break
      if (value !== null) {
        const dt = p.ts - cursor
        twSum += value * dt
        twMs += dt
        credit(states, value, dt)
      }
      cursor = p.ts
      value = p.value
      samples += 1
      sum += p.value
      if (p.value < min) min = p.value
      if (p.value > max) max = p.value
      last = p
      i += 1
    }
    if (value !== null && coverageEnd > cursor) {
      twSum += value * (coverageEnd - cursor)
      twMs += coverageEnd - cursor
      credit(states, value, coverageEnd - cursor)
    }
    held = last.value
    rows.push({
      seriesId,
      bucketStart,
      samples,
      sum,
      min,
      max,
      last: last.value,
      lastTs: last.ts,
      twSum,
      twMs,
      states,
    })
  }
  return rows
}

export interface CombineInput {
  readonly seriesId: number
  readonly windowStart: number
  readonly windowEnd: number
  readonly childWidthMs: number
  /** Child rows inside the window, ascending by `bucketStart`. */
  readonly rows: readonly RollupRow[]
  /** The `last` of the newest child row BEFORE the window, if known. */
  readonly carryIn: number | null
  /** Time-weighting stops here for a window that has not closed yet. */
  readonly horizon: number
  /** An `enum` series: also sum the time in each state, gaps credited to the held state. */
  readonly trackStates?: boolean
}

/** One row of the next tier from the child rows of its window; `null` when there are none. */
export function combineRows(input: CombineInput): RollupRow | null {
  const { rows } = input
  const lastRow = rows[rows.length - 1]
  if (lastRow === undefined) return null

  const hasTw = rows.some((r) => r.twSum !== null && r.twMs !== null)
  let samples = 0
  let sum = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let twSum = 0
  let twMs = 0
  const states: Record<string, number> | null = input.trackStates === true ? {} : null
  let held: number | null = input.carryIn
  let cursor = input.windowStart

  for (const row of rows) {
    samples += row.samples
    sum += row.sum
    if (row.min < min) min = row.min
    if (row.max > max) max = row.max
    const gap = row.bucketStart - cursor
    if (hasTw && gap > 0 && held !== null) {
      twSum += held * gap
      twMs += gap
      credit(states, held, gap)
      if (held < min) min = held
      if (held > max) max = held
    }
    if (row.twSum !== null && row.twMs !== null) {
      twSum += row.twSum
      twMs += row.twMs
    }
    if (states !== null && row.states !== null) {
      for (const [state, ms] of Object.entries(row.states))
        states[state] = (states[state] ?? 0) + ms
    }
    cursor = row.bucketStart + input.childWidthMs
    held = row.last
  }
  const coverageEnd = Math.min(input.windowEnd, input.horizon)
  if (hasTw && held !== null && coverageEnd > cursor) {
    twSum += held * (coverageEnd - cursor)
    twMs += coverageEnd - cursor
    credit(states, held, coverageEnd - cursor)
  }
  return {
    seriesId: input.seriesId,
    bucketStart: input.windowStart,
    samples,
    sum,
    min,
    max,
    last: lastRow.last,
    lastTs: lastRow.lastTs,
    twSum: hasTw ? twSum : null,
    twMs: hasTw ? twMs : null,
    states,
  }
}
