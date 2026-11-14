// @vitest-environment jsdom
import { DeviceType } from '@camstack/types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { weatherStationFixtures } from '../__fixtures__/weather-station'
import { capCardKindOf } from '../connected/cap-card-kinds'
import { WeatherStationCard } from '../scenes/weather-station/WeatherStationCard'

afterEach(() => {
  cleanup()
})

describe('weather station card', () => {
  it('a weather-station device with the cap draws the station card', () => {
    expect(capCardKindOf(DeviceType.WeatherStation, null, ['weather-station'])).toBe(
      'weather-station',
    )
  })

  it('groups the readings and dashes a gap inside a drawn category', () => {
    const [full, sparse] = weatherStationFixtures()
    if (full === undefined || sparse === undefined) throw new Error('fixtures')
    const { unmount } = render(<WeatherStationCard model={full.model} />)
    expect(screen.getByTestId('dc-station-temp').textContent).toContain('18.4')
    expect(screen.getByTestId('dc-station-rain').textContent?.length).toBeGreaterThan(0)
    expect(screen.getByTestId('dc-station-dew')).toBeTruthy()
    expect(screen.getByTestId('dc-station-drawing').getAttribute('data-modules')).toContain('rain')
    unmount()
    render(<WeatherStationCard model={sparse.model} />)
    expect(screen.getByTestId('dc-station-temp').textContent).toContain('9.5')
    expect(screen.queryByTestId('dc-station-cat-rain')).toBeNull()
    expect(screen.queryByTestId('dc-station-cat-wind')).toBeNull()
    expect(screen.getByTestId('dc-station-dew').textContent).toContain('—')
    expect(screen.getByTestId('dc-station-humidity').textContent).toContain('—')
  })
})
