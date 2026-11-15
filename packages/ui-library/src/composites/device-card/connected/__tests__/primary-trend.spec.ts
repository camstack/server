import type { DeviceHistoryQueryManyEntry } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { readItemId } from '../../../device-history/use-device-history'
import { pickPrimaryTrend, primaryTrendKeys } from '../primary-trend'

const DEVICE = 7

function line(values: readonly number[]): DeviceHistoryQueryManyEntry {
  return {
    ok: true,
    result: {
      resolution: 'raw',
      truncated: false,
      series: [
        {
          scope: '',
          before: null,
          derivedFrom: null,
          points: values.map((v, i) => ({
            t: i * 60_000,
            samples: 1,
            mean: v,
            twMean: null,
            min: v,
            max: v,
            last: v,
            delta: null,
            state: null,
            states: null,
          })),
        },
      ],
    },
  }
}

function reads(byKey: Record<string, DeviceHistoryQueryManyEntry>) {
  return new Map(
    Object.entries(byKey).map(([key, entry]) => [readItemId({ deviceId: DEVICE, key }), entry]),
  )
}

describe('the primary trend of a device card', () => {
  it('reads only the declared primary of each enabled cap', () => {
    expect(primaryTrendKeys(['energy-system', 'contact', 'weather-station'])).toEqual([
      'cap:energy-system.house.powerW',
      'cap:weather-station.temperature',
    ])
  })

  it('an energy system, a weather station and a climate each trend their own primary', () => {
    for (const [cap, key] of [
      ['energy-system', 'cap:energy-system.house.powerW'],
      ['weather-station', 'cap:weather-station.temperature'],
      ['climate-control', 'cap:climate-control.currentTemp'],
    ] as const) {
      const trend = pickPrimaryTrend({
        deviceId: DEVICE,
        enabledCaps: [cap],
        reads: reads({ [key]: line([1, 2, 3]) }),
      })
      expect(trend?.key).toBe(key)
    }
  })

  it('falls back to the next cap when the higher-priority one has no line', () => {
    const trend = pickPrimaryTrend({
      deviceId: DEVICE,
      enabledCaps: ['temperature-sensor', 'weather-station'],
      reads: reads({
        'cap:temperature-sensor.temperature': line([4]),
        'cap:weather-station.temperature': line([4, 5]),
      }),
    })
    expect(trend?.key).toBe('cap:weather-station.temperature')
  })

  it('a cap that is not enabled is never trended, and nothing answered is no trend', () => {
    const only = reads({ 'cap:temperature-sensor.temperature': line([1, 2, 3]) })
    expect(
      pickPrimaryTrend({ deviceId: DEVICE, enabledCaps: ['weather-station'], reads: only }),
    ).toBeNull()
    expect(pickPrimaryTrend({ deviceId: DEVICE, enabledCaps: ['contact'], reads: only })).toBeNull()
  })

  it('carries the declared quantity so the tooltip converts like the value', () => {
    const trend = pickPrimaryTrend({
      deviceId: DEVICE,
      enabledCaps: ['weather-station'],
      reads: reads({ 'cap:weather-station.temperature': line([1, 2]) }),
    })
    expect(trend?.quantity).toBe('temperature')
  })
})
