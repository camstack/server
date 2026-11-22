/**
 * The selected day of an energy system read from `device-history`: the power
 * lines, the battery's charge, the flow-source spans, and the day totals from
 * the recorded counters. Each stage keeps "not answered" apart from "answered
 * nothing" (D315), and a failed read is never an empty day.
 */
import type {
  DeviceHistoryQueryManyEntry,
  DeviceHistoryQueryManyItem,
  DeviceHistorySeriesInfo,
} from '@camstack/types'
import { useMemo } from 'react'
import type { UiTextFn } from '../../../contexts/ui-text'
import { useCapabilityPresence } from '../../../hooks/use-capability-presence'
import type { TimePoint } from '../../charts/chart-data'
import type { TimeSeriesDef } from '../../charts/TimeSeriesChart'
import { linePoints } from '../../device-history/history-model'
import {
  anchorNow,
  readItemId,
  useDeviceSeriesList,
  useHistoryReads,
} from '../../device-history/use-device-history'
import { ENERGY_NODE_SLOT, type EnergyNodeId } from '../illustrations/EnergyFlowIllustration'
import type { EnergyDayStatus } from '../parts/EnergyDayPanel'
import type { EnergyToday } from '../scenes/energy/model'
import {
  counterDayTotal,
  type EnergyDayTotals,
  type EnergyDayWindow,
  type EnergyFlowSpan,
  energyDayWindow,
  energyFlowSpans,
  energyTodayOfDay,
} from './energy-day'

const PREFIX = 'cap:energy-system.'

interface PowerLine {
  readonly field: string
  readonly id: EnergyNodeId
  readonly textKey: string
  readonly fallback: string
}

const POWER_LINES: readonly PowerLine[] = [
  { field: 'solar.powerW', id: 'solar', textKey: 'solar', fallback: 'Solar' },
  { field: 'house.powerW', id: 'house', textKey: 'house', fallback: 'House' },
  { field: 'grid.powerW', id: 'grid', textKey: 'grid', fallback: 'Grid' },
  { field: 'storage.powerW', id: 'battery', textKey: 'battery', fallback: 'Battery' },
  { field: 'heatPump.powerW', id: 'heatPump', textKey: 'heatPump', fallback: 'Heat pump' },
]
const SOC_FIELD = 'storage.stateOfChargePct'

const COUNTER_FIELDS = [
  'solar.energyKwh',
  'heatPump.energyKwh',
  'grid.importKwh',
  'grid.exportKwh',
  'storage.chargedKwh',
  'storage.dischargedKwh',
] as const

export interface EnergyDay {
  readonly window: EnergyDayWindow
  readonly status: EnergyDayStatus
  readonly powerSeries: readonly TimeSeriesDef[]
  readonly socSeries: readonly TimeSeriesDef[]
  readonly flowSpans: readonly EnergyFlowSpan[]
  /** The day's facts from the counters; null while unanswered or when nothing was recorded. */
  readonly today: EnergyToday | null
}

const NONE: readonly TimePoint[] = []

/** Watts to kW for the axis: a short label ("4 kW") keeps the plot wide on a narrow card. */
function kilowatts(points: readonly TimePoint[]): readonly TimePoint[] {
  return points.map((p) => ({ t: p.t, v: p.v === null ? null : p.v / 1000 }))
}

function keyOf(field: string): string {
  return `${PREFIX}${field}`
}

function infoOf(
  list: readonly DeviceHistorySeriesInfo[],
  field: string,
): DeviceHistorySeriesInfo | undefined {
  return list.find((s) => s.key === keyOf(field) && s.scope === '')
}

/** Line points of a recorded gauge over the window; nothing when the system has no such series. */
function pointsOf(
  info: DeviceHistorySeriesInfo | undefined,
  entry: DeviceHistoryQueryManyEntry | undefined,
  window: EnergyDayWindow,
  until: number,
): readonly TimePoint[] {
  if (info === undefined || entry === undefined || !entry.ok) return NONE
  return linePoints(info, entry.result, window.from, until).points
}

function totalsOf(
  list: readonly DeviceHistorySeriesInfo[],
  read: (field: string) => DeviceHistoryQueryManyEntry | undefined,
  windowFrom: number,
): EnergyDayTotals {
  const total = (field: string): number | null => {
    const entry = read(field)
    return infoOf(list, field) === undefined || entry === undefined || !entry.ok
      ? null
      : counterDayTotal(entry.result, windowFrom)
  }
  return {
    producedKwh: total('solar.energyKwh'),
    heatPumpKwh: total('heatPump.energyKwh'),
    importedKwh: total('grid.importKwh'),
    exportedKwh: total('grid.exportKwh'),
    chargedKwh: total('storage.chargedKwh'),
    dischargedKwh: total('storage.dischargedKwh'),
  }
}

/**
 * `linkedHeatPumpKwh`: the day's electrical kWh of the heat pump device the
 * system is linked to (D1076), null while unread; `undefined` = no link, the
 * system's own heat pump counter is read.
 */
export function useEnergyDay(
  deviceId: number,
  dayOffset: number,
  t: UiTextFn,
  linkedHeatPumpKwh?: number | null,
): EnergyDay {
  const presence = useCapabilityPresence('device-history')
  const { list } = useDeviceSeriesList(deviceId)
  const now = anchorNow(Date.now(), 24 * 3_600_000)
  const window = useMemo(() => energyDayWindow(now, dayOffset), [now, dayOffset])
  const series = list.status === 'ok' ? list.data : NONE_SERIES
  const fields = useMemo(
    () =>
      [...POWER_LINES.map((l) => l.field), SOC_FIELD, ...COUNTER_FIELDS].filter(
        (f) => infoOf(series, f) !== undefined,
      ),
    [series],
  )
  const items = useMemo<readonly DeviceHistoryQueryManyItem[]>(
    () => fields.map((f) => ({ deviceId, key: keyOf(f) })),
    [fields, deviceId],
  )
  const reads = useHistoryReads(items, window, false, presence === 'present')
  return useMemo<EnergyDay>(() => {
    const empty = (status: EnergyDayStatus): EnergyDay => ({
      window,
      status,
      powerSeries: [],
      socSeries: [],
      flowSpans: [],
      today: null,
    })
    if (presence === 'absent') return empty('empty')
    if (presence !== 'present' || list.status === 'pending' || reads.status === 'pending') {
      return items.length === 0 && list.status === 'ok' ? empty('empty') : empty('pending')
    }
    if (list.status === 'error' || reads.status === 'error') return empty('error')
    const entryOf = (field: string): DeviceHistoryQueryManyEntry | undefined =>
      reads.data.current.get(readItemId({ deviceId, key: keyOf(field) }))
    const until = Math.min(Date.now(), window.to)
    const powerSeries = POWER_LINES.flatMap((line): TimeSeriesDef[] => {
      const points = pointsOf(infoOf(series, line.field), entryOf(line.field), window, until)
      return points.some((p) => p.v !== null)
        ? [
            {
              id: line.id,
              label: t(`uiLibrary.deviceCard.energy.day.${line.textKey}`, line.fallback),
              unit: 'kW',
              points: kilowatts(points),
              colorIndex: ENERGY_NODE_SLOT[line.id],
              interpolation: 'step',
            },
          ]
        : []
    })
    const soc = pointsOf(infoOf(series, SOC_FIELD), entryOf(SOC_FIELD), window, until)
    const socSeries: TimeSeriesDef[] = soc.some((p) => p.v !== null)
      ? [
          {
            id: 'soc',
            label: t('uiLibrary.deviceCard.energy.day.charge', 'Battery charge'),
            unit: '%',
            points: soc,
            colorIndex: ENERGY_NODE_SLOT.battery,
            interpolation: 'step',
          },
        ]
      : []
    const totals = totalsOf(series, entryOf, window.from)
    const today = energyTodayOfDay(
      linkedHeatPumpKwh === undefined ? totals : { ...totals, heatPumpKwh: linkedHeatPumpKwh },
      linkedHeatPumpKwh !== undefined || infoOf(series, 'heatPump.energyKwh') !== undefined,
      series.some((info) => info.key.startsWith(keyOf('storage.'))),
    )
    const status: EnergyDayStatus =
      powerSeries.length === 0 && socSeries.length === 0 && today === null ? 'empty' : 'ready'
    return {
      window,
      status,
      powerSeries,
      socSeries,
      flowSpans: energyFlowSpans(
        pointsOf(infoOf(series, 'grid.powerW'), entryOf('grid.powerW'), window, until),
        pointsOf(infoOf(series, 'storage.powerW'), entryOf('storage.powerW'), window, until),
        window,
      ),
      today,
    }
  }, [presence, list, reads, items, series, window, deviceId, t, linkedHeatPumpKwh])
}

const NONE_SERIES: readonly DeviceHistorySeriesInfo[] = []
