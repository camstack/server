import type { DeviceHistoryQueryResult } from '@camstack/types'
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

function counter(deltas: readonly (number | null)[]): DeviceHistoryQueryResult {
  return {
    resolution: '5m',
    truncated: false,
    series: [
      {
        scope: '',
        before: null,
        derivedFrom: null,
        points: deltas.map((d, i) => point(i * 300_000, d)),
      },
    ],
  }
}

const EMPTY: EnergyDayTotals = {
  producedKwh: null,
  houseKwh: null,
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
    expect(counterDayTotal(counter([null, 1.5, 2, null, 0.5]))).toBe(4)
  })
  it('is null, not 0, when nothing was recorded or no delta is known', () => {
    expect(counterDayTotal(counter([]))).toBeNull()
    expect(counterDayTotal(counter([null, null]))).toBeNull()
    expect(counterDayTotal(undefined)).toBeNull()
  })
  it('keeps a genuine zero', () => {
    expect(counterDayTotal(counter([0, 0]))).toBe(0)
  })
})

describe('energyTodayOfDay', () => {
  it('derives the shares and the net grid of a recorded day', () => {
    const day = energyTodayOfDay(
      { ...EMPTY, producedKwh: 20, houseKwh: 8, heatPumpKwh: 2, importedKwh: 2, exportedKwh: 5 },
      true,
    )
    expect(day?.houseKwh).toBe(10)
    expect(day?.selfConsumptionPct).toBe(75)
    expect(day?.selfSufficiencyPct).toBe(80)
    expect(day?.netGridKwh).toBe(-3)
  })
  it('falls back to produced + imported − exported when the house counters are missing', () => {
    const day = energyTodayOfDay(
      { ...EMPTY, producedKwh: 10, importedKwh: 3, exportedKwh: 4 },
      false,
    )
    expect(day?.houseKwh).toBe(9)
  })
  it('needs the heat pump counter when the system has one', () => {
    const day = energyTodayOfDay({ ...EMPTY, houseKwh: 8, importedKwh: 2 }, true)
    expect(day?.houseKwh).toBeNull()
    expect(day?.selfSufficiencyPct).toBeNull()
  })
  it('is null for a day with no reading at all', () => {
    expect(energyTodayOfDay(EMPTY, true)).toBeNull()
  })
  it('never reports the live-only facts for a past day', () => {
    const day = energyTodayOfDay({ ...EMPTY, producedKwh: 1 }, false)
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
