import type { DeviceHistoryQueryResult } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  counterDayTotal,
  energyDayWindow,
  energyFlowSpans,
  energyTodayOfDay,
  type EnergyDayTotals,
} from '../energy-day'
import { netGridKwh, selfConsumptionPct } from '../energy-model'

const point = (
  t: number,
  delta: number | null,
): DeviceHistoryQueryResult['series'][number]['points'][number] => ({
  t,
  samples: 1,
  mean: null,
  twMean: null,
  min: 0,
  max: 0,
  last: null,
  delta,
  state: null,
  states: null,
})

function counter(
  deltas: readonly (number | null)[],
  before: number | null = null,
  beforeT = -1,
): DeviceHistoryQueryResult {
  return {
    resolution: '5m',
    truncated: false,
    series: [
      {
        scope: '',
        before: before === null ? null : { t: beforeT, value: before, state: null },
        derivedFrom: null,
        points: deltas.map((d, i) => point(i * 300_000, d)),
      },
    ],
  }
}

const EMPTY: EnergyDayTotals = {
  producedKwh: null,
  heatPumpKwh: null,
  importedKwh: null,
  exportedKwh: null,
  chargedKwh: null,
  dischargedKwh: null,
}

describe('self-consumption and net grid', () => {
  it('is the produced share that was not exported', () => {
    expect(selfConsumptionPct(10, 2.5)).toBe(75)
  })
  it('is null when the production or the export is unknown, or nothing was produced', () => {
    expect(selfConsumptionPct(null, 1)).toBeNull()
    expect(selfConsumptionPct(10, null)).toBeNull()
    expect(selfConsumptionPct(0, 0)).toBeNull()
  })
  it('clamps an export above the production', () => {
    expect(selfConsumptionPct(5, 7)).toBe(0)
  })
  it('net grid is import minus export, signed, null unless both are known', () => {
    expect(netGridKwh(1.2, 4.1)).toBe(-2.9)
    expect(netGridKwh(6, 0)).toBe(6)
    expect(netGridKwh(null, 1)).toBeNull()
    expect(netGridKwh(1, null)).toBeNull()
  })
})

describe('energyDayWindow', () => {
  it('opens and closes at local midnight', () => {
    const now = new Date(2026, 10, 20, 15, 30).getTime()
    const w = energyDayWindow(now, 0)
    expect(w.from).toBe(new Date(2026, 10, 20).getTime())
    expect(w.to).toBe(new Date(2026, 10, 21).getTime())
  })
  it('steps back whole local days, across a month boundary', () => {
    const now = new Date(2026, 11, 1, 9).getTime()
    const w = energyDayWindow(now, 1)
    expect(w.from).toBe(new Date(2026, 10, 30).getTime())
    expect(w.to).toBe(new Date(2026, 11, 1).getTime())
  })
})

describe('counterDayTotal', () => {
  it('sums the deltas, skipping unknown ones', () => {
    expect(counterDayTotal(counter([null, 1.5, 2, null, 0.5]), 0)).toBe(4)
  })
  it('is null, not 0, when nothing was recorded or no delta is known', () => {
    expect(counterDayTotal(counter([]), 0)).toBeNull()
    expect(counterDayTotal(counter([null, null]), 0)).toBeNull()
    expect(counterDayTotal(undefined, 0)).toBeNull()
  })
  it('keeps a genuine zero', () => {
    expect(counterDayTotal(counter([0, 0]), 0)).toBe(0)
  })
  it('a flat counter (no growth, held value known before the window) is 0, not unknown', () => {
    expect(counterDayTotal(counter([], 1234.5), 0)).toBe(0)
    expect(counterDayTotal(counter([null, null], 8), 0)).toBe(0)
  })
  it('a flat counter last read weeks before the window is a dead sensor: unknown', () => {
    const DAY = 86_400_000
    const from = 40 * DAY
    expect(counterDayTotal(counter([], 8, from - 30 * DAY), from)).toBeNull()
    expect(counterDayTotal(counter([], 8, from - 2 * DAY), from)).toBeNull()
    expect(counterDayTotal(counter([], 8, from - DAY), from)).toBe(0)
    expect(counterDayTotal(counter([], 8, from - 1000), from)).toBe(0)
  })
  it('a read with no series at all stays unknown', () => {
    expect(counterDayTotal({ resolution: '5m', truncated: false, series: [] }, 0)).toBeNull()
  })
})

/** The vendor-app day 2026-11-19 of the live system. */
const DAY_1119: EnergyDayTotals = {
  producedKwh: 9.3,
  heatPumpKwh: 21.9,
  importedKwh: 17.4,
  exportedKwh: 0.1,
  chargedKwh: 3.8,
  dischargedKwh: 3.2,
}

describe('energyTodayOfDay', () => {
  it('the day balance: consumption, household, autarky and sources of 2026-11-19', () => {
    const day = energyTodayOfDay(DAY_1119, true, true)
    expect(day?.houseKwh).toBe(26)
    expect(day?.householdKwh).toBe(4.1)
    expect(day?.selfSufficiencyPct).toBeCloseTo(33.08, 1)
    expect(Math.round(day?.sources?.solarPct ?? -1)).toBe(21)
    expect(Math.round(day?.sources?.batteryPct ?? -1)).toBe(12)
    expect(Math.round(day?.sources?.gridPct ?? -1)).toBe(67)
    expect(day?.netGridKwh).toBe(17.3)
  })
  it('a system with storage whose charge and discharge counters are both unknown has no balance', () => {
    const day = energyTodayOfDay({ ...DAY_1119, chargedKwh: null, dischargedKwh: null }, true, true)
    expect(day?.houseKwh).toBeNull()
    expect(day?.householdKwh).toBeNull()
    expect(day?.selfSufficiencyPct).toBeNull()
    expect(day?.sources).toBeNull()
  })
  it('a system without storage needs no storage counters', () => {
    const day = energyTodayOfDay(
      { ...DAY_1119, chargedKwh: null, dischargedKwh: null },
      true,
      false,
    )
    expect(day?.houseKwh).toBe(26.6)
  })
  it('a flat grid export is 0 and does not empty the balance', () => {
    const day = energyTodayOfDay({ ...DAY_1119, exportedKwh: 0 }, true, true)
    expect(day?.exportedKwh).toBe(0)
    expect(day?.houseKwh).toBe(26.1)
  })
  it('a system without storage counters has the storage contribute nothing', () => {
    const day = energyTodayOfDay(
      { ...EMPTY, producedKwh: 10, importedKwh: 3, exportedKwh: 4 },
      false,
      false,
    )
    expect(day?.houseKwh).toBe(9)
    expect(day?.householdKwh).toBe(9)
  })
  it('one storage counter known without the other is an unknown balance', () => {
    const day = energyTodayOfDay({ ...DAY_1119, dischargedKwh: null }, true, true)
    expect(day?.houseKwh).toBeNull()
    expect(day?.sources).toBeNull()
  })
  it('the household never goes below 0 and needs the heat pump counter when there is one', () => {
    expect(energyTodayOfDay({ ...DAY_1119, heatPumpKwh: 40 }, true, true)?.householdKwh).toBe(0)
    expect(
      energyTodayOfDay({ ...DAY_1119, heatPumpKwh: null }, true, true)?.householdKwh,
    ).toBeNull()
  })
  it('derives the self-consumption and the net grid of a recorded day', () => {
    const day = energyTodayOfDay(
      { ...EMPTY, producedKwh: 20, importedKwh: 2, exportedKwh: 5 },
      false,
      true,
    )
    expect(day?.selfConsumptionPct).toBe(75)
    expect(day?.netGridKwh).toBe(-3)
  })
  it('is null for a day with no reading at all', () => {
    expect(energyTodayOfDay(EMPTY, true, true)).toBeNull()
  })
  it('never reports the live-only facts for a past day', () => {
    const day = energyTodayOfDay({ ...EMPTY, producedKwh: 1 }, false, false)
    expect(day?.socPct).toBeNull()
    expect(day?.autonomyHours).toBeNull()
  })
})

describe('energyFlowSpans', () => {
  const range = { from: 0, to: 1000 }
  const pt = (t: number, v: number | null) => ({ t, v })
  it('merges contiguous stretches of one source and splits on a change', () => {
    const spans = energyFlowSpans([pt(0, 500), pt(100, 800), pt(300, -400), pt(600, 10)], [], range)
    expect(spans).toEqual([
      { source: 'from-grid', from: 0, to: 300 },
      { source: 'to-grid', from: 300, to: 600 },
    ])
  })
  it('reads the storage sign: + charging, − discharging, and lets sources overlap', () => {
    const spans = energyFlowSpans([pt(0, 500)], [pt(0, 1000), pt(500, -1000)], range)
    expect(spans).toContainEqual({ source: 'to-battery', from: 0, to: 500 })
    expect(spans).toContainEqual({ source: 'from-battery', from: 500, to: 1000 })
    expect(spans).toContainEqual({ source: 'from-grid', from: 0, to: 1000 })
  })
  it('draws nothing for an unknown or still node', () => {
    expect(energyFlowSpans([pt(0, null), pt(200, 20)], [], range)).toEqual([])
  })
})
