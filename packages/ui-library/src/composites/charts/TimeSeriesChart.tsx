/**
 * TimeSeriesChart — gauges and counters over wall time (uPlot).
 *
 * Lines, an optional min/max band, stacked areas, null gaps (a hole breaks
 * the line AND is shaded), one value axis per unit (left, right, left …),
 * a synced cursor across every chart sharing `syncKey`, an optional window
 * toggle. Identity is never colour alone: one series is named by the title,
 * two or more always carry a legend with direct values.
 *
 * A device page draws ONE unit per chart; overlaying units (several axes) is
 * for the cross-device History page, where the reader chose the series.
 */
import { useCallback, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { DisplayPreference } from '@camstack/types'
import type uPlot from 'uplot'
import { useUiText } from '../../contexts/ui-text'
import { ChartFrame, ChartPlaceholder, type ChartLegendEntry } from './chart-frame'
import { formatCursorTime, formatTimeLabel } from './chart-data'
import { chartSeriesStyle, resolveChartColor, withAlpha } from './chart-palette'
import {
  chartCursor,
  defaultAxisSpec,
  formatChartValue,
  gapShadeHook,
  timeAxis,
  valueAxis,
  valueRange,
  valueSplits,
  type ValueAxisSpec,
} from './chart-uplot'
import { ChartWindowToggle, type ChartWindowToggleProps } from './chart-window'
import { lineTooltipBody, nearestPointIndex } from './chart-tooltip-model'
import {
  buildTimeSeriesModel,
  latestValues,
  readoutAt,
  unitKey,
  type TimeSeriesDef,
  type TimeSeriesModel,
} from './time-series-model'
import {
  UPlotHost,
  type ChartPlotOptions,
  type ChartTooltipSpec,
  type UPlotCtor,
} from './uplot-host'

export type { TimeSeriesDef } from './time-series-model'

export interface ChartRange {
  readonly from: number
  readonly to: number
}

export interface TimeSeriesChartProps<TId extends string = string> {
  readonly title: string
  readonly series: readonly TimeSeriesDef[]
  /** The window the x axis spans; default: the data's own span. */
  readonly range?: ChartRange
  /** Plot height in px. Default 120. */
  readonly height?: number
  /** Stack the non-compare series as areas (parts of one total). */
  readonly stacked?: boolean
  /** Fill a single line down to its baseline. */
  readonly area?: boolean
  /** Charts with the same key move one cursor together. */
  readonly syncKey?: string
  /** Value formatter per unit; default: bytes binary, `%` glued, unit after a space. */
  readonly formatValue?: (v: number, unit: string | null) => string
  /** Display preference for base-unit samples in the point tooltip. Default metric. */
  readonly displayPreference?: DisplayPreference
  /** Axis layout per unit; default by unit (°C floats, `%` floors at 10, bytes binary). */
  readonly axisFor?: (unit: string | null) => ValueAxisSpec
  /** Shown when no series has a known value. */
  readonly emptyMessage?: string
  /** The query has not answered: a placeholder, never an empty chart. */
  readonly pending?: boolean
  readonly actions?: ReactNode
  readonly footer?: ReactNode
  readonly windowToggle?: ChartWindowToggleProps<TId>
  readonly className?: string
}

const DEFAULT_HEIGHT = 120

function seriesSpan(range: ChartRange | undefined, xs: readonly number[]): number {
  if (range !== undefined) return range.to - range.from
  if (xs.length < 2) return 0
  return (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0)
}

interface SeriesTooltipInput {
  readonly model: TimeSeriesModel
  readonly series: readonly TimeSeriesDef[]
  readonly range: ChartRange | undefined
  readonly preference: DisplayPreference | undefined
  readonly onDataX: (dataX: number | null) => void
}

function seriesTooltip(input: SeriesTooltipInput): ChartTooltipSpec {
  const span = seriesSpan(input.range, input.model.xs)
  return {
    xMin: input.range?.from ?? input.model.xs[0] ?? 0,
    xMax: input.range?.to ?? input.model.xs.at(-1) ?? 0,
    stops: input.model.xs,
    resolve: (dataX) => {
      const index = nearestPointIndex(input.model.xs, dataX)
      if (index === null) return null
      const at = input.model.xs[index]
      if (at === undefined) return null
      const values = readoutAt(input.model, index)
      return lineTooltipBody({
        timeLabel: formatCursorTime(at, span),
        preference: input.preference,
        series: input.series.map((sample, i) => ({
          id: sample.id,
          label: sample.label,
          value: values[i] ?? null,
          quantity: sample.quantity,
          unit: sample.unit ?? null,
        })),
      })
    },
    onDataX: input.onDataX,
  }
}

export function TimeSeriesChart<TId extends string = string>({
  title,
  series,
  range,
  height = DEFAULT_HEIGHT,
  stacked = false,
  area = false,
  syncKey,
  formatValue,
  displayPreference,
  axisFor,
  emptyMessage,
  pending = false,
  actions,
  footer,
  windowToggle,
  className,
}: TimeSeriesChartProps<TId>): JSX.Element {
  const t = useUiText()
  const model = useMemo(() => buildTimeSeriesModel(series, stacked), [series, stacked])
  const [cursorIdx, setCursorIdx] = useState<number | null>(null)
  const modelRef = useRef(model)
  modelRef.current = model
  const rangeRef = useRef(range)
  rangeRef.current = range

  const fmt = useCallback(
    (v: number, unit: string | null) => (formatValue ?? formatChartValue)(v, unit),
    [formatValue],
  )
  const spanMs = (): number => {
    const r = rangeRef.current
    if (r) return r.to - r.from
    const xs = modelRef.current.xs
    return xs.length > 1 ? (xs.at(-1) ?? 0) - (xs[0] ?? 0) : 0
  }

  const unitOf = (s: TimeSeriesDef): string | null => s.unit ?? null
  const specFor = useCallback(
    (unit: string) => (axisFor ?? defaultAxisSpec)(unit === '' ? null : unit),
    [axisFor],
  )

  // Rebuild when the SHAPE changes (series identity, units, stacking), not the values.
  const optionsKey = [
    series
      .map(
        (s) =>
          `${s.id}|${unitKey(s.unit)}|${s.colorIndex}|${s.interpolation ?? ''}|${s.band ? 1 : 0}|${s.compare ? 1 : 0}`,
      )
      .join(','),
    stacked ? 'S' : '',
    area ? 'A' : '',
    syncKey ?? '',
    range ? 'R' : '',
  ].join('#')

  const data = useMemo<uPlot.AlignedData>(() => {
    const ys: (number | null | undefined)[][] = []
    series.forEach((s, i) => {
      ys.push([...(model.drawn[i] ?? [])])
      if (s.band) {
        ys.push([...(model.mins[i] ?? [])])
        ys.push([...(model.maxs[i] ?? [])])
      }
    })
    return [[...model.xs], ...ys]
  }, [model, series])

  const buildOptions = useCallback(
    (_width: number, lib: UPlotCtor): ChartPlotOptions => {
      const units = modelRef.current.units
      const scales: uPlot.Scales = {
        x: {
          time: true,
          ...(rangeRef.current
            ? {
                range: (): uPlot.Range.MinMax => [
                  rangeRef.current?.from ?? 0,
                  rangeRef.current?.to ?? 1,
                ],
              }
            : {}),
        },
      }
      const axes: uPlot.Axis[] = [timeAxis(spanMs)]
      units.forEach((u, ui) => {
        const key = `y:${u}`
        const spec = specFor(u)
        scales[key] = {
          range: (self): uPlot.Range.MinMax => {
            const vals: (number | null | undefined)[] = []
            self.series.forEach((s, si) => {
              if (si === 0 || s.scale !== key) return
              for (const v of self.data[si] ?? []) vals.push(v)
            })
            const r = valueRange(vals, spec)
            return [r[0], r[1]]
          },
        }
        const unit = u === '' ? null : u
        const ax = valueAxis(key, ui % 2 === 0 ? 3 : 1, (v) => fmt(v, unit), ui === 0)
        axes.push({
          ...ax,
          splits: (_self, _axisIdx, min, max) => valueSplits([min, max], spec),
        })
      })
      const uSeries: uPlot.Series[] = [{}]
      const bands: uPlot.Band[] = []
      const defs = series
      const primaryCount = defs.filter((d) => !d.compare).length
      let seriesIdx = 1
      let prevStackIdx: number | null = null
      defs.forEach((d) => {
        const style = chartSeriesStyle(d.colorIndex)
        const color = (): string => resolveChartColor(style.token)
        const stepped = d.interpolation === 'step'
        const paths = stepped ? lib.paths.stepped?.({ align: 1 }) : lib.paths.linear?.()
        const isStacked = stacked && !d.compare
        const fillSingle = !stacked && area && primaryCount === 1 && !d.compare
        const line: uPlot.Series = {
          label: d.label,
          scale: `y:${unitKey(d.unit)}`,
          stroke: d.compare ? () => withAlpha(color(), 0.6) : color,
          width: d.compare ? 1.25 : 2,
          dash: d.compare ? [4, 4] : style.dash.length > 0 ? [...style.dash] : undefined,
          spanGaps: false,
          points: { show: false },
          ...(paths ? { paths } : {}),
          ...(isStacked && prevStackIdx === null
            ? { fill: () => withAlpha(color(), 0.85), fillTo: 0 }
            : {}),
          ...(fillSingle ? { fill: () => withAlpha(color(), 0.15) } : {}),
        }
        uSeries.push(line)
        const thisIdx = seriesIdx
        if (isStacked && prevStackIdx !== null) {
          bands.push({ series: [thisIdx, prevStackIdx], fill: () => withAlpha(color(), 0.85) })
        }
        if (isStacked) prevStackIdx = thisIdx
        seriesIdx += 1
        if (d.band) {
          const hidden: uPlot.Series = {
            scale: `y:${unitKey(d.unit)}`,
            stroke: () => 'transparent',
            width: 0,
            points: { show: false },
            spanGaps: false,
            ...(paths ? { paths } : {}),
          }
          uSeries.push(
            // i18n-ignore-start: uPlot-internal series ids; the band is never in the legend
            { ...hidden, label: `${d.label} min` },
            { ...hidden, label: `${d.label} max` },
            // i18n-ignore-end
          )
          bands.push({ series: [seriesIdx + 1, seriesIdx], fill: () => withAlpha(color(), 0.15) })
          seriesIdx += 2
        }
      })
      return {
        ms: 1,
        legend: { show: false },
        padding: [8, 30, 0, 0],
        scales,
        axes,
        series: uSeries,
        bands,
        cursor: chartCursor(syncKey),
        hooks: {
          drawClear: [gapShadeHook(() => modelRef.current.gaps)],
          setCursor: [(u) => setCursorIdx(u.cursor.idx ?? null)],
        },
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt by `optionsKey`
    [optionsKey, fmt, specFor],
  )

  const tooltip = useMemo(
    () =>
      seriesTooltip({
        model,
        series,
        range,
        preference: displayPreference,
        onDataX: (dataX) => {
          setCursorIdx(dataX === null ? null : nearestPointIndex(model.xs, dataX))
        },
      }),
    [model, series, range, displayPreference],
  )

  const shown = readoutAt(model, cursorIdx)
  const legend: ChartLegendEntry[] = series.map((s, i) => {
    const style = chartSeriesStyle(s.colorIndex)
    const v = shown[i]
    return {
      id: s.id,
      label: s.label,
      token: style.token,
      dashed: s.compare === true || style.dash.length > 0,
      muted: s.compare === true,
      value: v === null || v === undefined ? (model.empty ? undefined : '—') : fmt(v, unitOf(s)),
    }
  })

  const readoutTime =
    cursorIdx !== null && model.xs[cursorIdx] !== undefined
      ? formatCursorTime(model.xs[cursorIdx] ?? 0, spanMs())
      : null

  const summary = useMemo(() => {
    const latest = latestValues(model)
    // The window the summary states: the requested one, else what the data spans.
    const from = range?.from ?? model.xs[0]
    const to = range?.to ?? model.xs.at(-1)
    const parts = series
      .map((s, i) => {
        const v = latest[i]
        return `${s.label} ${v === null || v === undefined ? t('uiLibrary.charts.unknown', 'unknown') : fmt(v, unitOf(s))}`
      })
      .join('; ')
    if (from === undefined || to === undefined || !(to > from)) {
      return t('uiLibrary.charts.seriesSummaryNoRange', '{{title}}: {{parts}}', { title, parts })
    }
    return t('uiLibrary.charts.seriesSummary', '{{title}}, {{from}} to {{to}}: {{parts}}', {
      title,
      from: formatTimeLabel(from, to - from),
      to: formatTimeLabel(to, to - from),
      parts,
    })
  }, [model, series, range, title, t, fmt])

  const toolbar = (
    <>
      {windowToggle && <ChartWindowToggle {...windowToggle} />}
      {actions}
    </>
  )
  const sizeClass = height <= 64 ? 'sm' : height <= 120 ? 'md' : 'lg'
  const placeholder = pending ? (
    <ChartPlaceholder message={t('uiLibrary.charts.loading', 'Loading…')} height={sizeClass} />
  ) : model.empty ? (
    <ChartPlaceholder
      message={emptyMessage ?? t('uiLibrary.charts.empty', 'Nothing was recorded in this window.')}
      height={sizeClass}
    />
  ) : undefined

  return (
    <ChartFrame
      title={title}
      actions={toolbar}
      readoutTime={readoutTime}
      legend={legend}
      summary={summary}
      footer={footer}
      placeholder={placeholder}
      className={className}
    >
      <UPlotHost
        optionsKey={optionsKey}
        buildOptions={buildOptions}
        data={data}
        height={height}
        tooltip={tooltip}
        kind="lines"
        label={title}
      />
    </ChartFrame>
  )
}
