// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { PowerMeterStatus } from '@camstack/types'
import { PowerMeterLine, formatEnergyKwh, formatPowerWatts } from '../PowerMeterLine'
import { HOST_WIDGETS } from '../../../widgets/host-widgets'

let slice: PowerMeterStatus | undefined

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => ({ cap: undefined, slice, available: true }),
}))
vi.mock('../../../contexts/system-context', () => ({
  useSystem: () => ({ trpcClient: {} }),
}))

beforeEach(() => {
  slice = undefined
})
afterEach(cleanup)

describe('PowerMeterLine', () => {
  it('is registered as the host widget the cap names', () => {
    expect(HOST_WIDGETS['host/power-meter-line']).toBe(PowerMeterLine)
  })

  it('shows watts and energy when both are reported', () => {
    slice = { power: 412.4, energy: 3.456, lastFetchedAt: 1 }
    render(<PowerMeterLine deviceId={1} />)
    expect(screen.getByTestId('power-meter-power').textContent).toBe('412W')
    expect(screen.getByTestId('power-meter-energy').textContent).toBe('3.46kWh')
    expect(screen.getByTestId('power-meter-pulse')).toBeTruthy()
  })

  it('a real 0 W is drawn as 0, without the pulse', () => {
    slice = { power: 0, lastFetchedAt: 1 }
    render(<PowerMeterLine deviceId={1} />)
    expect(screen.getByTestId('power-meter-power').textContent).toBe('0W')
    expect(screen.queryByTestId('power-meter-pulse')).toBeNull()
    expect(screen.queryByTestId('power-meter-energy')).toBeNull()
  })

  it('draws energy alone when power is unknown — never NaN or 0', () => {
    slice = { energy: 12, lastFetchedAt: 1 }
    render(<PowerMeterLine deviceId={1} />)
    expect(screen.queryByTestId('power-meter-power')).toBeNull()
    expect(screen.getByTestId('power-meter-energy').textContent).toBe('12.00kWh')
  })

  it('renders nothing before a slice lands or when no reading is numeric', () => {
    const { container, rerender } = render(<PowerMeterLine deviceId={1} />)
    expect(container.innerHTML).toBe('')
    slice = { power: Number.NaN, lastFetchedAt: 1 }
    rerender(<PowerMeterLine deviceId={1} />)
    expect(container.innerHTML).toBe('')
    slice = { lastFetchedAt: 1 }
    rerender(<PowerMeterLine deviceId={1} />)
    expect(container.innerHTML).toBe('')
  })

  it('formats kilowatts and large energy', () => {
    expect(formatPowerWatts(1500)).toEqual({ value: '1.5', unit: 'kW' })
    expect(formatEnergyKwh(250.4)).toBe('250')
  })
})
