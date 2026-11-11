// @vitest-environment jsdom
import type { ClimateControlStatus } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIMATE_FIXTURES } from '../__fixtures__/climate'
import { ConnectedClimateCard } from '../connected/ConnectedClimateCard'

const STATUS: ClimateControlStatus = {
  mode: 'heat',
  availableModes: ['off', 'heat'],
  fanMode: '',
  availableFanModes: [],
  preset: '',
  availablePresets: [],
  target: 21,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: 20,
  currentHumidity: null,
  swingVertical: null,
  swingHorizontal: null,
  minTemp: 5,
  maxTemp: 35,
  tempStep: 1,
  lastFetchedAt: 0,
}

const setTarget = vi.fn()

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    climateControl: { setTarget, setMode: vi.fn() },
    heatingValve: undefined,
    state: { climateControl: STATUS },
  }),
  // The fake proxy carries the slice value itself.
  useDeviceStateSlice: (slice: unknown) => slice,
}))
// The shell's data comes from a fixture; the notice is the REAL hook, so the
// path under test is command -> refusal -> notice -> reason line.
vi.mock('../connected/use-card-common', async () => {
  const { useCommandNotice } = await import('../connected/use-command-notice')
  return {
    useCardCommon: () => {
      const { notice, fail, succeed } = useCommandNotice()
      const common = CLIMATE_FIXTURES[0]?.model.common
      if (common === undefined) throw new Error('no climate fixture')
      return {
        common: { ...common, consumables: null, supply: null, notice },
        actions: {},
        deviceType: 'climate',
        role: 'climate-thermostat',
        fail,
        succeed,
      }
    },
  }
})

afterEach(() => {
  cleanup()
  setTarget.mockReset()
})

describe('ConnectedClimateCard — a refused command says why on the card', () => {
  it('a refused setTarget puts its reason on the reason line, and the next success clears it', async () => {
    setTarget.mockRejectedValueOnce(new Error('valve is in manual mode'))
    render(<ConnectedClimateCard deviceId={1} />)
    expect(screen.queryByTestId('dc-reason')).toBeNull()

    fireEvent.keyDown(screen.getByTestId('dc-dial'), { key: 'ArrowUp' })
    expect(setTarget).toHaveBeenCalledWith({ target: 22 })
    const reason = await screen.findByTestId('dc-reason')
    expect(reason.textContent).toBe('Command failed: valve is in manual mode')

    setTarget.mockResolvedValueOnce(undefined)
    fireEvent.keyDown(screen.getByTestId('dc-dial'), { key: 'ArrowUp' })
    await vi.waitFor(() => expect(screen.queryByTestId('dc-reason')).toBeNull())
  })
})

describe('ConnectedClimateCard — showName', () => {
  it('draws the name by default and leaves it out when the host names the device', () => {
    render(<ConnectedClimateCard deviceId={1} />)
    expect(screen.queryByTestId('dc-name')).not.toBeNull()
    cleanup()
    render(<ConnectedClimateCard deviceId={1} showName={false} />)
    expect(screen.queryByTestId('dc-name')).toBeNull()
    expect(screen.queryByTestId('dc-top')).not.toBeNull()
  })
})
