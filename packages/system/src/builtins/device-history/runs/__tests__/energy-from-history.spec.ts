import { DEVICE_HISTORY_ENERGY_KEY, type DeviceHistoryQueryPoint } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { energyKwhFromHistory, type EnergyHistoryQuery } from '../energy-from-history.js'

const T0 = Date.UTC(2026, 9, 14, 10, 0, 0)
const MIN = 60_000

function point(t: number, delta: number | null): DeviceHistoryQueryPoint {
  return {
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
  }
}

function queryOf(
  points: readonly DeviceHistoryQueryPoint[],
  truncated = false,
): EnergyHistoryQuery {
  return async () => ({
    resolution: '5m',
    truncated,
    series: [{ scope: '', before: null, points, derivedFrom: 'power-meter.energy' }],
  })
}

describe('energyKwhFromHistory', () => {
  it('sums the per-bucket kWh inside the window and asks the derived energy key', async () => {
    let asked = ''
    const query: EnergyHistoryQuery = async (input) => {
      asked = input.key
      return queryOf([
        point(T0 - 60 * MIN, 5),
        point(T0, 0.1),
        point(T0 + 5 * MIN, 0.2),
        point(T0 + 10 * MIN, null),
        point(T0 + 15 * MIN, 0.3),
        point(T0 + 90 * MIN, 7),
      ])(input)
    }
    expect(await energyKwhFromHistory(query, 4, T0, T0 + 20 * MIN)).toBeCloseTo(0.6, 9)
    expect(asked).toBe(DEVICE_HISTORY_ENERGY_KEY)
  })

  it('is null for a window shorter than ten minutes, and for no points, a truncated answer or only unknown buckets', async () => {
    expect(await energyKwhFromHistory(queryOf([point(T0, 1)]), 4, T0, T0 + 5 * MIN)).toBeNull()
    expect(await energyKwhFromHistory(queryOf([]), 4, T0, T0 + 30 * MIN)).toBeNull()
    expect(
      await energyKwhFromHistory(queryOf([point(T0, 1)], true), 4, T0, T0 + 30 * MIN),
    ).toBeNull()
    expect(await energyKwhFromHistory(queryOf([point(T0, null)]), 4, T0, T0 + 30 * MIN)).toBeNull()
  })
})
