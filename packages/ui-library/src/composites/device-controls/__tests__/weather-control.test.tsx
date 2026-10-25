// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  WeatherInlineControl,
  WeatherHeroCard,
  weatherTint,
  weatherConditionMeta,
} from '../weather-control'

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never

const FULL_SLICE = {
  condition: 'partlycloudy',
  temperature: 21.4,
  temperatureUnit: '°C',
  humidity: 63,
  pressure: 1013,
  pressureUnit: 'hPa',
  windSpeed: 12.5,
  windSpeedUnit: 'km/h',
  windBearing: 240,
  lastFetchedAt: 0,
}

beforeEach(() => {
  mockResult = { cap: { getStatus: vi.fn() }, slice: FULL_SLICE, available: true }
})

const KNOWN_CONDITIONS = [
  'sunny',
  'clear-night',
  'partlycloudy',
  'cloudy',
  'rainy',
  'pouring',
  'snowy',
  'snowy-rainy',
  'lightning',
  'lightning-rainy',
  'fog',
  'windy',
  'windy-variant',
  'hail',
  'exceptional',
] as const

describe('weatherConditionMeta', () => {
  it('maps every known condition to a label + glyph (exhaustive-ish)', () => {
    for (const c of KNOWN_CONDITIONS) {
      const meta = weatherConditionMeta(c)
      expect(typeof meta.label).toBe('string')
      expect(meta.label.length).toBeGreaterThan(0)
      expect(typeof meta.glyph).toBe('string')
    }
  })

  it('falls back to a neutral cloud for null / unknown', () => {
    expect(weatherConditionMeta(null).glyph).toBe('cloudy')
    expect(weatherConditionMeta('martian-dust-storm').glyph).toBe('cloudy')
    expect(weatherConditionMeta('martian-dust-storm').label).toBe('martian-dust-storm')
  })
})

describe('weatherTint', () => {
  it('returns a tint for every known condition + the default', () => {
    for (const c of [...KNOWN_CONDITIONS, null, 'unknown'] as const) {
      const tint = weatherTint(c)
      expect(typeof tint.glow).toBe('string')
      expect(typeof tint.accent).toBe('string')
    }
  })
})

describe('WeatherInlineControl', () => {
  it('renders the temperature readout', () => {
    render(<WeatherInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('21°C')).toBeTruthy()
  })

  it('renders the condition icon with an accessible label', () => {
    render(<WeatherInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByLabelText('Partly cloudy')).toBeTruthy()
  })

  it('renders a dash when temperature is null', () => {
    mockResult = { ...mockResult, slice: { ...FULL_SLICE, temperature: null } }
    render(<WeatherInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('renders nothing when the slice has not landed', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<WeatherInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('WeatherHeroCard', () => {
  it('renders the temperature, condition label, and the readouts', () => {
    render(<WeatherHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('21')).toBeTruthy()
    expect(screen.getByText('Partly cloudy')).toBeTruthy()
    expect(screen.getByText('63%')).toBeTruthy() // humidity
    expect(screen.getByText('13 km/h')).toBeTruthy() // wind speed rounded + unit
    expect(screen.getByText('1013 hPa')).toBeTruthy() // pressure + unit
  })

  it('omits the unit suffix when the unit is null (no trailing space)', () => {
    mockResult = {
      ...mockResult,
      slice: { ...FULL_SLICE, windSpeedUnit: null, pressureUnit: null },
    }
    render(<WeatherHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('13')).toBeTruthy() // wind speed, no unit
    expect(screen.getByText('1013')).toBeTruthy() // pressure, no unit
  })

  it('renders the bespoke sky scene with the condition glyph', () => {
    render(<WeatherHeroCard trpc={trpc} deviceId={1} features={[]} />)
    const scene = screen.getByTestId('weather-scene')
    expect(scene.getAttribute('aria-hidden')).toBe('true')
    expect(scene.querySelector('[data-glyph="partly-cloudy"]')).toBeTruthy()
  })

  it('omits a readout whose value is null', () => {
    mockResult = {
      ...mockResult,
      slice: { ...FULL_SLICE, humidity: null, pressure: null, windSpeed: null },
    }
    render(<WeatherHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByText('63%')).toBeNull()
    expect(screen.queryByText('1013 hPa')).toBeNull()
  })

  it('renders nothing when the slice has not landed', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<WeatherHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
