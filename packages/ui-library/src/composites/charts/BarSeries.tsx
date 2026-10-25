/**
 * BarSeries — bucketed counts or deltas on wall time (uPlot), optionally
 * stacked, with a window total (kWh per hour with the day's sum, detections
 * per 5 minutes by class, event density under a recording timeline).
 *
 * Bars sit on their bucket's real span, so a missing bucket is a missing bar
 * and never a zero bar. `compact` drops the frame and axes for a strip that
 * lives inside another control; there a bucket can be selected (`onSelect`)
 * and every bucket is also a real button for keyboard and screen readers.
 */
import { useCallback, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type uPlot from 'uplot'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { ChartFrame, ChartPlaceholder, type ChartLegendEntry } from './chart-frame'
import { formatCursorTime, formatTimeLabel } from './chart-data'
import { chartSeriesStyle, resolveChartColor } from './chart-palette'
import {
  chartCursor,
  formatChartValue,
  timeAxis,
  valueAxis,
  valueRange,
  valueSplits,
} from './chart-uplot'
import { ChartWindowToggle, type ChartWindowToggleProps } from './chart-window'
import {
  bucketIndexAt,
  bucketTotals,
  stackBuckets,
  type BarBucket,
  type BarLayerDef,
} from './bar-series-model'
import type { ChartRange } from './TimeSeriesChart'
import { UPlotHost, type ChartPlotOptions } from './uplot-host'

export type { BarBucket, BarLayerDef } from './bar-series-model'

export interface BarSeriesProps<TId extends string = string> {
  readonly title: string
  readonly layers: readonly BarLayerDef[]
  readonly buckets: readonly BarBucket[]
  /** The width of one bucket in ms (5 min, 1 h, 1 d). */
  readonly bucketMs: number
  readonly range: ChartRange
  readonly unit?: string | null
  readonly formatValue?: (v: number, unit: string | null) => string
  /** Plot height in px. Default 100 (24 when `compact`). */
  readonly height?: number
  /** Stack the layers (default true for more than one layer). */
  readonly stacked?: boolean
  /** Say the window total under the chart ("Total 12.4 kWh"). */
  readonly showTotal?: boolean
  readonly syncKey?: string
  readonly pending?: boolean
  readonly emptyMessage?: string
  readonly actions?: ReactNode
  readonly footer?: ReactNode
  readonly windowToggle?: ChartWindowToggleProps<TId>
  /** No frame, no axes: a strip inside another control. */
  readonly compact?: boolean
  /** A non-zero bar is at least this fraction of the plot (compact strips). */
  readonly minBarFraction?: number
  readonly selectedIndex?: number | null
  readonly onSelect?: (index: number) => void
  /** Text for a bucket (its button and native tooltip). */
  readonly bucketLabel?: (bucket: BarBucket, index: number) => string
  /** `data-testid` on each bucket button. */
  readonly bucketTestId?: string
  readonly className?: string
}

export function BarSeries<TId extends string = string>({
  title,
  layers,
  buckets,
  bucketMs,
  range,
  unit = null,
  formatValue,
  height,
  stacked,
  showTotal = false,
  syncKey,
  pending = false,
  emptyMessage,
  actions,
  footer,
  windowToggle,
  compact = false,
  minBarFraction = 0,
  selectedIndex = null,
  onSelect,
  bucketLabel,
  bucketTestId,
  className,
}: BarSeriesProps<TId>): JSX.Element {
  const t = useUiText()
  const plotHeight = height ?? (compact ? 24 : 100)
  const isStacked = stacked ?? layers.length > 1
  const fmt = useCallback(
    (v: number) => (formatValue ?? formatChartValue)(v, unit),
    [formatValue, unit],
  )
  const tops = useMemo(
    () =>
      isStacked
        ? stackBuckets(buckets, layers.length)
        : layers.map((_l, li) => buckets.map((b) => b.values[li] ?? null)),
    [buckets, layers, isStacked],
  )
  const totals = useMemo(() => bucketTotals(buckets, layers.length), [buckets, layers.length])
  const [cursorIdx, setCursorIdx] = useState<number | null>(null)

  const live = useRef({ buckets, tops, range, selectedIndex, onSelect, bucketLabel, fmt })
  live.current = { buckets, tops, range, selectedIndex, onSelect, bucketLabel, fmt }

  const optionsKey = `${layers.map((l) => `${l.id}:${l.colorIndex}`).join(',')}#${compact ? 'C' : ''}#${isStacked ? 'S' : ''}#${syncKey ?? ''}#${String(bucketMs)}`

  const data = useMemo<uPlot.AlignedData>(() => {
    const top = tops.at(-1) ?? []
    const peak = isStacked
      ? top
      : buckets.map((_b, i) => Math.max(...tops.map((row) => row[i] ?? 0)))
    return [buckets.map((b) => b.t), peak.map((v) => v ?? null)]
    // `selectedIndex` is a dependency on purpose: new data is what redraws the
    // selection outline without rebuilding the plot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, tops, isStacked, selectedIndex])

  const buildOptions = useCallback(
    (): ChartPlotOptions => {
      const spec = { floor: 0 }
      return {
        ms: 1,
        legend: { show: false },
        padding: compact ? [0, 0, 0, 0] : [8, 30, 0, 0],
        scales: {
          x: {
            time: true,
            range: (): uPlot.Range.MinMax => [live.current.range.from, live.current.range.to],
          },
          y: {
            range: (self): uPlot.Range.MinMax => {
              const r = valueRange([...(self.data[1] ?? [])], spec)
              return [r[0], r[1]]
            },
          },
        },
        axes: compact
          ? [
              { show: false, scale: 'x' },
              { show: false, scale: 'y' },
            ]
          : [
              timeAxis(() => live.current.range.to - live.current.range.from),
              {
                ...valueAxis('y', 3, (v) => live.current.fmt(v), true),
                splits: (_s, _i, min, max) => valueSplits([min, max], spec),
              },
            ],
        series: [
          {},
          { scale: 'y', stroke: () => 'transparent', points: { show: false }, paths: () => null },
        ],
        cursor: { ...chartCursor(syncKey), points: { show: false } },
        hooks: {
          draw: [
            (u) => {
              const { buckets: bs, tops: ts, selectedIndex: sel } = live.current
              const ctx = u.ctx
              const baseY = u.valToPos(0, 'y', true)
              const minPx = minBarFraction * u.bbox.height
              const gap = Math.max(1, Math.round(devicePixelRatio))
              ctx.save()
              bs.forEach((b, i) => {
                const x0 = u.valToPos(b.t, 'x', true)
                const x1 = u.valToPos(b.t + bucketMs, 'x', true)
                const w = Math.max(1, x1 - x0 - gap)
                let prevY = baseY
                layers.forEach((layer, li) => {
                  const top = ts[li]?.[i]
                  if (top === null || top === undefined) return
                  const below = isStacked && li > 0 ? (ts[li - 1]?.[i] ?? 0) : 0
                  if (!(top > below)) return
                  let yTop = u.valToPos(top, 'y', true)
                  const yBottom = isStacked ? prevY : baseY
                  if (li === layers.length - 1 && baseY - yTop < minPx) yTop = baseY - minPx
                  ctx.fillStyle = resolveChartColor(chartSeriesStyle(layer.colorIndex).token)
                  const h = Math.max(1, yBottom - yTop - (isStacked && li > 0 ? gap : 0))
                  ctx.fillRect(x0, yTop, w, h)
                  prevY = yTop
                })
                if (sel === i) {
                  ctx.strokeStyle = resolveChartColor('primary')
                  ctx.lineWidth = gap * 1.5
                  ctx.strokeRect(x0, u.bbox.top + gap, w, u.bbox.height - 2 * gap)
                }
              })
              ctx.restore()
            },
          ],
          setCursor: [
            (u) => {
              const left = u.cursor.left ?? -1
              const idx =
                left < 0
                  ? null
                  : bucketIndexAt(live.current.buckets, bucketMs, u.posToVal(left, 'x'))
              setCursorIdx(idx)
              const b = idx === null ? undefined : live.current.buckets[idx]
              const label =
                b === undefined || idx === null ? '' : (live.current.bucketLabel?.(b, idx) ?? '')
              u.over.title = label
            },
          ],
          ready: [
            (u) => {
              u.over.addEventListener('click', () => {
                const left = u.cursor.left ?? -1
                if (left < 0) return
                const idx = bucketIndexAt(live.current.buckets, bucketMs, u.posToVal(left, 'x'))
                if (idx !== null) live.current.onSelect?.(idx)
              })
            },
          ],
        },
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt by `optionsKey`
    [optionsKey, minBarFraction],
  )

  const span = range.to - range.from
  const hovered = cursorIdx === null ? undefined : buckets[cursorIdx]
  const legend: ChartLegendEntry[] = layers.map((l, li) => {
    const v = hovered ? hovered.values[li] : totals.known ? totals.perLayer[li] : undefined
    return {
      id: l.id,
      label: l.label,
      token: chartSeriesStyle(l.colorIndex).token,
      value: v === null || v === undefined ? (hovered ? '—' : undefined) : fmt(v),
    }
  })
  const summary = t(
    'uiLibrary.charts.barSummary',
    '{{title}}, {{from}} to {{to}}: total {{total}}',
    {
      title,
      from: formatTimeLabel(range.from, span),
      to: formatTimeLabel(range.to, span),
      total: totals.known ? fmt(totals.total) : t('uiLibrary.charts.unknown', 'unknown'),
    },
  )

  const buttons =
    onSelect !== undefined ? (
      <div className="sr-only">
        {buckets.map((b, i) => {
          const sum = b.values.reduce<number>((a, v) => a + (v ?? 0), 0)
          if (sum <= 0) return null
          return (
            <button // ui-check-ok: visually hidden twin of a canvas bar; Button chrome is never seen
              key={b.t}
              type="button"
              data-testid={bucketTestId}
              aria-pressed={selectedIndex === i}
              onClick={() => onSelect(i)}
            >
              {bucketLabel?.(b, i) ?? `${formatTimeLabel(b.t, span)} ${fmt(sum)}`}
            </button>
          )
        })}
      </div>
    ) : null

  const plot = (
    <UPlotHost
      optionsKey={optionsKey}
      buildOptions={buildOptions}
      data={data}
      height={plotHeight}
    />
  )

  if (compact) {
    return (
      <div className={cn('relative min-w-0', className)}>
        <div role="img" aria-label={summary}>
          {plot}
        </div>
        {buttons}
      </div>
    )
  }

  const totalLine =
    showTotal && totals.known
      ? t('uiLibrary.charts.total', 'Total {{value}}', { value: fmt(totals.total) })
      : null
  const empty = !totals.known
  const sizeClass = plotHeight <= 64 ? 'sm' : plotHeight <= 120 ? 'md' : 'lg'
  return (
    <ChartFrame
      title={title}
      actions={
        <>
          {totalLine && (
            <span className="text-[11px] tabular-nums text-foreground">{totalLine}</span>
          )}
          {windowToggle && <ChartWindowToggle {...windowToggle} />}
          {actions}
        </>
      }
      readoutTime={hovered ? formatCursorTime(hovered.t, span) : null}
      legend={layers.length > 1 || hovered ? legend : []}
      summary={summary}
      footer={footer}
      placeholder={
        pending ? (
          <ChartPlaceholder
            message={t('uiLibrary.charts.loading', 'Loading…')}
            height={sizeClass}
          />
        ) : empty ? (
          <ChartPlaceholder
            message={
              emptyMessage ?? t('uiLibrary.charts.empty', 'Nothing was recorded in this window.')
            }
            height={sizeClass}
          />
        ) : undefined
      }
      controls={buttons}
      className={className}
    >
      {plot}
    </ChartFrame>
  )
}
