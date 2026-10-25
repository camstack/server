// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  AcPanel,
  climateOffersCooling,
  climateSetpointBounds,
  climateTargetFromFraction,
} from '../ac-panel'
import type { HvacMode } from '@camstack/types'

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never

let mockResult: { cap: unknown; slice: unknown; available: boolean }

const cap = {
  setMode: vi.fn(),
  setTarget: vi.fn(),
  setFanMode: vi.fn(),
  setPreset: vi.fn(),
  setTargetHumidity: vi.fn(),
  setTargetRange: vi.fn(),
  setSwingVertical: vi.fn(),
  setSwingHorizontal: vi.fn(),
}

function slice(overrides: Record<string, unknown>) {
  return {
    mode: 'heat' as const,
    availableModes: ['off', 'heat', 'auto'] as const,
    fanMode: '',
    availableFanModes: [] as string[],
    preset: '',
    availablePresets: [] as string[],
    target: 5,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: 21,
    currentHumidity: null,
    swingVertical: null,
    swingHorizontal: null,
    minTemp: null,
    maxTemp: null,
    tempStep: 0.5,
    lastFetchedAt: 0,
    ...overrides,
  }
}

describe('climate presentation', () => {
  it('treats heat/off/auto as a heater and cool as an air conditioner', () => {
    expect(climateOffersCooling(['off', 'heat', 'auto'] as HvacMode[])).toBe(false)
    expect(climateOffersCooling(['off', 'heat', 'cool'] as HvacMode[])).toBe(true)
  })

  it('hides setpoint bounds unless both ends are numbers', () => {
    expect(climateSetpointBounds({ minTemp: null, maxTemp: 30 })).toBeNull()
    expect(climateSetpointBounds({ minTemp: 5, maxTemp: 30 })).toEqual({ min: 5, max: 30 })
  })

  it('rises heat streaks and hides the track when the integration omits bounds', () => {
    mockResult = { cap, slice: slice({}), available: true }
    render(<AcPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
    expect(screen.getByTestId('climate-heat-rise')).toBeTruthy()
    expect(screen.queryByTestId('climate-radiator')).toBeNull()
    expect(screen.queryByText('16°')).toBeNull()
    expect(screen.queryByText('30°')).toBeNull()
  })

  it('shows still radiator fins when a heater is off', () => {
    mockResult = { cap, slice: slice({ mode: 'off' }), available: true }
    render(<AcPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
    expect(screen.getByTestId('climate-radiator')).toBeTruthy()
    expect(screen.queryByTestId('climate-heat-rise')).toBeNull()
  })

  it('keeps rising streaks when a heater is on auto', () => {
    mockResult = { cap, slice: slice({ mode: 'auto' }), available: true }
    render(<AcPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
    expect(screen.getByTestId('climate-heat-rise')).toBeTruthy()
  })

  it('snaps a drag fraction to the setpoint step inside the bounds', () => {
    expect(climateTargetFromFraction(0, { min: 5, max: 30 }, 0.5)).toBe(5)
    expect(climateTargetFromFraction(1, { min: 5, max: 30 }, 0.5)).toBe(30)
    expect(climateTargetFromFraction(0.5, { min: 5, max: 30 }, 0.5)).toBe(17.5)
  })

  it('writes the setpoint when the track is released', () => {
    cap.setTarget.mockClear()
    mockResult = {
      cap,
      slice: slice({ minTemp: 5, maxTemp: 30, target: 5, tempStep: 0.5 }),
      available: true,
    }
    render(<AcPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
    const slider = screen.getByRole('slider', { name: 'Setpoint' })
    slider.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 24,
      right: 200,
      bottom: 24,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(slider, { pointerId: 1, clientX: 200 })
    expect(cap.setTarget).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider, { pointerId: 1, clientX: 200 })
    expect(cap.setTarget).toHaveBeenCalledWith({ target: 30 })
  })

  it('shows the integration bounds on an air conditioner', () => {
    mockResult = {
      cap,
      slice: slice({
        availableModes: ['off', 'cool', 'heat'],
        minTemp: 16,
        maxTemp: 30,
        target: 22,
      }),
      available: true,
    }
    render(<AcPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
    expect(screen.queryByTestId('climate-heater')).toBeNull()
    expect(screen.getByText('16°')).toBeTruthy()
    expect(screen.getByText('30°')).toBeTruthy()
  })
})
