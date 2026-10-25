/**
 * The pure half of `TimeSeriesChart`: which series go on which value axis,
 * the aligned data uPlot draws, and what the readout says at an index.
 */
import {
  alignSeries,
  sharedGapSpans,
  stackSeries,
  valueAtOrBefore,
  type AlignedValue,
  type GapSpan,
  type TimePoint,
} from './chart-data'

export type SeriesInterpolation = 'linear' | 'step'

export interface TimeSeriesDef {
  /** Stable id — React key and the identity the colour follows. */
  readonly id: string
  readonly label: string
  /** `null` is an unknown unit; series sharing a unit share an axis. */
  readonly unit?: string | null
  readonly points: readonly TimePoint[]
  /** Categorical slot (`chartSeriesStyle`); the caller keeps it stable across filters. */
  readonly colorIndex: number
  /** `step` holds each value until the next (a change-only series). Default `linear`. */
  readonly interpolation?: SeriesInterpolation
  /** Longest gap that may be joined; omit for a change-only series (it is held, never a hole). */
  readonly gapMs?: number
  /** Draw the points' `min`/`max` as a band behind the line. */
  readonly band?: boolean
  /** A previous-period overlay: dashed, recessive, excluded from stacking and gap shading. */
  readonly compare?: boolean
}

/** The unit key a series lives on (`''` for no / unknown unit). */
export function unitKey(unit: string | null | undefined): string {
  return unit ?? ''
}

/** Units in order of first appearance — one value axis each. */
export function unitAxes(series: readonly TimeSeriesDef[]): readonly string[] {
  const out: string[] = []
  for (const s of series) {
    const k = unitKey(s.unit)
    if (!out.includes(k)) out.push(k)
  }
  return out
}

export interface TimeSeriesModel {
  readonly xs: readonly number[]
  /** RAW values per series (index-aligned with the input), for the readout. */
  readonly raw: readonly (readonly AlignedValue[])[]
  /** What is drawn per series: raw, or cumulative when stacked. */
  readonly drawn: readonly (readonly AlignedValue[])[]
  readonly mins: readonly (readonly AlignedValue[])[]
  readonly maxs: readonly (readonly AlignedValue[])[]
  readonly units: readonly string[]
  readonly gaps: readonly GapSpan[]
  /** No series has a single known value. */
  readonly empty: boolean
}

/** Align, stack (non-compare series only) and find the shared holes. */
export function buildTimeSeriesModel(
  series: readonly TimeSeriesDef[],
  stacked: boolean,
): TimeSeriesModel {
  const aligned = alignSeries(series.map((s) => ({ points: s.points, gapMs: s.gapMs })))
  let drawn: readonly (readonly AlignedValue[])[] = aligned.ys
  if (stacked) {
    const primaryIdx = series.flatMap((s, i) => (s.compare ? [] : [i]))
    const stackedRows = stackSeries(primaryIdx.map((i) => aligned.ys[i] ?? []))
    drawn = aligned.ys.map((row, i) => {
      const at = primaryIdx.indexOf(i)
      return at >= 0 ? (stackedRows[at] ?? row) : row
    })
  }
  const empty = !aligned.ys.some((row) => row.some((v) => typeof v === 'number'))
  return {
    xs: aligned.xs,
    raw: aligned.ys,
    drawn,
    mins: aligned.mins,
    maxs: aligned.maxs,
    units: unitAxes(series),
    gaps: sharedGapSpans(
      series.filter((s) => !s.compare).map((s) => ({ points: s.points, gapMs: s.gapMs })),
    ),
    empty,
  }
}

/** The value per series a reader sees at `idx` (`null` = cursor off → the latest). */
export function readoutAt(model: TimeSeriesModel, idx: number | null): readonly (number | null)[] {
  const at = idx ?? model.xs.length - 1
  return model.raw.map((row) => (at < 0 ? null : valueAtOrBefore(model.xs, row, at)))
}

/** The last known value of each series (for the accessible summary). */
export function latestValues(model: TimeSeriesModel): readonly (number | null)[] {
  return readoutAt(model, null)
}
