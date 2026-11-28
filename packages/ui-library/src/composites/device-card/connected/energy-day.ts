/**
 * The selected day of an energy system: its local-day window, the day totals
 * read from the recorded counters, and the flow-source spans read from the
 * recorded signed powers. Pure. A day nothing recorded is null, never 0 (D393).
 */
import type { DeviceHistoryQueryResult } from '@dominevo/types'
import type { TimePoint } from '../../charts/chart-data'
import { ENERGY_STILL_BELOW_W, type EnergyToday } from '../scenes/energy/model'
import { energyBalance, netGridKwh, selfConsumptionPct } from './energy-model'

export interface EnergyDayWindow {
  /** Local midnight that opens the day. */
  readonly from: number
  /** Local midnight that closes it (the next day's `from`; DST-safe, so 23 to 25 h). */
  readonly to: number
}

/** The local day `offsetDays` before the day `now` falls in (0 = today). */
export function energyDayWindow(now: number, offsetDays: number): EnergyDayWindow {
  const d = new Date(now)
  const y = d.getFullYear()
  const m = d.getMonth()
  const day = d.getDate() - offsetDays
  return {
    from: new Date(y, m, day).getTime(),
    to: new Date(y, m, day + 1).getTime(),
  }
}

/**
 * The x domain a day chart draws. A past day is the whole local day. Today ends
 * at the present, or at the last recorded point when that is later, never past
 * the day's own end — so the axis stops where the data does instead of
 * stretching to a midnight that has not happened.
 */
export function energyChartRange(
  window: EnergyDayWindow,
  isToday: boolean,
  now: number,
  lastPointAt: number | null,
): EnergyDayWindow {
  if (!isToday) return window
  const end = Math.max(now, lastPointAt ?? now)
  return { from: window.from, to: Math.min(window.to, Math.max(window.from + 1, end)) }
}

/** A flat counter counts as 0 only when it was read within this long before the window. */
const FLAT_COUNTER_MAX_AGE_MS = 24 * 3_600_000

/**
 * The kWh a recorded counter grew by over a read: the sum of its points'
 * `delta`. A counter that was read but did not move (no point carries a delta,
 * and the value held before the window is known) grew by 0. Null when nothing
 * was read at all: no series, a day with no recording, a failed read (D393).
 */
export function counterDayTotal(
  result: DeviceHistoryQueryResult | undefined,
  windowFrom: number,
): number | null {
  const series = result?.series[0]
  if (series === undefined) return null
  let total: number | null = null
  for (const p of series.points) if (p.delta !== null) total = (total ?? 0) + p.delta
  if (total !== null) return total
  const before = series.before
  if (before === null || before.value === null) return null
  // A counter last read long before the window is a dead sensor, not a still one.
  return windowFrom - before.t <= FLAT_COUNTER_MAX_AGE_MS ? 0 : null
}

/** What the day's counters said, kWh; each null when that counter has no reading. */
export interface EnergyDayTotals {
  readonly producedKwh: number | null
  /** Null when the system has no heat pump series. */
  readonly heatPumpKwh: number | null
  readonly importedKwh: number | null
  readonly exportedKwh: number | null
  readonly chargedKwh: number | null
  readonly dischargedKwh: number | null
}

/** Kills float residue (11.299999) without costing a decimal the operator may have asked for. */
const settle = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 1000) / 1000

/** The card's day facts of a past day, from its counters. Null when nothing was recorded at all. */
export function energyTodayOfDay(
  totals: EnergyDayTotals,
  hasHeatPump: boolean,
  hasStorage: boolean,
): EnergyToday | null {
  const balance = energyBalance(
    {
      producedKwh: totals.producedKwh,
      importedKwh: totals.importedKwh,
      exportedKwh: totals.exportedKwh,
      chargedKwh: totals.chargedKwh,
      dischargedKwh: totals.dischargedKwh,
      heatPumpKwh: totals.heatPumpKwh,
      hasStorage,
    },
    hasHeatPump,
  )
  const day: EnergyToday = {
    producedKwh: settle(totals.producedKwh),
    selfConsumptionPct: selfConsumptionPct(totals.producedKwh, totals.exportedKwh),
    importedKwh: settle(totals.importedKwh),
    exportedKwh: settle(totals.exportedKwh),
    netGridKwh: netGridKwh(totals.importedKwh, totals.exportedKwh),
    heatPumpKwh: settle(totals.heatPumpKwh),
    houseKwh: balance.consumptionKwh,
    householdKwh: balance.householdKwh,
    sources: balance.sources,
    selfSufficiencyPct: balance.selfSufficiencyPct,
    autonomyHours: null,
    chargedTodayKwh: settle(totals.chargedKwh),
    dischargedTodayKwh: settle(totals.dischargedKwh),
    socPct: null,
    healthPct: null,
    heatPumpShareNowPct: null,
  }
  return Object.values(day).some((v) => v !== null) ? day : null
}

/** Where the house's energy comes from or goes to, per span of the day. */
export type EnergyFlowSource = 'from-grid' | 'to-grid' | 'from-battery' | 'to-battery'

export interface EnergyFlowSpan {
  readonly source: EnergyFlowSource
  readonly from: number
  readonly to: number
}

/** The value of a held series at `t`: its last point at or before `t`, else null. */
function valueAt(points: readonly TimePoint[], t: number): number | null {
  let v: number | null = null
  for (const p of points) {
    if (p.t > t) break
    v = p.v
  }
  return v
}

/**
 * The flow-source spans of a window, from the signed grid power (+ import) and
 * the signed storage power (+ charging). A node below the still threshold, or
 * with no reading, contributes nothing: an unknown power draws no span.
 * Contiguous stretches of one source are merged; the spans of different sources
 * may overlap (the grid and the battery can run at the same time).
 */
export function energyFlowSpans(
  gridW: readonly TimePoint[],
  storageW: readonly TimePoint[],
  range: EnergyDayWindow,
): readonly EnergyFlowSpan[] {
  const times = [...new Set([...gridW, ...storageW].map((p) => p.t))]
    .filter((t) => t >= range.from && t < range.to)
    .sort((a, b) => a - b)
  const open = new Map<EnergyFlowSource, number>()
  const out: EnergyFlowSpan[] = []
  const close = (source: EnergyFlowSource, to: number): void => {
    const from = open.get(source)
    if (from === undefined) return
    open.delete(source)
    if (to > from) out.push({ source, from, to })
  }
  for (const t of [...times, range.to]) {
    const grid = valueAt(gridW, t)
    const storage = valueAt(storageW, t)
    const active = new Set<EnergyFlowSource>()
    if (t < range.to) {
      if (grid !== null && grid >= ENERGY_STILL_BELOW_W) active.add('from-grid')
      if (grid !== null && grid <= -ENERGY_STILL_BELOW_W) active.add('to-grid')
      if (storage !== null && storage >= ENERGY_STILL_BELOW_W) active.add('to-battery')
      if (storage !== null && storage <= -ENERGY_STILL_BELOW_W) active.add('from-battery')
    }
    for (const source of [...open.keys()]) if (!active.has(source)) close(source, t)
    for (const source of active) if (!open.has(source)) open.set(source, t)
  }
  return out
}
