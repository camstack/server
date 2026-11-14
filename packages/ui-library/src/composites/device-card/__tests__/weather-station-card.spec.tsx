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

  it('draws the reported readings and leaves a missing one off the extra row', () => {
    const [full, sparse] = weatherStationFixtures()
    if (full === undefined || sparse === undefined) throw new Error('fixtures')
    const { unmount } = render(<WeatherStationCard model={full.model} />)
    expect(screen.getByTestId('dc-station-temp').textContent).toContain('18.4')
    expect(screen.getByTestId('dc-station-rain').textContent?.length).toBeGreaterThan(0)
    expect(screen.getByTestId('dc-station-dew')).toBeTruthy()
    unmount()
    render(<WeatherStationCard model={sparse.model} />)
    expect(screen.getByTestId('dc-station-temp').textContent).toContain('9.5')
    expect(screen.queryByTestId('dc-station-rain')).toBeNull()
    expect(screen.queryByTestId('dc-station-dew')).toBeNull()
    expect(screen.getByTestId('dc-station-wind').textContent).toBe('Wind—')
  })
})
