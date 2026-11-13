// @vitest-environment jsdom
/**
 * The energy system's connected card (#513): an `energy-system` device resolves
 * to the energy card, the scene's nodes come from the model, and the storage is
 * read from the model's `storage` part — the card never draws a battery corner,
 * because the system is not a device that runs on a battery (#522).
 */
import { DeviceType, type EnergySystemStatus } from '@camstack/types'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedEnergyCard } from '../connected/ConnectedEnergyCard'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import { energyFlowsOf, energyTodayOf } from '../connected/energy-model'

const FULL: EnergySystemStatus = {
  solar: { powerW: 4200, energyKwh: 12000, todayKwh: 18.44 },
  grid: {
    powerW: -1500,
    importKwh: 3000,
    exportKwh: 5000,
    importTodayKwh: 2.1,
    exportTodayKwh: 7.3,
  },
  house: { powerW: 900, energyKwh: 8000, todayKwh: 11.2 },
  heatPump: { powerW: 600, energyKwh: 1500, todayKwh: null },
  storage: {
    stateOfChargePct: 74,
    storedKwh: 7.4,
    capacityKwh: 10,
    powerW: 1800,
    chargedKwh: 2500,
    dischargedKwh: 2300,
    chargedTodayKwh: 6.1,
    dischargedTodayKwh: 4.2,
  },
  lastFetchedAt: 0,
}

const hub = vi.hoisted(() => ({ slice: null as EnergySystemStatus | null }))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    energySystem: hub.slice === null ? undefined : {},
    state: { energySystem: hub.slice ?? undefined },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../connected/use-card-common', () => ({
  useCardCommon: () => {
    const common = plugFixtures(0)[0]?.model.common
    if (common === undefined) throw new Error('no plug fixture')
    return {
      // A battery corner the common hook might carry must not reach the card.
      common: { ...common, battery: { level: 19 } },
      actions: {},
      deviceType: DeviceType.EnergySystem,
      role: null,
      features: [],
      implements: () => true,
      fail: () => undefined,
      succeed: () => undefined,
    }
  },
}))

beforeEach(() => {
  hub.slice = null
})
afterEach(cleanup)

describe('the energy system card', () => {
  it('an energy-system device with the cap resolves to the energy card', () => {
    expect(connectedCardKindOf(DeviceType.EnergySystem, null, ['energy-system'])).toBe('energy')
    expect(connectedCardKindOf(DeviceType.EnergySystem, null, ['battery'])).toBeNull()
  })

  it('reads the storage from the model: + charging becomes power leaving the bus', () => {
    const flows = energyFlowsOf(FULL)
    expect(flows.batteryW).toBe(-1800)
    expect(flows.batteryPct).toBe(74)
    expect(flows.gridW).toBe(-1500)
  })

  it('a part the system lacks draws no node, and no totals means no totals', () => {
    const flows = energyFlowsOf({ ...FULL, storage: null, heatPump: null })
    expect(flows.batteryW).toBeNull()
    expect(flows.batteryPct).toBeNull()
    expect(flows.heatPumpW).toBeNull()
    expect(
      energyTodayOf({ ...FULL, solar: null, grid: null, heatPump: null, house: null }),
    ).toBeNull()
  })

  it('today’s totals round to a tenth and derive the self-use', () => {
    const today = energyTodayOf(FULL)
    expect(today?.producedKwh).toBe(18.4)
    expect(today?.heatPumpKwh).toBeNull()
    expect(today?.selfConsumptionPct).toBeCloseTo(((18.44 - 7.3) / 18.44) * 100, 5)
  })

  it('renders the scene with the storage from the model and no battery corner', () => {
    hub.slice = FULL
    render(<ConnectedEnergyCard deviceId={1} optimistic={false} />)
    expect(screen.getByText('Charging · 74%')).toBeTruthy()
    expect(screen.getByTestId('dc-energy-today').textContent).toContain('18.4 kWh')
    expect(screen.queryByText('19%')).toBeNull()
  })

  it('every total of today is its own pill, and each names its unit', () => {
    hub.slice = FULL
    render(<ConnectedEnergyCard deviceId={1} optimistic={false} />)
    const chips = within(screen.getByTestId('dc-energy-today')).getAllByTestId(
      'dc-energy-today-chip',
    )
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Produced18.4 kWh',
      'Self-use60%',
      'Imported2.1 kWh',
      'Exported7.3 kWh',
    ])
  })

  it('draws nothing before the cap answers', () => {
    const { container } = render(<ConnectedEnergyCard deviceId={1} optimistic={false} />)
    expect(container.innerHTML).toBe('')
  })
})
