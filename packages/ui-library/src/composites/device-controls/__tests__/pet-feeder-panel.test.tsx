// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { PetFeederStatus } from '@camstack/types'
import { PetFeederInlineControl, PetFeederHeroCard, resolveBowlReading } from '../pet-feeder-panel'
import { UnitPreferencesProvider } from '../../../contexts/unit-preferences'

/** Full default slice; spread overrides on top — no `as` casts in tests. */
function makeSlice(overrides: Partial<PetFeederStatus> = {}): PetFeederStatus {
  return {
    foodLevel: 1,
    bowlFood: 0.12,
    eating: false,
    supportsMarkRefilled: false,
    food1: null,
    food2: null,
    lowFood: false,
    batteryPower: 88,
    powerSource: null,
    desiccantLeftDays: 12 * 86_400,
    feeding: false,
    status: 'normal',
    error: null,
    errorCode: null,
    isDualHopper: false,
    childLock: false,
    indicatorLight: true,
    feedSound: true,
    volume: 3,
    lastFeedGrams: null,
    lastFeedHopper1: null,
    lastFeedHopper2: null,
    lastFetchedAt: 0,
    ...overrides,
  }
}

const feed = vi.fn()
const cancelFeed = vi.fn()
const resetDesiccant = vi.fn()
const markFoodReplenished = vi.fn()
const callPet = vi.fn()
const playSound = vi.fn()
const setChildLock = vi.fn()
const setIndicatorLight = vi.fn()
const setFeedSound = vi.fn()
const setVolume = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never

beforeEach(() => {
  for (const fn of [
    feed,
    cancelFeed,
    resetDesiccant,
    markFoodReplenished,
    callPet,
    playSound,
    setChildLock,
    setIndicatorLight,
    setFeedSound,
    setVolume,
  ])
    fn.mockReset()
  mockResult = {
    cap: {
      feed,
      cancelFeed,
      resetDesiccant,
      markFoodReplenished,
      callPet,
      playSound,
      setChildLock,
      setIndicatorLight,
      setFeedSound,
      setVolume,
    },
    slice: makeSlice(),
    available: true,
  }
})

describe('PetFeederInlineControl', () => {
  it('renders food level, battery and a Feed button', () => {
    render(<PetFeederInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('120 g')).toBeTruthy()
    expect(screen.getByText('88%')).toBeTruthy()
    expect(screen.getByLabelText('Feed now')).toBeTruthy()
  })

  it('wires the Feed button to cap.feed with the default portion', () => {
    render(<PetFeederInlineControl trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Feed now'))
    expect(feed).toHaveBeenCalledWith({ grams: 20 })
  })

  it('renders nothing when the cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<PetFeederInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('disables the Feed button when not available', () => {
    mockResult = { ...mockResult, available: false }
    render(<PetFeederInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect((screen.getByLabelText('Feed now') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('PetFeederHeroCard', () => {
  it('renders the bowl readout, maintenance actions and settings', () => {
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('in bowl')).toBeTruthy()
    expect(screen.getByText('Call pet')).toBeTruthy()
    expect(screen.getByLabelText('Child lock')).toBeTruthy()
    expect(screen.getByLabelText('Feed sound')).toBeTruthy()
  })

  it('draws no desiccant: that is a consumable, shown by the page Consumables section', () => {
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByText('12d desiccant')).toBeNull()
    expect(screen.queryByText('Reset desiccant')).toBeNull()
  })

  it('shows a single Manual feed control on single-hopper models', () => {
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Manual feed')).toBeTruthy()
    expect(screen.queryByText('Hopper 1')).toBeNull()
  })

  it('feeds the clamped portion via cap.feed', () => {
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Feed' }))
    expect(feed).toHaveBeenCalledWith({ grams: 20 })
  })

  it('shows per-hopper feed controls on dual-hopper models', () => {
    mockResult = { ...mockResult, slice: makeSlice({ isDualHopper: true, food1: 90, food2: 110 }) }
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Hopper 1')).toBeTruthy()
    expect(screen.getByText('Hopper 2')).toBeTruthy()
    const [firstFeed] = screen.getAllByRole('button', { name: 'Feed' })
    if (!firstFeed) throw new Error('expected a hopper Feed button')
    fireEvent.click(firstFeed)
    expect(feed).toHaveBeenCalledWith({ hopper1: 20 })
  })

  it('toggles a setting through the matching cap method', () => {
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Child lock'))
    expect(setChildLock).toHaveBeenCalledWith({ on: true })
  })

  it('steps the volume through cap.setVolume', () => {
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Increase volume'))
    expect(setVolume).toHaveBeenCalledWith({ level: 4 })
  })

  it('surfaces a Cancel feed action only while feeding', () => {
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByText('Cancel feed')).toBeNull()
    mockResult = { ...mockResult, slice: makeSlice({ feeding: true }) }
    render(<PetFeederHeroCard trpc={trpc} deviceId={2} features={[]} />)
    fireEvent.click(screen.getByText('Cancel feed'))
    expect(cancelFeed).toHaveBeenCalledWith({})
  })

  it('offers Mark refilled only when the model supports it', () => {
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByText('Mark refilled')).toBeNull()
    mockResult = { ...mockResult, slice: makeSlice({ supportsMarkRefilled: true }) }
    render(<PetFeederHeroCard trpc={trpc} deviceId={2} features={[]} />)
    expect(screen.getByText('Mark refilled')).toBeTruthy()
  })

  it('shows the bowl amount, not the tank level', () => {
    mockResult = { ...mockResult, slice: makeSlice({ foodLevel: 1, bowlFood: 0.037 }) }
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('37')).toBeTruthy()
    expect(screen.getByLabelText('37 g in bowl')).toBeTruthy()
  })

  it('reads ounces under the imperial preference', () => {
    mockResult = { ...mockResult, slice: makeSlice({ bowlFood: 0.1 }) }
    render(
      <UnitPreferencesProvider value={{ system: 'imperial', temperature: 'fahrenheit' }}>
        <PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />
      </UnitPreferencesProvider>,
    )
    expect(screen.getByText('3.5')).toBeTruthy()
    expect(screen.getByLabelText('3.5 oz in bowl')).toBeTruthy()
  })

  it('shows a dash and no unit when the bowl is unknown', () => {
    mockResult = { ...mockResult, slice: makeSlice({ bowlFood: null }) }
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getByLabelText('Food level unknown')).toBeTruthy()
  })

  it('shows the inline bowl with its unit', () => {
    mockResult = { ...mockResult, slice: makeSlice({ bowlFood: 0.022 }) }
    render(<PetFeederInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('22 g')).toBeTruthy()
  })

  it('flags low food in the readout', () => {
    mockResult = { ...mockResult, slice: makeSlice({ lowFood: true, foodLevel: 0 }) }
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Low food')).toBeTruthy()
  })

  it('shows an Offline state and hides Ready when the device is offline', () => {
    mockResult = { ...mockResult, slice: makeSlice({ status: 'offline' }) }
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Offline')).toBeTruthy()
    expect(screen.queryByText('Ready')).toBeNull()
  })

  it('shows an On battery chip when running on battery backup', () => {
    mockResult = { ...mockResult, slice: makeSlice({ status: 'on_batteries' }) }
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('On battery')).toBeTruthy()
  })

  it('on mains shows Mains and the battery as backup, not as an alarm', () => {
    mockResult = {
      ...mockResult,
      slice: makeSlice({ powerSource: 'mains', batteryPower: 4, status: 'normal' }),
    }
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Mains')).toBeTruthy()
    expect(screen.getByText('Backup 4%')).toBeTruthy()
    expect(screen.queryByText('On battery')).toBeNull()
  })

  it('on battery keeps the plain battery readout and On battery', () => {
    mockResult = {
      ...mockResult,
      slice: makeSlice({ powerSource: 'battery', batteryPower: 40, status: 'on_batteries' }),
    }
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('On battery')).toBeTruthy()
    expect(screen.getByText('40%')).toBeTruthy()
    expect(screen.queryByText('Mains')).toBeNull()
  })

  it("with an unknown source shows today's battery readout only", () => {
    mockResult = { ...mockResult, slice: makeSlice({ powerSource: null, batteryPower: 4 }) }
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('4%')).toBeTruthy()
    expect(screen.queryByText('Mains')).toBeNull()
  })

  it('compact layout on mains shows Mains and a backup label', () => {
    mockResult = { ...mockResult, slice: makeSlice({ powerSource: 'mains', batteryPower: 4 }) }
    render(<PetFeederInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Backup 4%')).toBeTruthy()
  })

  it('renders a fault banner with the error message, ignoring the no_error sentinel', () => {
    mockResult = { ...mockResult, slice: makeSlice({ error: 'no_error' }) }
    const { rerender } = render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByText('no_error')).toBeNull()
    mockResult = { ...mockResult, slice: makeSlice({ error: 'Food tank empty' }) }
    rerender(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Food tank empty')).toBeTruthy()
  })
})

/** The manual-feed stepper's grams, read from its own readout. */
function portionGrams(): number {
  const node = document.querySelector('span.w-12')
  return Number(node?.firstChild?.textContent)
}

describe('PetFeederHeroCard manual-feed portion', () => {
  it('starts from the last manual feed the device remembers', () => {
    mockResult.slice = makeSlice({ lastFeedGrams: 45 })
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('45')).toBeTruthy()
    fireEvent.click(screen.getByText('Feed'))
    expect(feed).toHaveBeenCalledWith({ grams: 45 })
  })

  it('steps locally and instantly, and a slice refresh does not move it back', () => {
    mockResult.slice = makeSlice({ lastFeedGrams: 45 })
    const { rerender } = render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Increase Manual feed portion'))
    fireEvent.click(screen.getByLabelText('Increase Manual feed portion'))
    expect(screen.getByText('47')).toBeTruthy()
    // The server slice arrives again with the OLD remembered value.
    mockResult.slice = makeSlice({ lastFeedGrams: 45, lastFetchedAt: 5 })
    rerender(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('47')).toBeTruthy()
    expect(feed).not.toHaveBeenCalled()
  })

  it('keeps stepping while a feed is in progress (only Feed is gated)', () => {
    mockResult.slice = makeSlice({ feeding: true })
    render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    const inc = screen.getByLabelText('Increase Manual feed portion')
    expect((inc as HTMLButtonElement).disabled).toBe(false)
  })

  it('holding the button repeats and speeds up; releasing stops', () => {
    vi.useFakeTimers()
    try {
      render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
      const inc = screen.getByLabelText('Increase Manual feed portion')
      fireEvent.pointerDown(inc, { button: 0 })
      expect(screen.getByText('21')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(350 + 70 * 3)
      })
      expect(screen.getByText('24')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(70 * 10)
      })
      // 5 more single steps (to 29), then 5 g steps.
      expect(portionGrams()).toBeGreaterThan(40)
      fireEvent.pointerUp(inc)
      const before = portionGrams()
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(portionGrams()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('resolveBowlReading', () => {
  it('formats grams under metric and keeps the gauge in grams', () => {
    expect(resolveBowlReading(0.022, 'metric')).toEqual({
      text: '22',
      unit: 'g',
      label: '22 g',
      grams: 22,
    })
    expect(resolveBowlReading(0, 'metric').label).toBe('0 g')
  })

  it('formats ounces under imperial', () => {
    const r = resolveBowlReading(0.1, 'imperial')
    expect(r.label).toBe('3.5 oz')
    expect(r.grams).toBe(100)
  })

  it('is a dash with no unit when null', () => {
    expect(resolveBowlReading(null, 'metric')).toEqual({
      text: '—',
      unit: '',
      label: '—',
      grams: null,
    })
  })
})
