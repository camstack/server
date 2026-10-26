/**
 * Sparkline — one series, no axes, no cursor: a trend beside a number in a
 * row (a training job's mAP per epoch). The x is whatever the caller orders
 * by (an epoch, a time); the value next to it names what the line is.
 */
import { useCallback, useMemo, type JSX } from 'react'
import type { DisplayPreference, ReadingQuantity } from '@camstack/types'
import type uPlot from 'uplot'
import { cn } from '../../lib/cn'
import { resolveChartColor, type ChartChromeToken, type ChartSeriesToken } from './chart-palette'
import { lineTooltipBody, nearestPointIndex } from './chart-tooltip-model'
import { UPlotHost, type ChartPlotOptions, type ChartTooltipSpec } from './uplot-host'

export interface SparklinePoint {
  readonly x: number
  readonly v: number | null
}

export interface SparklineProps {
  readonly points: readonly SparklinePoint[]
  /** Accessible name ("mAP50 per epoch"). */
  readonly ariaLabel: string
  /** Line colour token. Default `chart-series-a`. */
  readonly token?: ChartSeriesToken | Extract<ChartChromeToken, 'primary'>
  /** Plot height in px. Default 32. */
  readonly height?: number
  /** Width class of the box (default `w-40`). */
  readonly widthClassName?: string
  /** Start the value axis at zero (default true). */
  readonly zeroBased?: boolean
  readonly unit?: string | null
  readonly quantity?: ReadingQuantity
  /** Display preference for a base-unit sample in the point tooltip. Default metric. */
  readonly displayPreference?: DisplayPreference
  readonly className?: string
}

export function Sparkline({
  points,
  ariaLabel,
  token = 'chart-series-a',
  height = 32,
  widthClassName = 'w-40',
  zeroBased = true,
  unit = null,
  quantity,
  displayPreference,
  className,
}: SparklineProps): JSX.Element {
  const tooltip = useMemo<ChartTooltipSpec>(() => {
    const xs = points.map((point) => point.x)
    return {
      xMin: xs[0] ?? 0,
      xMax: xs.at(-1) ?? 0,
      stops: xs,
      resolve: (dataX) => {
        const index = nearestPointIndex(xs, dataX)
        if (index === null) return null
        const point = points[index]
        if (point === undefined) return null
        return lineTooltipBody({
          timeLabel: String(point.x),
          preference: displayPreference,
          series: [{ id: 'value', label: ariaLabel, value: point.v, unit, quantity }],
        })
      },
    }
  }, [points, ariaLabel, unit, quantity, displayPreference])
  const data = useMemo<uPlot.AlignedData>(
    () => [points.map((p) => p.x), points.map((p) => p.v)],
    [points],
  )
  const buildOptions = useCallback(
    (_w: number, lib: typeof uPlot): ChartPlotOptions => ({
      legend: { show: false },
      cursor: { show: false },
      padding: [2, 1, 2, 1],
      scales: {
        x: { time: false },
        y: {
          range: (_u, min, max): uPlot.Range.MinMax => {
            const lo = zeroBased ? Math.min(0, min) : min
            const hi = max > lo ? max : lo + 1
            return [lo, hi]
          },
        },
      },
      axes: [{ show: false }, { show: false }],
      series: [
        {},
        {
          stroke: () => resolveChartColor(token),
          width: 1.5,
          points: { show: false },
          spanGaps: false,
          ...(lib.paths.linear ? { paths: lib.paths.linear() } : {}),
        },
      ],
    }),
    [token, zeroBased],
  )
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={cn('inline-block align-middle', widthClassName, className)}
    >
      <UPlotHost
        optionsKey={`${token}#${zeroBased ? 'z' : ''}`}
        buildOptions={buildOptions}
        data={data}
        height={height}
        inline
        tooltip={tooltip}
        kind="spark"
        label={ariaLabel}
      />
    </span>
  )
}
