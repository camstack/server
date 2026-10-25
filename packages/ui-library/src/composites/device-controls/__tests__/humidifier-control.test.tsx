// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HumidifierInlineControl, HumidifierHeroCard, humidifierTint } from '../humidifier-control'

const setOn = vi.fn()
const setTargetHumidity = vi.fn()
const setMode = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

vi.mock('../../../hooks/use-optimistic-slice', () => ({
  useOptimisticSlice: (slice: unknown) => ({ display: slice, applyOptimistic: vi.fn() }),
}))

const trpc = {} as never

const fullSlice = {
  on: true,
  currentHumidity: 40,
  targetHumidity: 55,
  mode: 'auto',
  availableModes: ['auto', 'normal', 'baby'],
  action: 'humidifying',
  minHumidity: 30,
  maxHumidity: 80,
  lastChangedAt: 0,
}

beforeEach(() => {
  setOn.mockReset()
  setTargetHumidity.mockReset()
  setMode.mockReset()
  mockResult = {
    cap: { setOn, setTargetHumidity, setMode },
    slice: fullSlice,
    available: true,
  }
})

describe('humidifierTint', () => {
  it('returns a tint for every action (exhaustive-ish)', () => {
    for (const a of ['humidifying', 'drying', 'idle', 'off', null] as const) {
      const tint = humidifierTint(true, a)
      expect(typeof tint.glow).toBe('string')
      expect(typeof tint.accent).toBe('string')
      expect(typeof tint.misting).toBe('boolean')
    }
  })

  it('mists when humidifying, not when drying/idle/off', () => {
    expect(humidifierTint(true, 'humidifying').misting).toBe(true)
    expect(humidifierTint(true, 'drying').misting).toBe(false)
    expect(humidifierTint(true, 'idle').misting).toBe(false)
    expect(humidifierTint(false, 'off').misting).toBe(false)
  })

  it('falls back to on/off when action is null', () => {
    expect(humidifierTint(true, null).misting).toBe(true)
    expect(humidifierTint(false, null).misting).toBe(false)
  })
})

describe('HumidifierInlineControl', () => {
  it('renders the on/off toggle + current→target readout', () => {
    render(<HumidifierInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByLabelText('Turn off')).toBeTruthy()
    expect(screen.getByText(/55%/)).toBeTruthy()
  })

  it('toggles off when currently on', () => {
    render(<HumidifierInlineControl trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Turn off'))
    expect(setOn).toHaveBeenCalledWith({ on: false })
  })

  it('renders nothing when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<HumidifierInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('HumidifierHeroCard', () => {
  it('renders target readout + on/off toggle + slider + mode select', () => {
    render(<HumidifierHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('55')).toBeTruthy()
    expect(screen.getByLabelText('Turn off')).toBeTruthy()
    expect(screen.getByLabelText('Target humidity')).toBeTruthy()
    expect(screen.getByLabelText('Mode')).toBeTruthy()
  })

  it('uses min/max humidity bounds for the slider', () => {
    render(<HumidifierHeroCard trpc={trpc} deviceId={1} features={[]} />)
    const range = screen.getByLabelText('Target humidity') as HTMLInputElement
    expect(range.min).toBe('30')
    expect(range.max).toBe('80')
  })

  it('calls setTargetHumidity on slider change', () => {
    render(<HumidifierHeroCard trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.change(screen.getByLabelText('Target humidity'), { target: { value: '70' } })
    expect(setTargetHumidity).toHaveBeenCalledWith({ humidity: 70 })
  })

  it('calls setMode on select change', () => {
    render(<HumidifierHeroCard trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'baby' } })
    expect(setMode).toHaveBeenCalledWith({ mode: 'baby' })
  })

  it('hides the mode select when no modes are available', () => {
    mockResult = { ...mockResult, slice: { ...fullSlice, availableModes: [] } }
    render(<HumidifierHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByLabelText('Mode')).toBeNull()
  })

  it('renders nothing when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<HumidifierHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
