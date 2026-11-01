// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PetFountainHeroCard } from '../pet-fountain-panel'

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const props = { trpc: {} as never, deviceId: 1, features: undefined }

function fountain(pumpRunning: boolean | null) {
  return {
    waterLevel: 64,
    waterVolume: 1.3,
    empty: false,
    pumpRunning,
    pumpIntervalEnabled: false,
    pumpOnTime: null,
    pumpOffTime: null,
    lastDrink: null,
    currentHourDrink: null,
    last24hDrink: null,
    todayDrink: null,
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
    render(<PetFountainHeroCard {...props} />)
    expect(screen.queryByTestId('fountain-ripple') !== null).toBe(animates)
  })
})
