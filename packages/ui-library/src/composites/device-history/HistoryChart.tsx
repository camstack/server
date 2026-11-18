/**
 * One chart of a device's History view, from its spec and the reads.
 * Lines → `TimeSeriesChart`, states → `StateTimeline`, energy → `BarSeries`
 * with the window total, occupancy → one `TimeSeriesChart` of every
 * (zone × class) scope with zone and class filters.
 *
 * A read that failed says so in place of the chart; a read that answered no
 * point is the empty state — never a flat zero.
 */
import { useMemo, useState, type JSX, type ReactNode } from 'react'
import { convertUnit } from '@camstack/types'
import type {
  DeviceHistoryQueryResult,
  DeviceHistoryQueryManyEntry,
  DeviceHistorySeriesInfo,
  DeviceRun,
} from '@camstack/types'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { useUnitPreferences } from '../../contexts/unit-preferences'
import { Select } from '../../primitives/select'
import { BarSeries } from '../charts/BarSeries'
import { ChartPlaceholder } from '../charts/chart-frame'
import { StateTimeline } from '../charts/StateTimeline'
import { TimeSeriesChart, type TimeSeriesDef } from '../charts/TimeSeriesChart'
import { RUN_BANDS_SERIES_KEY, runBands } from './history-runs'
import {
  energyBuckets,
  filterOccupancyLines,
  linePoints,
  occupancyFacets,
  occupancyLines,
  shiftPoints,
  stateRow,
  type HistoryChartSpec,
  type OccupancyFilter,
} from './history-model'
import { chartUnitState, convertPoints } from './history-units'
import type { HistoryReads } from './use-device-history'
import type { HistoryWindow } from './history-window'

export interface HistoryChartProps {
  readonly spec: HistoryChartSpec
  /** Entry for a series key (all scopes), current and previous period. */
  readonly entryFor: (key: string, previous: boolean) => DeviceHistoryQueryManyEntry | undefined
  readonly reads: HistoryReads | null
  readonly window: HistoryWindow
  readonly compare: boolean
  readonly syncKey: string
  readonly actions?: ReactNode
  /** The device's runs, drawn as bands on its power chart; an open run extends to `now`. */
  readonly runs?: readonly DeviceRun[]
  readonly now?: number
}

const ALL = '__all__'

/** Operator words for a boolean field's two states. */
export function booleanLabels(
  key: string,
  t: UiTextFn,
): { readonly on: string; readonly off: string } {
  const field = key.split('.').at(-1) ?? ''
  if (/open/i.test(field)) {
    return {
      on: t('uiLibrary.history.state.open', 'open'),
      off: t('uiLibrary.history.state.closed', 'closed'),
    }
  }
  if (/online|connected/i.test(field)) {
    return {
      on: t('uiLibrary.history.state.online', 'online'),
      off: t('uiLibrary.history.state.offline', 'offline'),
    }
  }
  if (/detected|tampered/i.test(field)) {
    return {
      on: t('uiLibrary.history.state.detected', 'detected'),
      off: t('uiLibrary.history.state.clear', 'clear'),
    }
  }
  return { on: t('uiLibrary.history.state.on', 'on'), off: t('uiLibrary.history.state.off', 'off') }
}

function failure(entry: DeviceHistoryQueryManyEntry | undefined): string | null {
  return entry !== undefined && !entry.ok ? entry.error : null
}

export function HistoryChart({
  spec,
  entryFor,
  reads,
  window,
  compare,
  syncKey,
  actions,
  runs,
  now,
}: HistoryChartProps): JSX.Element {
  const t = useUiText()
  const pending = reads === null
  if (spec.type === 'states') {
    const entry = entryFor(spec.series.key, false)
    const err = failure(entry)
    if (err) return <ReadFailed title={spec.title} error={err} actions={actions} />
    const result = entry?.ok ? entry.result : undefined
    const row = stateRow(spec.series, result, window.from, window.to)
    const labels = booleanLabels(spec.series.key, t)
    return (
      <StateTimeline
        title={spec.title}
        range={window}
        syncKey={syncKey}
        pending={pending}
        actions={actions}
        rows={[
          {
            id: spec.id,
            label: spec.title,
            kind: spec.series.kind === 'boolean' ? 'boolean' : 'enum',
            states: row.states,
            segments: row.segments,
            totals: row.totals,
            stateLabel:
              spec.series.kind === 'boolean'
                ? (s) => (s === 'true' ? labels.on : labels.off)
                : undefined,
          },
        ]}
      />
    )
  }
  if (spec.type === 'energy') {
    const entry = entryFor(spec.series.key, false)
    const err = failure(entry)
    if (err) return <ReadFailed title={spec.title} error={err} actions={actions} />
    return (
      <EnergyChart
        spec={spec}
        result={entry?.ok ? entry.result : undefined}
        window={window}
        syncKey={syncKey}
        pending={pending}
        actions={actions}
      />
    )
  }
  if (spec.type === 'occupancy') {
    return (
      <OccupancyChart
        spec={spec}
        entryFor={entryFor}
        reads={reads}
        window={window}
        compare={compare}
        syncKey={syncKey}
        actions={actions}
      />
    )
  }
  return (
    <LinesChart
      title={spec.title}
      series={spec.series}
      entryFor={entryFor}
      reads={reads}
      window={window}
      compare={compare}
      syncKey={syncKey}
      actions={actions}
      runs={spec.series.some((s) => s.key === RUN_BANDS_SERIES_KEY) ? runs : undefined}
      now={now}
      labelOf={(s) => (spec.series.length > 1 || s.scope !== '' ? seriesLabel(s) : spec.title)}
    />
  )
}

/** The small unit selector of a chart; nothing when the dimension offers no choice. */
function UnitSwitch({
  choices,
  value,
  onChange,
}: {
  readonly choices: readonly string[]
  readonly value: string
  readonly onChange: (unit: string) => void
}): JSX.Element | null {
  const t = useUiText()
  if (choices.length < 2) return null
  return (
    <Select
      aria-label={t('uiLibrary.history.unitSwitch', 'Unit')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-6 text-[10px] py-0"
      options={choices.map((u) => ({ value: u, label: u }))}
    />
  )
}

/** The unit a chart shows: the user's pick, else what their unit preferences say. */
function useChartUnit(base: string | null): {
  readonly unit: string | null
  readonly choices: readonly string[]
  readonly pick: (unit: string) => void
} {
  const preferences = useUnitPreferences()
  const [picked, setPicked] = useState<string | null>(null)
  return { ...chartUnitState(base, picked, preferences), pick: setPicked }
}

function EnergyChart({
  spec,
  result,
  window,
  syncKey,
  pending,
  actions,
}: {
  readonly spec: Extract<HistoryChartSpec, { type: 'energy' }>
  readonly result: DeviceHistoryQueryResult | undefined
  readonly window: HistoryWindow
  readonly syncKey: string
  readonly pending: boolean
  readonly actions?: ReactNode
}): JSX.Element {
  const base = spec.series.unit
  const { unit, choices, pick } = useChartUnit(base)
  const { buckets, bucketMs } = energyBuckets(result)
  const converted =
    base === null || unit === null || unit === base
      ? buckets
      : buckets.map((b) => ({
          ...b,
          values: b.values.map((v) => (v === null ? null : convertUnit(v, base, unit))),
        }))
  return (
    <BarSeries
      title={spec.title}
      layers={[{ id: 'kwh', label: spec.title, colorIndex: 4 }]}
      buckets={converted}
      bucketMs={bucketMs}
      range={window}
      unit={unit}
      showTotal
      syncKey={syncKey}
      pending={pending}
      actions={
        <>
          <UnitSwitch choices={choices} value={unit ?? ''} onChange={pick} />
          {actions}
        </>
      }
    />
  )
}

function seriesLabel(s: DeviceHistorySeriesInfo): string {
  return s.scope === '' ? s.displayName : `${s.displayName} · ${s.scope}`
}

interface LinesChartProps {
  readonly title: string
  readonly series: readonly DeviceHistorySeriesInfo[]
  readonly entryFor: HistoryChartProps['entryFor']
  readonly reads: HistoryReads | null
  readonly window: HistoryWindow
  readonly compare: boolean
  readonly syncKey: string
  readonly actions?: ReactNode
  readonly labelOf: (s: DeviceHistorySeriesInfo) => string
  readonly toolbar?: ReactNode
  readonly runs?: readonly DeviceRun[]
  readonly now?: number
  /** Slot per series (stable identity); default its index. */
  readonly colorOf?: (s: DeviceHistorySeriesInfo, index: number) => number
}

function LinesChart({
  title,
  series,
  entryFor,
  reads,
  window,
  compare,
  syncKey,
  actions,
  labelOf,
  toolbar,
  colorOf,
  runs,
  now,
}: LinesChartProps): JSX.Element {
  const t = useUiText()
  const baseUnit = series[0]?.unit ?? null
  const chartUnit = useChartUnit(baseUnit)
  const errors = [
    ...new Set(
      series.map((s) => failure(entryFor(s.key, false))).filter((e): e is string => e !== null),
    ),
  ]
  const heldUntil = Math.min(window.to, now ?? window.to)
  const defs = useMemo<readonly TimeSeriesDef[]>(() => {
    const out: TimeSeriesDef[] = []
    series.forEach((s, i) => {
      const cur = entryFor(s.key, false)
      const result = cur?.ok ? cur.result : undefined
      const shaped = linePoints(s, result, window.from, heldUntil)
      const shown = chartUnit.unit !== null && s.unit !== null ? chartUnit.unit : s.unit
      const shownPoints =
        shown !== null && s.unit !== null
          ? convertPoints(shaped.points, s.unit, shown)
          : shaped.points
      const color = colorOf?.(s, i) ?? i
      const interpolation = shaped.held && result?.resolution === 'raw' ? 'step' : 'linear'
      out.push({
        id: `${s.key}|${s.scope}`,
        label: labelOf(s),
        unit: shown,
        colorIndex: color,
        points: shownPoints,
        gapMs: shaped.gapMs,
        interpolation,
        band: series.length === 1 && result !== undefined && result.resolution !== 'raw',
      })
      if (compare && reads?.previous) {
        const prev = entryFor(s.key, true)
        const prevResult = prev?.ok ? prev.result : undefined
        if (prevResult) {
          const prevShaped = linePoints(
            s,
            prevResult,
            window.from - reads.shiftMs,
            heldUntil - reads.shiftMs,
          )
          const prevPoints =
            shown !== null && s.unit !== null
              ? convertPoints(prevShaped.points, s.unit, shown)
              : prevShaped.points
          out.push({
            id: `${s.key}|${s.scope}|previous`,
            label: t('uiLibrary.history.previousOf', '{{label}} (previous period)', {
              label: labelOf(s),
            }),
            unit: shown,
            colorIndex: color,
            points: shiftPoints(prevPoints, reads.shiftMs),
            gapMs: prevShaped.gapMs,
            interpolation,
            compare: true,
          })
        }
      }
    })
    return out
  }, [
    series,
    entryFor,
    window.from,
    heldUntil,
    compare,
    reads,
    labelOf,
    colorOf,
    t,
    chartUnit.unit,
  ])
  const bands = useMemo(
    () => (runs === undefined ? [] : runBands(runs, now ?? window.to, window, t)),
    [runs, now, window, t],
  )
  if (errors.length > 0)
    return <ReadFailed title={title} error={errors.join('; ')} actions={actions} />
  return (
    <TimeSeriesChart
      title={title}
      series={defs}
      bands={bands}
      range={window}
      syncKey={syncKey}
      pending={reads === null}
      actions={
        <>
          {toolbar}
          <UnitSwitch
            choices={chartUnit.choices}
            value={chartUnit.unit ?? ''}
            onChange={chartUnit.pick}
          />
          {actions}
        </>
      }
    />
  )
}

function OccupancyChart({
  spec,
  entryFor,
  reads,
  window,
  compare,
  syncKey,
  actions,
}: Omit<HistoryChartProps, 'spec'> & {
  readonly spec: Extract<HistoryChartSpec, { type: 'occupancy' }>
}): JSX.Element {
  const t = useUiText()
  const [zone, setZone] = useState<string>(ALL)
  const [cls, setCls] = useState<string>(ALL)
  const lines = useMemo(() => occupancyLines(spec.series), [spec.series])
  const facets = useMemo(() => occupancyFacets(lines), [lines])
  const filter: OccupancyFilter = {
    zone: zone === ALL ? null : zone,
    className: cls === ALL ? null : cls,
  }
  const kept = new Set(filterOccupancyLines(lines, filter).map((l) => l.scope))
  const shown = spec.series.filter((s) => kept.has(s.scope))
  const zoneName = (z: string): string =>
    z === '' ? t('uiLibrary.history.wholeFrame', 'Whole frame') : z
  const labelOf = (s: DeviceHistorySeriesInfo): string => {
    const l = lines.find((x) => x.scope === s.scope)
    if (!l) return s.scope
    return l.className === undefined ? zoneName(l.zoneId) : `${zoneName(l.zoneId)} · ${l.className}`
  }
  // The slot is the scope's place among the UNFILTERED scopes of its kind (the
  // zone aggregates, or one class's zones), so a filter never repaints a line
  // and the lines on screen take neighbouring slots.
  const colorOf = (s: DeviceHistorySeriesInfo): number => {
    const own = lines.find((l) => l.scope === s.scope)
    const peers = lines.filter((l) => l.className === own?.className)
    return Math.max(
      0,
      peers.findIndex((l) => l.scope === s.scope),
    )
  }
  const toolbar = (
    <>
      {facets.zones.length > 1 && (
        <Select
          aria-label={t('uiLibrary.history.filterZone', 'Zone')}
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          className="h-6 text-[10px] py-0"
          options={[
            { value: ALL, label: t('uiLibrary.history.allZones', 'All zones') },
            ...facets.zones.map((z) => ({ value: z, label: zoneName(z) })),
          ]}
        />
      )}
      {facets.classes.length > 0 && (
        <Select
          aria-label={t('uiLibrary.history.filterClass', 'Class')}
          value={cls}
          onChange={(e) => setCls(e.target.value)}
          className="h-6 text-[10px] py-0"
          options={[
            { value: ALL, label: t('uiLibrary.history.allClasses', 'All classes') },
            ...facets.classes.map((c) => ({ value: c, label: c })),
          ]}
        />
      )}
    </>
  )
  return (
    <LinesChart
      title={spec.title}
      series={shown}
      entryFor={entryFor}
      reads={reads}
      window={window}
      compare={compare}
      syncKey={syncKey}
      actions={actions}
      toolbar={toolbar}
      labelOf={labelOf}
      colorOf={colorOf}
    />
  )
}

function ReadFailed({
  title,
  error,
  actions,
}: {
  readonly title: string
  readonly error: string
  readonly actions?: ReactNode
}): JSX.Element {
  const t = useUiText()
  return (
    <figure className="min-w-0 m-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <figcaption className="text-[10px] uppercase tracking-wider text-foreground-subtle truncate">
          {title}
        </figcaption>
        {actions}
      </div>
      <ChartPlaceholder
        height="md"
        message={t('uiLibrary.history.readFailed', 'This history could not be read: {{error}}', {
          error,
        })}
      />
    </figure>
  )
}
