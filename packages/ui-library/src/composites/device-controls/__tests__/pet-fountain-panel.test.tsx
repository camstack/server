// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PetFountainHeroCard } from '../pet-fountain-panel'

interface MockResult {
  readonly cap: unknown
  readonly slice: unknown
  readonly available: boolean
}

const NONE: MockResult = { cap: undefined, slice: undefined, available: false }
let mockResult: MockResult
let mockCycle: MockResult

// The panel asks for two caps through accessors; the accessor's own text says which one.
vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: (opts: { readonly cap: unknown }) =>
    String(opts.cap).includes('pumpCycle') ? mockCycle : mockResult,
}))

const props = { trpc: {} as never, deviceId: 1, features: undefined }

function fountain(pumpRunning: boolean | null) {
  return {
    waterLevel: 64,
    waterVolume: 1.3,
    empty: false,
    pumpRunning,
    error: null,
    lastFetchedAt: 1,
  }
}

describe('pet fountain ripple', () => {
  it.each([
    [true, true],
    [false, false],
    [null, false],
  ])('pumpRunning=%s animates=%s', (pumpRunning, animates) => {
    mockResult = {
      cap: { setPump: vi.fn() },
      slice: fountain(pumpRunning),
      available: true,
    }
    mockCycle = NONE
    render(<PetFountainHeroCard {...props} />)
    expect(screen.queryByTestId('fountain-ripple') !== null).toBe(animates)
  })
})

describe('pet fountain pump cycle section', () => {
  const FOUNTAIN: MockResult = {
    cap: { setPump: vi.fn() },
    slice: fountain(true),
    available: true,
  }
  const cycle = (enabled: boolean | null): MockResult => ({
    cap: { setEnabled: vi.fn(), setOnMinutes: vi.fn(), setOffMinutes: vi.fn() },
    slice: { enabled, onTime: 600, offTime: 1200, lastFetchedAt: 1 },
    available: true,
  })

  it('draws no cycle section on a fountain that does not compose pump-cycle', () => {
    mockResult = FOUNTAIN
    mockCycle = NONE
    render(<PetFountainHeroCard {...props} />)
    expect(screen.queryByText('On / off cycle')).toBeNull()
    expect(screen.queryByText('Runs for')).toBeNull()
  })

  it('draws the cycle switch from the pump-cycle slice, and the minutes while it is on', () => {
    mockResult = FOUNTAIN
    mockCycle = cycle(false)
    const { unmount } = render(<PetFountainHeroCard {...props} />)
    expect(screen.queryByText('On / off cycle')).not.toBeNull()
    expect(screen.queryByText('Runs for')).toBeNull()
    unmount()
    mockCycle = cycle(true)
    render(<PetFountainHeroCard {...props} />)
    expect(screen.queryByText('Runs for')).not.toBeNull()
    expect(screen.queryByText('Rests for')).not.toBeNull()
  })
})
