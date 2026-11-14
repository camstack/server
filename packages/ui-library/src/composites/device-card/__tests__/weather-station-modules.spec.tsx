// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { deviceCommon } from '../__fixtures__/wave-d-common'
import { DEVICE_CARD_CSS } from '../card-css'
import { WeatherStationCard } from '../scenes/weather-station/WeatherStationCard'
import {
  anemometerSpinRate,
  stationCategories,
  stationModules,
  type WeatherStationCardModel,
} from '../scenes/weather-station/model'

afterEach(() => {
  cleanup()
})

const BLANK: Omit<WeatherStationCardModel, 'common'> = {
  since: null,
  temperature: null,
  humidity: null,
  pressure: null,
  windSpeed: null,
  windGust: null,
  windBearing: null,
  rainRate: null,
  rainDaily: null,
  rainEvent: null,
  uv: null,
  solarRadiation: null,
  dewPoint: null,
}

function station(patch: Partial<Omit<WeatherStationCardModel, 'common'>>): WeatherStationCardModel {
  return {
    ...BLANK,
    ...patch,
    common: deviceCommon({ name: 'Probe', integration: 'test' }),
  }
}

describe('weather station modules', () => {
  it('draws the anemometer and the vane when only wind is reported', () => {
    expect(stationModules(station({ windSpeed: 4 }))).toEqual(['anemometer', 'vane'])
  })

  it('adds the rain gauge when rain is reported, and nothing else', () => {
    expect(stationModules(station({ windSpeed: 4, rainDaily: 1 }))).toEqual([
      'anemometer',
      'vane',
      'rain',
    ])
  })

  it('a gust alone is still wind, and a rain event alone is still rain', () => {
    expect(stationModules(station({ windGust: 2 }))).toEqual(['anemometer', 'vane'])
    expect(stationModules(station({ rainEvent: 0.4 }))).toEqual(['rain'])
  })

  it('draws the sun module from solar or UV, never from the vendor', () => {
    expect(stationModules(station({ solarRadiation: 100 }))).toEqual(['sun'])
    expect(stationModules(station({ uv: 3 }))).toEqual(['sun'])
    expect(stationModules(station({ temperature: 12 }))).not.toContain('sun')
    expect(stationModules(station({ temperature: 12 }))).not.toContain('anemometer')
  })

  it('spin rate rises with wind speed and is still at zero or when unknown', () => {
    expect(anemometerSpinRate(null)).toBe(0)
    expect(anemometerSpinRate(0)).toBe(0)
    expect(anemometerSpinRate(-2)).toBe(0)
    const rates = [0.4, 1, 3, 8, 16].map((speed) => anemometerSpinRate(speed))
    for (let i = 1; i < rates.length; i += 1) {
      const slower = rates[i - 1]
      const faster = rates[i]
      if (slower === undefined || faster === undefined) throw new Error('rates')
      expect(faster).toBeGreaterThan(slower)
    }
  })
})

describe('weather station categories', () => {
  it('omits a category whose readings are all absent', () => {
    const ids = stationCategories(station({ temperature: 10, windSpeed: 2 })).map((cat) => cat.id)
    expect(ids).toEqual(['climate', 'wind'])
    expect(ids).not.toContain('rain')
    expect(ids).not.toContain('sun')
    expect(ids).not.toContain('pressure')
  })

  it('keeps a null reading inside a category that has another value', () => {
    const wind = stationCategories(station({ windSpeed: 3 })).find((cat) => cat.id === 'wind')
    expect(wind?.readings.map((reading) => reading.id)).toEqual(['speed', 'gust', 'bearing'])
    expect(wind?.readings.find((reading) => reading.id === 'gust')?.value).toBeNull()
  })

  it('draws no category when the station reports nothing', () => {
    expect(stationCategories(station({}))).toEqual([])
  })
})

describe('weather station drawing', () => {
  it('mounts two modules for wind and three once rain is reported', () => {
    const { unmount } = render(
      <WeatherStationCard model={station({ windSpeed: 4, windBearing: 90 })} />,
    )
    expect(screen.getByTestId('dc-station-drawing').getAttribute('data-modules')).toBe(
      'anemometer vane',
    )
    expect(screen.getByTestId('dc-station-module-anemometer')).toBeTruthy()
    expect(screen.getByTestId('dc-station-module-vane')).toBeTruthy()
    expect(screen.queryByTestId('dc-station-module-rain')).toBeNull()
    expect(screen.queryByTestId('dc-station-cat-rain')).toBeNull()
    expect(screen.getByTestId('dc-station-cat-wind')).toBeTruthy()
    expect(screen.getByTestId('dc-station-bearing').textContent).toContain('E')
    unmount()

    render(<WeatherStationCard model={station({ windSpeed: 4, rainRate: 1.2, windGust: null })} />)
    expect(screen.getByTestId('dc-station-drawing').getAttribute('data-modules')).toBe(
      'anemometer vane rain',
    )
    expect(screen.getByTestId('dc-station-module-rain')).toBeTruthy()
    expect(screen.getByTestId('dc-station-gust').textContent).toContain('—')
  })

  it('spins only while the wind is moving, faster as it rises', () => {
    const { unmount } = render(
      <WeatherStationCard model={station({ windSpeed: null, windGust: 5 })} />,
    )
    expect(screen.getByTestId('dc-station-drawing').getAttribute('data-spin')).toBe('false')
    unmount()

    const calm = render(<WeatherStationCard model={station({ windSpeed: 0 })} />)
    expect(calm.getByTestId('dc-station-drawing').getAttribute('data-spin')).toBe('false')
    calm.unmount()

    const slow = render(<WeatherStationCard model={station({ windSpeed: 1 })} />)
    const slowRate = Number(slow.getByTestId('dc-station-drawing').getAttribute('data-rate'))
    slow.unmount()
    const fast = render(<WeatherStationCard model={station({ windSpeed: 10 })} />)
    const fastRate = Number(fast.getByTestId('dc-station-drawing').getAttribute('data-rate'))
    expect(slowRate).toBeGreaterThan(0)
    expect(fastRate).toBeGreaterThan(slowRate)
  })

  it('stops the cups under reduced motion and still points the vane with a transform', () => {
    const reduced = DEVICE_CARD_CSS.slice(DEVICE_CARD_CSS.lastIndexOf('prefers-reduced-motion'))
    expect(DEVICE_CARD_CSS).toContain('.dc-station[data-spin="true"] .dc-station-cups')
    expect(DEVICE_CARD_CSS).toContain('transform:rotate(var(--dc-station-bearing')
    expect(reduced).toContain('.dc-station')
    expect(reduced).toContain('.dc-station-vane{transition:none}')
  })
})
