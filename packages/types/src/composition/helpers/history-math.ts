/**
 * Statistics and integrals over a history read (D944).
 *
 * Pure: the same points always give the same answer, so a restart recomputes
 * rather than trusting a buffer. A gauge mean is time-weighted (value × ms),
 * never the mean of the samples. A hole with no held value is not integrated
 * as zero. A truncated read is not published.
 */
import { wattMillisecondsToKwh } from './energy.js'
import type { HistoryTier } from './history-window.js'

export const STATISTIC_STATS = ['min', 'max', 'mean', 'sum', 'count', 'change'] as const
export type StatisticStat = (typeof STATISTIC_STATS)[number]

export const SERIES_KINDS = ['gauge', 'counter', 'boolean'] as const
export type SeriesKind = (typeof SERIES_KINDS)[number]

export interface SeriesPoint {
  readonly t: number
  readonly value: number | null
  readonly twMean: number | null
  readonly twMs: number | null
  readonly min: number | null
  readonly max: number | null
  readonly last: number | null
  readonly delta: number | null
}

export interface SeriesBefore {
  readonly t: number
  readonly value: number | null
}

export interface SeriesRead {
  readonly kind: SeriesKind
  readonly tier: HistoryTier
  readonly from: number
  readonly to: number
  readonly before: SeriesBefore | null
  readonly points: readonly SeriesPoint[]
  readonly truncated: boolean
}

export interface HistoryValue {
  /** `hold` keeps the last published number. `null` is a known gap (D393). */
  readonly write: 'number' | 'null' | 'hold'
  readonly value: number | null
  readonly included: number
  readonly excluded: number
  readonly reason: string | null
}

interface Segment {
  readonly value: number
  readonly ms: number
}

interface Coverage {
  readonly segments: readonly Segment[]
  readonly included: number
  readonly gaps: number
  readonly end: number | null
  readonly start: number | null
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function pointValue(point: SeriesPoint): number | null {
  if (finite(point.value)) return point.value
  if (finite(point.last)) return point.last
  return null
}

function stepCoverage(read: SeriesRead): Coverage {
  const points = read.points.filter((point) => point.t >= read.from && point.t < read.to)
  const start = finite(read.before?.value) ? read.before.value : null
  let held = start
  let cursor = read.from
  let gaps = 0
  const segments: Segment[] = []
  if (held === null) {
    const first = points.find((point) => pointValue(point) !== null)
    if (first === undefined) return { segments, included: 0, gaps: 1, end: null, start: null }
    if (first.t > read.from) gaps += 1
    cursor = first.t
    held = pointValue(first)
  }
  for (const point of points) {
    const next = pointValue(point)
    if (held !== null && point.t > cursor) segments.push({ value: held, ms: point.t - cursor })
    if (next !== null) held = next
    if (point.t > cursor) cursor = point.t
  }
  if (held !== null && read.to > cursor) segments.push({ value: held, ms: read.to - cursor })
  const end = points.reduce<number | null>((latest, point) => pointValue(point) ?? latest, held)
  return { segments, included: points.length, gaps, end, start }
}

function rollupCoverage(read: SeriesRead): Coverage | null {
  const weighted = read.points.filter(
    (point) => finite(point.twMean) && finite(point.twMs) && point.twMs > 0,
  )
  if (weighted.length === 0) return null
  const first = weighted[0]
  const gaps = read.before === null && first !== undefined && first.t > read.from ? 1 : 0
  const levels = read.points.flatMap((point) => (finite(point.last) ? [point.last] : []))
  const end = levels.length > 0 ? (levels[levels.length - 1] ?? null) : null
  return {
    segments: weighted.flatMap((point) =>
      finite(point.twMean) && finite(point.twMs) ? [{ value: point.twMean, ms: point.twMs }] : [],
    ),
    included: weighted.length,
    gaps,
    end,
    start: finite(read.before?.value) ? read.before.value : null,
  }
}

function coverageOf(read: SeriesRead): Coverage {
  if (read.tier !== 'raw') {
    const rolled = rollupCoverage(read)
    if (rolled !== null) return rolled
  }
  return stepCoverage(read)
}

function timeWeighted(segments: readonly Segment[]): number | null {
  let ms = 0
  let sum = 0
  for (const segment of segments) {
    ms += segment.ms
    sum += segment.value * segment.ms
  }
  if (ms <= 0) return null
  return sum / ms
}

function extremes(
  read: SeriesRead,
  covered: Coverage,
): { readonly min: number | null; readonly max: number | null } {
  const lows: number[] = []
  const highs: number[] = []
  for (const point of read.points) {
    if (finite(point.min)) lows.push(point.min)
    if (finite(point.max)) highs.push(point.max)
  }
  if (covered.start !== null) {
    lows.push(covered.start)
    highs.push(covered.start)
  }
  return {
    min: lows.length === 0 ? null : Math.min(...lows),
    max: highs.length === 0 ? null : Math.max(...highs),
  }
}

function counterGrowth(read: SeriesRead): number | null {
  const deltas = read.points.flatMap((point) => (finite(point.delta) ? [point.delta] : []))
  if (deltas.length === 0) return null
  return deltas.reduce((sum, delta) => sum + delta, 0)
}

function hold(reason: string): HistoryValue {
  return { write: 'hold', value: null, included: 0, excluded: 0, reason }
}

function gapValue(reason: string, included: number): HistoryValue {
  return { write: 'null', value: null, included, excluded: 1, reason }
}

function numberValue(
  value: number,
  included: number,
  gaps: number,
  reason: string | null,
): HistoryValue {
  return {
    write: 'number',
    value,
    included,
    excluded: gaps,
    reason: gaps > 0 ? reason : null,
  }
}

const GAP_REASON = 'history has a gap — that interval was not counted as zero'

export function evaluateStatistic(stat: StatisticStat, read: SeriesRead): HistoryValue {
  if (read.truncated) return hold('the history query was truncated — the last statistic is kept')
  if (stat === 'sum' && read.kind !== 'counter') {
    return hold('a gauge has no sum — that is the integral template')
  }
  if (read.to <= read.from) return gapValue('the range is empty', 0)
  const covered = coverageOf(read)
  if (covered.segments.length === 0 && covered.start === null) {
    return gapValue(GAP_REASON, covered.included)
  }
  if (stat === 'count')
    return numberValue(covered.included, covered.included, covered.gaps, GAP_REASON)
  if (stat === 'sum' || (stat === 'change' && read.kind === 'counter')) {
    const growth = counterGrowth(read)
    if (growth === null)
      return gapValue('the counter has no growth in this range', covered.included)
    return numberValue(growth, covered.included, covered.gaps, GAP_REASON)
  }
  if (stat === 'change') {
    if (covered.start === null || covered.end === null) {
      return gapValue('the change has no value at the start of the range', covered.included)
    }
    return numberValue(covered.end - covered.start, covered.included, covered.gaps, GAP_REASON)
  }
  if (stat === 'min' || stat === 'max') {
    const ends = extremes(read, covered)
    const value = stat === 'min' ? ends.min : ends.max
    if (value === null) return gapValue(GAP_REASON, covered.included)
    return numberValue(value, covered.included, covered.gaps, GAP_REASON)
  }
  const mean = timeWeighted(covered.segments)
  if (mean === null) return gapValue(GAP_REASON, covered.included)
  return numberValue(mean, covered.included, covered.gaps, GAP_REASON)
}

export type IntegralScale = 'energy-kwh' | 'per-second'

export function integrateReading(read: SeriesRead, scale: IntegralScale): HistoryValue {
  if (read.truncated) return hold('the history query was truncated — the last total is kept')
  if (read.kind === 'counter')
    return hold('a counter is already a total — it is not integrated again')
  if (read.to <= read.from) return gapValue('the range is empty', 0)
  const covered = coverageOf(read)
  if (covered.segments.length === 0) {
    return {
      write: 'hold',
      value: null,
      included: covered.included,
      excluded: covered.gaps,
      reason: GAP_REASON,
    }
  }
  let unitMs = 0
  for (const segment of covered.segments) unitMs += segment.value * segment.ms
  const value = scale === 'energy-kwh' ? wattMillisecondsToKwh(unitMs) : unitMs / 1000
  return numberValue(value, covered.included, covered.gaps, GAP_REASON)
}
