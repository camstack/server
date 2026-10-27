// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { PetFeederStatus } from '@camstack/types'
import { PetFeederInlineControl, PetFeederHeroCard } from '../pet-feeder-panel'

/** Full default slice; spread overrides on top — no `as` casts in tests. */
function makeSlice(overrides: Partial<PetFeederStatus> = {}): PetFeederStatus {
  return {
    foodLevel: 120,
    food1: null,
    food2: null,
    lowFood: false,
    batteryPower: 88,
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
    expect(screen.getByText('120')).toBeTruthy()
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
    expect(screen.getByText('g in bowl')).toBeTruthy()
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

  it('renders a fault banner with the error message, ignoring the no_error sentinel', () => {
    mockResult = { ...mockResult, slice: makeSlice({ error: 'no_error' }) }
    const { rerender } = render(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByText('no_error')).toBeNull()
    mockResult = { ...mockResult, slice: makeSlice({ error: 'Food tank empty' }) }
    rerender(<PetFeederHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Food tank empty')).toBeTruthy()
  })
})
