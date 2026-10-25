/**
 * The History page's right pane: the selected series overlaid on ONE window —
 * gauges and counters on one line chart with a value axis per unit, states as
 * the rows of one timeline, energy as stacked bars with the window total.
 * All three share a cursor.
 */
import { useMemo } from 'react'
import type { DeviceHistoryQueryManyEntry } from '@camstack/types'
import {
  BarSeries,
  EmptyState,
  ErrorBox,
  StateTimeline,
  TimeSeriesChart,
  booleanLabels,
  energyBuckets,
  linePoints,
  readItemId,
  stateRow,
  useHistoryReads,
  useUiText,
  type HistoryWindow,
  type StateRowDef,
  type TimeSeriesDef,
} from '@camstack/ui-library'
import { LineChart } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { readItemOf, type OverlayPart, type SeriesCandidate } from './history-page-model'

export interface HistoryOverlayProps {
  readonly part: OverlayPart
  readonly window: HistoryWindow
}

const SYNC_KEY = 'history-page'

function labelOf(c: SeriesCandidate): string {
  return `${c.subjectName} · ${c.metric}`
}

/**
 * A series' colour slot is its place among the series of ITS chart, in
 * selection order: each chart carries its own legend, and a line chart never
 * skips slots for series that are drawn elsewhere.
 */
export function HistoryOverlay({ part, window }: HistoryOverlayProps) {
  const { t } = useTranslation()
  const ut = useUiText()
  const all = useMemo(() => [...part.lines, ...part.states, ...part.energy], [part])
  const items = useMemo(() => all.map((c) => readItemOf(c.ref)), [all])
  const reads = useHistoryReads(items, window, false)

  const entryOf = (c: SeriesCandidate): DeviceHistoryQueryManyEntry | undefined =>
    reads.status === 'ok' ? reads.data.current.get(readItemId(readItemOf(c.ref))) : undefined
  const resultOf = (c: SeriesCandidate) => {
    const e = entryOf(c)
    return e?.ok ? e.result : undefined
  }

  if (all.length === 0) {
    return (
      <EmptyState
        icon={LineChart}
        title={t('history.page.emptyTitle', 'Pick series to compare')}
        description={t(
          'history.page.emptyHint',
          'Choose up to 24 series on the left, or start from a panel above.',
        )}
      />
    )
  }
  if (reads.status === 'error') {
    return (
      <ErrorBox
        title={t('history.page.readFailed', 'History could not be read')}
        message={reads.error}
      />
    )
  }
  const pending = reads.status === 'pending'
  const failures = all
    .map((c) => ({ c, e: entryOf(c) }))
    .filter(
      (x): x is { c: SeriesCandidate; e: Extract<DeviceHistoryQueryManyEntry, { ok: false }> } =>
        x.e?.ok === false,
    )

  const lineDefs: TimeSeriesDef[] = part.lines.map((c, slot) => {
    const result = resultOf(c)
    const shaped = linePoints(c.info, result, window.from)
    return {
      id: c.id,
      label: labelOf(c),
      unit: c.info.unit,
      colorIndex: slot,
      points: shaped.points,
      gapMs: shaped.gapMs,
      interpolation: shaped.held && result?.resolution === 'raw' ? 'step' : 'linear',
    }
  })
  const stateRows: StateRowDef[] = part.states.map((c, slot) => {
    const row = stateRow(c.info, resultOf(c), window.from, window.to)
    const labels = booleanLabels(c.info.key, ut)
    return {
      id: c.id,
      label: labelOf(c),
      kind: c.info.kind === 'boolean' ? 'boolean' : 'enum',
      // An enum's states take the slots in their value order; a boolean's "on" its row's.
      colorIndex: c.info.kind === 'boolean' ? slot : 0,
      states: row.states,
      segments: row.segments,
      totals: row.totals,
      stateLabel:
        c.info.kind === 'boolean' ? (s) => (s === 'true' ? labels.on : labels.off) : undefined,
    }
  })
  const energy = part.energy.map((c) => ({ c, ...energyBuckets(resultOf(c)) }))
  const bucketMs = energy[0]?.bucketMs ?? 3_600_000
  const starts = [...new Set(energy.flatMap((e) => e.buckets.map((b) => b.t)))].sort(
    (a, b) => a - b,
  )
  const energyBucketsMerged = starts.map((t0) => ({
    t: t0,
    values: energy.map((e) => e.buckets.find((b) => b.t === t0)?.values[0] ?? null),
  }))

  return (
    <div className="space-y-5 min-w-0">
      {failures.length > 0 && (
        <ErrorBox
          title={t('history.page.someFailed', 'Some series could not be read')}
          message={failures.map((f) => `${labelOf(f.c)}: ${f.e.error}`).join(' · ')}
        />
      )}
      {lineDefs.length > 0 && (
        <TimeSeriesChart
          title={t('history.page.lines', 'Measurements')}
          series={lineDefs}
          range={window}
          height={260}
          syncKey={SYNC_KEY}
          pending={pending}
        />
      )}
      {energy.length > 0 && (
        <BarSeries
          title={t('history.page.energy', 'Energy')}
          layers={energy.map((e, slot) => ({
            id: e.c.id,
            label: e.c.subjectName,
            colorIndex: slot,
          }))}
          buckets={energyBucketsMerged}
          bucketMs={bucketMs}
          range={window}
          unit="kWh"
          showTotal
          height={160}
          syncKey={SYNC_KEY}
          pending={pending}
        />
      )}
      {stateRows.length > 0 && (
        <StateTimeline
          title={
            stateRows.length === 1
              ? (stateRows[0]?.label ?? '')
              : t('history.page.states', 'States')
          }
          rows={stateRows}
          range={window}
          syncKey={SYNC_KEY}
          pending={pending}
        />
      )}
    </div>
  )
}
