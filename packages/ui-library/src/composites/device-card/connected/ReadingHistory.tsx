import type {
  DeviceHistoryQueryResult,
  DeviceHistorySeriesInfo,
  HeroMeasurement,
  HeroMeasurementQuantity,
} from '@dominevo/types'
import { type ReactElement, useMemo } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import { Skeleton } from '../../../primitives/skeleton'
import type { TimePoint } from '../../charts/chart-data'
import { StateTimeline } from '../../charts/StateTimeline'
import { TimeSeriesChart, type TimeSeriesDef } from '../../charts/TimeSeriesChart'
import { booleanLabels } from '../../device-history/HistoryChart'
import { linePoints, stateRow } from '../../device-history/history-model'
import { chartUnitChoices, convertPoints } from '../../device-history/history-units'
import { HISTORY_WINDOW_MS } from '../../device-history/history-window'
import {
  anchorNow,
  readItemId,
  useDeviceSeriesList,
  useHistoryReads,
} from '../../device-history/use-device-history'
import { readingSlot } from '../scenes/sensor/reading-colour'
import { quantityLabel } from './measurement-label'

/** The state series of a reading that is on/off rather than a number (no trend line). */
export const STATE_READING_HISTORY_KEY: Readonly<Partial<Record<HeroMeasurementQuantity, string>>> =
  {
    motion: 'cap:motion.detected',
    contact: 'cap:contact.entryOpen',
  }

const CHART_HEIGHT = 120

interface ReadingChartProps {
  readonly deviceId: number
  readonly seriesKey: string
  readonly label: string
  /** The unit the card shows the reading in: the axis and the tooltip use it. */
  readonly unit: string | null
  readonly slot: number
}

interface ReadingSeries {
  readonly info: DeviceHistorySeriesInfo | undefined
  readonly result: DeviceHistoryQueryResult | undefined
  readonly window: { readonly from: number; readonly to: number }
  /** An unanswered read is `pending`, never `absent` (D315). */
  readonly phase: 'pending' | 'absent' | 'error' | 'ok'
}

/** One reading's last day, read through the device history. */
function useReadingSeries(deviceId: number, seriesKey: string): ReadingSeries {
  const { presence, list } = useDeviceSeriesList(deviceId)
  const info =
    list.status === 'ok' ? list.data.find((s) => s.key === seriesKey && s.scope === '') : undefined
  const to = anchorNow(Date.now(), HISTORY_WINDOW_MS['24h'])
  const window = useMemo(() => ({ from: to - HISTORY_WINDOW_MS['24h'], to }), [to])
  const items = useMemo(() => [{ deviceId, key: seriesKey }], [deviceId, seriesKey])
  const reads = useHistoryReads(items, window, false, presence === 'present' && info !== undefined)
  const entry =
    reads.status === 'ok'
      ? reads.data.current.get(readItemId({ deviceId, key: seriesKey }))
      : undefined
  const result = entry?.ok === true ? entry.result : undefined
  const phase =
    presence === 'absent' || (list.status === 'ok' && info === undefined)
      ? 'absent'
      : list.status === 'error' || reads.status === 'error'
        ? 'error'
        : list.status === 'pending' || reads.status === 'pending' || presence !== 'present'
          ? 'pending'
          : 'ok'
  return { info, result, window, phase }
}

function NoHistory(): ReactElement {
  const t = useUiText()
  return (
    <span className="text-xs text-foreground-muted" data-testid="dc-pie-no-history">
      {t('uiLibrary.sensorPie.noHistory', 'No history is kept for this reading.')}
    </span>
  )
}

function HistoryError(): ReactElement {
  const t = useUiText()
  return (
    <p className="text-xs text-danger" data-testid="dc-pie-history-error">
      {t('uiLibrary.deviceCard.energy.day.error', 'The history could not be read.')}
    </p>
  )
}

/**
 * The compact "express" chart of the energy system card (`TimeSeriesChart`, one line,
 * no title) over one reading's last day, on the reading's own palette colour and in
 * the unit the card shows.
 */
function ReadingChart({ deviceId, seriesKey, label, unit, slot }: ReadingChartProps): ReactElement {
  const t = useUiText()
  const { info, result, window, phase } = useReadingSeries(deviceId, seriesKey)
  const series = useMemo<readonly TimeSeriesDef[]>(() => {
    if (info === undefined) return []
    const shaped = linePoints(info, result, window.from, Math.min(window.to, Date.now()))
    const base = info.unit
    const shown =
      base !== null && unit !== null && chartUnitChoices(base).includes(unit) ? unit : base
    const points: readonly TimePoint[] =
      base !== null && shown !== null ? convertPoints(shaped.points, base, shown) : shaped.points
    return [
      {
        id: seriesKey,
        label,
        unit: shown,
        points,
        colorIndex: slot,
        gapMs: shaped.gapMs,
        interpolation: shaped.held ? 'step' : 'linear',
      },
    ]
  }, [info, result, window, seriesKey, unit, label, slot])
  if (phase === 'absent') return <NoHistory />
  if (phase === 'error') return <HistoryError />
  if (phase === 'pending') return <Skeleton className="h-28 w-full" />
  return (
    <TimeSeriesChart
      title={label}
      hideTitle
      series={series}
      range={window}
      height={CHART_HEIGHT}
      className="w-full"
      emptyMessage={t('uiLibrary.sensorPie.noHistory', 'No history is kept for this reading.')}
    />
  )
}

/**
 * A state reading (motion, contact) as the library's one state band, in the reading's
 * own colour and with no title: the highlighted wedge or tile names it.
 */
function ReadingStateChart({
  deviceId,
  seriesKey,
  label,
  slot,
}: Omit<ReadingChartProps, 'unit'>): ReactElement {
  const t = useUiText()
  const { info, result, window, phase } = useReadingSeries(deviceId, seriesKey)
  if (phase === 'pending') return <Skeleton className="h-16 w-full" />
  if (phase === 'error') return <HistoryError />
  if (phase === 'absent' || info === undefined) return <NoHistory />
  const row = stateRow(info, result, window.from, window.to)
  const labels = booleanLabels(seriesKey, t)
  return (
    <StateTimeline
      title={label}
      hideTitle
      range={window}
      className="w-full"
      emptyMessage={t('uiLibrary.sensorPie.noHistory', 'No history is kept for this reading.')}
      rows={[
        {
          id: seriesKey,
          label,
          kind: info.kind === 'boolean' ? 'boolean' : 'enum',
          states: row.states,
          segments: row.segments,
          totals: row.totals,
          colorIndex: slot,
          stateLabel:
            info.kind === 'boolean' ? (s) => (s === 'true' ? labels.on : labels.off) : undefined,
        },
      ]}
    />
  )
}

export interface ReadingHistoryProps {
  readonly deviceId: number
  readonly measurement: HeroMeasurement
  readonly since: string | null
  /** The unit the reading is shown in (the card's own text); `null` = none. */
  readonly unit?: string | null
  /** The reading's chart-palette slot on its card; absent = its quantity's own. */
  readonly slot?: number
}

/**
 * One reading's last day, under the card: no title (the highlighted wedge or tile
 * names it), the axis in the unit the reading is shown in, the line in the reading's
 * own colour. A state reading (motion, contact) is one state band of ITS
 * series, never the device's whole History.
 */
export function ReadingHistory({
  deviceId,
  measurement,
  since,
  unit = null,
  slot,
}: ReadingHistoryProps): ReactElement {
  const t = useUiText()
  const label = quantityLabel(t, measurement.quantity)
  const stateKey = STATE_READING_HISTORY_KEY[measurement.quantity]
  const colour = slot ?? readingSlot(measurement)
  const body =
    measurement.historyKey !== null ? (
      <ReadingChart
        deviceId={deviceId}
        seriesKey={measurement.historyKey}
        label={label}
        unit={unit}
        slot={colour}
      />
    ) : stateKey !== undefined ? (
      <ReadingStateChart deviceId={deviceId} seriesKey={stateKey} label={label} slot={colour} />
    ) : (
      <NoHistory />
    )
  return (
    <div className="flex w-full flex-col items-center gap-2" data-testid="dc-pie-history">
      {since === null ? null : <span className="text-xs text-foreground-muted">{since}</span>}
      {body}
    </div>
  )
}
