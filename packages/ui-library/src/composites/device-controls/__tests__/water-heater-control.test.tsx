// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  WaterHeaterInlineControl,
  WaterHeaterHeroCard,
  waterHeaterTint,
  waterHeaterPhase,
} from '../water-heater-control'

const setTargetTemp = vi.fn()
const setOperationMode = vi.fn()
const setAway = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

vi.mock('../../../hooks/use-optimistic-slice', () => ({
  useOptimisticSlice: (slice: unknown) => ({ display: slice, applyOptimistic: vi.fn() }),
}))

const trpc = {} as never

const fullSlice = {
  currentTemp: 48,
  targetTemp: 60,
  operationMode: 'eco',
  availableModes: ['eco', 'electric', 'gas', 'heat_pump'],
  away: false,
  minTemp: 30,
  maxTemp: 80,
  lastChangedAt: 0,
}

beforeEach(() => {
  setTargetTemp.mockReset()
  setOperationMode.mockReset()
  setAway.mockReset()
  mockResult = {
    cap: { setTargetTemp, setOperationMode, setAway },
    slice: fullSlice,
    available: true,
  }
})

describe('waterHeaterPhase', () => {
  it('off when operation mode is off or null', () => {
    expect(waterHeaterPhase('off', 40, 60)).toBe('off')
    expect(waterHeaterPhase(null, 40, 60)).toBe('off')
  })

  it('heating when current < target', () => {
    expect(waterHeaterPhase('eco', 40, 60)).toBe('heating')
  })

  it('idle when current >= target', () => {
    expect(waterHeaterPhase('eco', 60, 60)).toBe('idle')
    expect(waterHeaterPhase('eco', 65, 60)).toBe('idle')
  })

  it('idle when current temp is null (cannot confirm heating)', () => {
    expect(waterHeaterPhase('eco', null, 60)).toBe('idle')
  })
})

describe('waterHeaterTint', () => {
  it('returns a tint for every phase (exhaustive)', () => {
    for (const p of ['heating', 'idle', 'off'] as const) {
      const tint = waterHeaterTint(p)
      expect(typeof tint.glow).toBe('string')
      expect(typeof tint.accent).toBe('string')
      expect(typeof tint.heating).toBe('boolean')
    }
  })

  it('glows the heating element only when heating', () => {
    expect(waterHeaterTint('heating').heating).toBe(true)
    expect(waterHeaterTint('idle').heating).toBe(false)
    expect(waterHeaterTint('off').heating).toBe(false)
  })
})

describe('WaterHeaterInlineControl', () => {
  it('renders the current→target readout + mode hint', () => {
    render(<WaterHeaterInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText(/60°/)).toBeTruthy()
    expect(screen.getByText(/eco/)).toBeTruthy()
  })

  it('renders nothing when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <WaterHeaterInlineControl trpc={trpc} deviceId={1} features={[]} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('WaterHeaterHeroCard', () => {
  it('renders current temp + stepper + operation-mode select + away toggle', () => {
    render(<WaterHeaterHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('48')).toBeTruthy()
    expect(screen.getByLabelText('Increment')).toBeTruthy()
    expect(screen.getByLabelText('Operation mode')).toBeTruthy()
    expect(screen.getByLabelText('Enable away mode')).toBeTruthy()
  })

  it('steps the target temp clamped to bounds', () => {
    render(<WaterHeaterHeroCard trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Increment'))
    expect(setTargetTemp).toHaveBeenCalledWith({ temp: 61 })
  })

  it('clamps the target temp to maxTemp on increment', () => {
    mockResult = { ...mockResult, slice: { ...fullSlice, targetTemp: 80, maxTemp: 80 } }
    render(<WaterHeaterHeroCard trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Increment'))
    expect(setTargetTemp).toHaveBeenCalledWith({ temp: 80 })
  })

  it('calls setOperationMode on select change', () => {
    render(<WaterHeaterHeroCard trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.change(screen.getByLabelText('Operation mode'), { target: { value: 'gas' } })
    expect(setOperationMode).toHaveBeenCalledWith({ mode: 'gas' })
  })

  it('toggles away mode', () => {
    render(<WaterHeaterHeroCard trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Enable away mode'))
    expect(setAway).toHaveBeenCalledWith({ on: true })
  })

  it('hides the away toggle when away is null (unsupported)', () => {
    mockResult = { ...mockResult, slice: { ...fullSlice, away: null } }
    render(<WaterHeaterHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByLabelText('Enable away mode')).toBeNull()
    expect(screen.queryByLabelText('Disable away mode')).toBeNull()
  })

  it('renders nothing when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<WaterHeaterHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
