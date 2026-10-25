/**
 * The load charts — the library's `TimeSeriesChart` (D899), shaped for a
 * runner's or a camera's load.
 *
 * CPU is a STACKED area of two series — the process's own threads and V8's
 * helper pool — because they are parts of one total and the point is their
 * proportion. Memory is a single line, named by its title. CPU and memory are
 * two charts, never two axes on one.
 *
 * Slots `chart-series-a` (main threads) and `chart-series-b` (V8 pool) are
 * fixed. An unknown sample breaks the path; a hole longer than `gapMs`
 * breaks it AND is shaded — a drawn segment is a claim, and nobody measured
 * the hole. The x axis is wall time.
 */
import { useMemo } from 'react'
import { TimeSeriesChart, type TimeSeriesDef, type AxisScale } from '@camstack/ui-library'

/** Plot height: two charts sit side by side in a runner card. */
const LOAD_CHART_HEIGHT = 96

interface BaseChartProps {
  /** Names the chart — a single-series chart has no legend. */
  readonly title: string
  readonly formatValue: (v: number) => string
  readonly emptyMessage: string
  /**
   * Longest interval between two samples that may be JOINED, in ms. Derive it
   * from the series' real cadence with `gapThresholdMs` — never a literal.
   */
  readonly gapMs?: number
}

interface StackedCpuChartProps extends BaseChartProps {
  readonly points: readonly {
    readonly atMs: number
    readonly main: number | null
    readonly gc: number | null
  }[]
  readonly mainLabel: string
  readonly gcLabel: string
}

/** CPU: `main` on the bottom, the V8 helper pool stacked above it. */
export function StackedCpuChart({
  title,
  points,
  mainLabel,
  gcLabel,
  formatValue,
  emptyMessage,
  gapMs,
}: StackedCpuChartProps) {
  const series = useMemo<readonly TimeSeriesDef[]>(
    () => [
      {
        id: 'main',
        label: mainLabel,
        unit: '%',
        colorIndex: 0,
        gapMs,
        points: points.map((p) => ({ t: p.atMs, v: p.main })),
      },
      {
        id: 'gc',
        label: gcLabel,
        unit: '%',
        colorIndex: 1,
        gapMs,
        points: points.map((p) => ({ t: p.atMs, v: p.gc })),
      },
    ],
    [points, mainLabel, gcLabel, gapMs],
  )
  return (
    <TimeSeriesChart
      title={title}
      series={series}
      stacked
      height={LOAD_CHART_HEIGHT}
      formatValue={(v) => formatValue(v)}
      // An idle runner must not get an axis on which 0.4 % fills the plot.
      axisFor={() => ({ floor: 25 })}
      emptyMessage={emptyMessage}
    />
  )
}

interface SingleLineChartProps extends BaseChartProps {
  readonly points: readonly { readonly atMs: number; readonly value: number | null }[]
  /** Axis floor so a flat series does not get a degenerate scale. */
  readonly axisFloor: number
  /** `bytes` for anything rendered with `formatBytes` (binary rounding). Default `linear`. */
  readonly axisScale?: AxisScale
}

/** Memory (or a camera's CPU): one series, named by the title. */
export function SingleLineChart({
  title,
  points,
  formatValue,
  emptyMessage,
  axisFloor,
  axisScale = 'linear',
  gapMs,
}: SingleLineChartProps) {
  const series = useMemo<readonly TimeSeriesDef[]>(
    () => [
      {
        id: 'value',
        label: title,
        unit: axisScale === 'bytes' ? 'B' : null,
        colorIndex: 0,
        gapMs,
        points: points.map((p) => ({ t: p.atMs, v: p.value })),
      },
    ],
    [points, title, axisScale, gapMs],
  )
  return (
    <TimeSeriesChart
      title={title}
      series={series}
      height={LOAD_CHART_HEIGHT}
      formatValue={(v) => formatValue(v)}
      axisFor={() => ({ floor: axisFloor, scale: axisScale })}
      emptyMessage={emptyMessage}
    />
  )
}
