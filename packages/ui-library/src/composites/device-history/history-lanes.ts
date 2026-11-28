/**
 * The pure half of the global History block: which lanes the visible points
 * make. One line lane per unit (every gauge or counter of that unit, one
 * chart — never a dual axis), and ONE band lane of every on/off or enum
 * series. Energy bars and a camera's occupancy are not lanes: they stay in
 * the single charts.
 */
import type { DeviceHistorySeriesInfo } from '@dominevo/types'
import type { HistoryChartSpec } from './history-model'

type LinesSpec = Extract<HistoryChartSpec, { type: 'lines' }>
type StatesSpec = Extract<HistoryChartSpec, { type: 'states' }>

export type HistoryLane =
  | {
      readonly kind: 'unit'
      readonly id: string
      /** `null`: series that declare no unit. */
      readonly unit: string | null
      readonly spec: LinesSpec
    }
  | {
      readonly kind: 'bands'
      readonly id: 'bands'
      readonly specs: readonly StatesSpec[]
    }

/** The lane id a unit's series share; stable across renders. */
export function unitLaneId(unit: string | null): string {
  return `lane:${unit ?? ''}`
}

/**
 * Lanes for the charts on screen, line lanes first in order of appearance,
 * the band lane last. A series two charts both carry is drawn once.
 */
export function historyLanes(
  charts: readonly HistoryChartSpec[],
  unitTitle: (unit: string | null) => string,
): readonly HistoryLane[] {
  const byUnit = new Map<string, { unit: string | null; series: DeviceHistorySeriesInfo[] }>()
  const bands: StatesSpec[] = []
  const seen = new Set<string>()
  for (const chart of charts) {
    if (chart.type === 'states') {
      if (!seen.has(`${chart.series.key}|${chart.series.scope}`)) {
        seen.add(`${chart.series.key}|${chart.series.scope}`)
        bands.push(chart)
      }
      continue
    }
    if (chart.type !== 'lines') continue
    const id = unitLaneId(chart.unit)
    const lane = byUnit.get(id) ?? { unit: chart.unit, series: [] }
    for (const s of chart.series) {
      const key = `${s.key}|${s.scope}`
      if (seen.has(key)) continue
      seen.add(key)
      lane.series.push(s)
    }
    byUnit.set(id, lane)
  }
  const lanes: HistoryLane[] = []
  for (const [id, lane] of byUnit) {
    if (lane.series.length === 0) continue
    lanes.push({
      kind: 'unit',
      id,
      unit: lane.unit,
      spec: {
        type: 'lines',
        id,
        title: unitTitle(lane.unit),
        unit: lane.unit,
        group: null,
        series: lane.series,
      },
    })
  }
  if (bands.length > 0) lanes.push({ kind: 'bands', id: 'bands', specs: bands })
  return lanes
}
