// @vitest-environment jsdom
/**
 * The device-list energy row draws each reading as its own pill, the same
 * ValueChip the energy card uses, with the number and its unit.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

import { EnergySystemInlineControl } from '../energy-system-control'

const trpc = {} as never

describe('EnergySystemInlineControl', () => {
  beforeEach(() => {
    mockResult = {
      cap: {},
      slice: {
        solar: { powerW: 4200 },
        storage: { stateOfChargePct: 74.2 },
      },
      available: true,
    }
  })

  it('renders Solar and Storage as separate chips with their units', () => {
    render(<EnergySystemInlineControl trpc={trpc} deviceId={5766} features={undefined} />)
    const chips = screen.getAllByTestId('energy-value-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0]?.textContent).toBe('Solar 4.2 kW')
    expect(chips[1]?.textContent).toBe('Storage 74%')
  })

  it('omits a part the system does not report', () => {
    mockResult = {
      cap: {},
      slice: { solar: { powerW: 800 }, storage: null },
      available: true,
    }
    render(<EnergySystemInlineControl trpc={trpc} deviceId={5766} features={undefined} />)
    const chips = screen.getAllByTestId('energy-value-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0]?.textContent).toBe('Solar 0.8 kW')
  })
})
