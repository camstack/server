/**
 * StateTimeline — boolean and enum states as bands over wall time (uPlot).
 *
 * One row per state series. A state is a filled band in its categorical slot
 * (the ordinal of the value in its `states` list, so a colour follows the
 * state, never its rank); a boolean's `false` is a recessive fill, and a span
 * nothing was recorded for is left EMPTY — unknown never looks like a state.
 * The legend gives the time spent in each state over the window ("open
 * 2h 14m"), and the cursor (synced through `syncKey`) names the state under it.
 */
import { useCallback, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type uPlot from 'uplot'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { ChartPlaceholder, ChartSwatch } from './chart-frame'
import {
  formatCursorTime,
  formatSpan,
  formatTimeLabel,
  stateAt,
  timeInState,
  type StateSegment,
} from './chart-data'
import {
  chartSeriesStyle,
  resolveChartColor,
  withAlpha,
  type ChartSwatchToken,
} from './chart-palette'
import { chartCursor, timeAxis } from './chart-uplot'
import type { ChartRange } from './TimeSeriesChart'
import { UPlotHost, type ChartPlotOptions } from './uplot-host'

export interface StateRowDef {
  readonly id: string
  readonly label: string
  readonly segments: readonly StateSegment[]
  /** Every state this row can take, in their stable order (an enum's value list). */
  readonly states: readonly string[]
  /** `boolean`: `states[1]` is the "on" state, drawn in `colorIndex`; `states[0]` is recessive. */
  readonly kind: 'boolean' | 'enum'
  /** Boolean: the slot of the "on" state. Enum: the slot offset of `states[0]`. Default 0. */
  readonly colorIndex?: number
  /** Operator text for a state value ("open" for `true`). */
  readonly stateLabel?: (state: string) => string
  /**
   * Exact time per state when the segments are an approximation (a rollup
   * bucket drawn in its dominant state); default: summed from the segments.
   */
  readonly totals?: ReadonlyMap<string, number>
}

export interface StateTimelineProps {
  readonly title: string
  readonly rows: readonly StateRowDef[]
  readonly range: ChartRange
  readonly syncKey?: string
  readonly pending?: boolean
  readonly emptyMessage?: string
  readonly actions?: ReactNode
  readonly className?: string
}

/** Pixel height of one row band — matches the `h-5` label cells. */
const ROW_PX = 20
const AXIS_PX = 22

/** The colour role of a state on a row: a categorical slot, or the recessive "off". */
export function stateStyle(
  row: Pick<StateRowDef, 'kind' | 'states' | 'colorIndex'>,
  state: string,
): { readonly token: ChartSwatchToken } {
  const base = row.colorIndex ?? 0
  if (row.kind === 'boolean') {
    return state === row.states[1] ? { token: chartSeriesStyle(base).token } : { token: 'border' }
  }
  const ordinal = Math.max(0, row.states.indexOf(state))
  return { token: chartSeriesStyle(base + ordinal).token }
}

export function StateTimeline({
  title,
  rows,
  range,
  syncKey,
  pending = false,
  emptyMessage,
  actions,
  className,
}: StateTimelineProps): JSX.Element {
  const t = useUiText()
  const [cursorT, setCursorT] = useState<number | null>(null)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const rangeRef = useRef(range)
  rangeRef.current = range
  const span = range.to - range.from
  const empty = rows.every((r) => r.segments.length === 0)
  const labelOf = (row: StateRowDef, s: string): string => row.stateLabel?.(s) ?? s

  const optionsKey = `${rows.map((r) => `${r.id}:${r.states.join('|')}`).join(',')}#${syncKey ?? ''}`
  const data = useMemo<uPlot.AlignedData>(
    () => [
      [range.from, range.to],
      [null, null],
    ],
    [range.from, range.to],
  )

  const buildOptions = useCallback(
    (): ChartPlotOptions => ({
      ms: 1,
      legend: { show: false },
      // The left gutter lines the bands up with the value axis of a line chart above.
      padding: [0, 30, 0, 40],
      scales: {
        x: {
          time: true,
          range: (): uPlot.Range.MinMax => [rangeRef.current.from, rangeRef.current.to],
        },
        y: { range: (): uPlot.Range.MinMax => [0, 1] },
      },
      axes: [
        timeAxis(() => rangeRef.current.to - rangeRef.current.from),
        { show: false, scale: 'y' },
      ],
      series: [{}, { scale: 'y', stroke: () => 'transparent', points: { show: false } }],
      cursor: { ...chartCursor(syncKey), points: { show: false } },
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx
            const list = rowsRef.current
            const pr = u.bbox.height / Math.max(1, list.length)
            ctx.save()
            list.forEach((row, ri) => {
              const y = u.bbox.top + ri * pr
              ctx.fillStyle = withAlpha(resolveChartColor('foreground-subtle'), 0.06)
              ctx.fillRect(u.bbox.left, y + 2, u.bbox.width, pr - 4)
              for (const seg of row.segments) {
                if (seg.state === null) continue
                const x0 = u.valToPos(Math.max(seg.from, rangeRef.current.from), 'x', true)
                const x1 = u.valToPos(Math.min(seg.to, rangeRef.current.to), 'x', true)
                if (!(x1 > x0)) continue
                ctx.fillStyle = resolveChartColor(stateStyle(row, seg.state).token)
                ctx.fillRect(x0, y + 2, Math.max(1, x1 - x0), pr - 4)
              }
            })
            ctx.restore()
          },
        ],
        setCursor: [
          (u) => {
            const left = u.cursor.left ?? -1
            setCursorT(left < 0 ? null : u.posToVal(left, 'x'))
          },
        ],
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt by `optionsKey`
    [optionsKey],
  )

  const durations = useMemo(() => rows.map((r) => r.totals ?? timeInState(r.segments)), [rows])
  const summary = rows
    .map((row, i) => {
      const parts = row.states
        .map((s) => {
          const ms = durations[i]?.get(s) ?? 0
          return ms > 0 ? `${labelOf(row, s)} ${formatSpan(ms)}` : null
        })
        .filter((p): p is string => p !== null)
        .join(', ')
      return `${row.label}: ${parts.length > 0 ? parts : t('uiLibrary.charts.noState', 'nothing recorded')}`
    })
    .join('; ')
  const fullSummary = t(
    'uiLibrary.charts.stateSummary',
    '{{title}}, {{from}} to {{to}}: {{parts}}',
    {
      title,
      from: formatTimeLabel(range.from, span),
      to: formatTimeLabel(range.to, span),
      parts: summary,
    },
  )

  const multi = rows.length > 1
  const placeholder = pending
    ? t('uiLibrary.charts.loading', 'Loading…')
    : empty
      ? (emptyMessage ?? t('uiLibrary.charts.empty', 'Nothing was recorded in this window.'))
      : null

  return (
    <figure className={cn('min-w-0 m-0', className)} data-chart-frame="">
      <div className="flex items-baseline justify-between gap-2 mb-1 min-w-0">
        <figcaption className="text-[10px] uppercase tracking-wider text-foreground-subtle truncate min-w-0">
          {title}
        </figcaption>
        <div className="flex items-center gap-2 shrink-0">
          {cursorT !== null && (
            <span className="text-[10px] tabular-nums text-foreground-subtle">
              {formatCursorTime(cursorT, span)}
            </span>
          )}
          {actions}
        </div>
      </div>
      {placeholder !== null ? (
        <ChartPlaceholder message={placeholder} height="sm" />
      ) : (
        <div role="img" aria-label={fullSummary} className="flex min-w-0">
          {multi && (
            <div className="w-20 sm:w-28 shrink-0 pr-2" aria-hidden="true">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="h-5 flex items-center text-[10px] text-foreground-muted truncate"
                >
                  {r.label}
                </div>
              ))}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <UPlotHost
              optionsKey={optionsKey}
              buildOptions={buildOptions}
              data={data}
              height={rows.length * ROW_PX + AXIS_PX}
            />
          </div>
        </div>
      )}
      <p className="sr-only">{fullSummary}</p>
      {placeholder === null && (
        <ul className="mt-1 space-y-0.5 list-none p-0 m-0">
          {rows.map((row, i) => {
            const now = cursorT === null ? null : stateAt(row.segments, cursorT)
            return (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 min-w-0">
                {multi && <span className="text-[10px] text-foreground-muted">{row.label}</span>}
                {row.states.map((s) => {
                  const ms = durations[i]?.get(s) ?? 0
                  if (ms === 0) return null
                  return (
                    <span
                      key={s}
                      className={cn(
                        'inline-flex items-center gap-1 text-[10px]',
                        now === s ? 'text-foreground' : 'text-foreground-muted',
                      )}
                    >
                      <ChartSwatch token={stateStyle(row, s).token} />
                      <span>{labelOf(row, s)}</span>
                      <span className="tabular-nums text-foreground">{formatSpan(ms)}</span>
                    </span>
                  )
                })}
              </li>
            )
          })}
        </ul>
      )}
    </figure>
  )
}
