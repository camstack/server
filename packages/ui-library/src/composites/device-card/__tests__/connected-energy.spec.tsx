// @vitest-environment jsdom
/**
 * The energy system's connected card (#513): an `energy-system` device resolves
 * to the energy card, the scene's nodes come from the model, and the storage is
 * read from the model's `storage` part — the card never draws a battery corner,
 * because the system is not a device that runs on a battery (#522).
 */
import { DeviceType, type EnergySystemStatus } from '@camstack/types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedEnergyCard } from '../connected/ConnectedEnergyCard'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import { energyDailyFacts, energyFlowsOf, energyTodayOf } from '../connected/energy-model'

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
    healthPct: 96,
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

describe('energyDailyFacts', () => {
  it('derives each fact from the slice', () => {
    const facts = energyDailyFacts(FULL)
    expect(facts.selfSufficiencyPct).toBeCloseTo((1 - 2.1 / 11.2) * 100, 5)
    expect(facts.producedKwh).toBe(18.4)
    expect(facts.houseKwh).toBe(11.2)
    expect(facts.importedKwh).toBe(2.1)
    expect(facts.exportedKwh).toBe(7.3)
    expect(facts.autonomyHours).toBeCloseTo(7.4 / 0.9, 5)
    expect(facts.chargedTodayKwh).toBe(6.1)
    expect(facts.dischargedTodayKwh).toBe(4.2)
    expect(facts.socPct).toBe(74)
    expect(facts.healthPct).toBe(96)
    expect(facts.heatPumpShareNowPct).toBeCloseTo((600 / 900) * 100, 5)
  })

  it('derives house consumption from produced + import − export when the day total is absent', () => {
    const facts = energyDailyFacts({
      ...FULL,
      house: { powerW: 900, energyKwh: 8000, todayKwh: null },
    })
    // 18.44 + 2.1 − 7.3 = 13.24
    expect(facts.houseKwh).toBe(13.2)
    expect(facts.selfSufficiencyPct).toBeCloseTo((1 - 2.1 / 13.24) * 100, 5)
  })

  it('a missing input is absent, never 0', () => {
    const noImport = energyDailyFacts({
      ...FULL,
      grid: {
        powerW: -1500,
        importKwh: 3000,
        exportKwh: 5000,
        importTodayKwh: null,
        exportTodayKwh: 7.3,
      },
    })
    expect(noImport.selfSufficiencyPct).toBeNull()
    expect(noImport.importedKwh).toBeNull()

    const idle = energyDailyFacts({
      ...FULL,
      house: { powerW: 0, energyKwh: null, todayKwh: null },
      solar: null,
      heatPump: null,
      storage: null,
    })
    expect(idle.selfSufficiencyPct).toBeNull()
    expect(idle.houseKwh).toBeNull()
    expect(idle.autonomyHours).toBeNull()
    expect(idle.heatPumpShareNowPct).toBeNull()
    expect(idle.chargedTodayKwh).toBeNull()
    expect(idle.healthPct).toBeNull()
    expect(idle.socPct).toBeNull()
  })

  it('clamps self-sufficiency to 0–100', () => {
    const grid = {
      powerW: 100,
      importKwh: 1,
      exportKwh: 1,
      importTodayKwh: 9,
      exportTodayKwh: 0,
    }
    expect(
      energyDailyFacts({
        ...FULL,
        house: { powerW: 900, energyKwh: 1, todayKwh: 4 },
        grid,
      }).selfSufficiencyPct,
    ).toBe(0)
    expect(
      energyDailyFacts({
        ...FULL,
        house: { powerW: 900, energyKwh: 1, todayKwh: 4 },
        grid: { ...grid, importTodayKwh: 0 },
      }).selfSufficiencyPct,
    ).toBe(100)
  })
})

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
      energyTodayOf({
        ...FULL,
        solar: null,
        grid: null,
        heatPump: null,
        house: null,
        storage: null,
      }),
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
    expect(screen.getAllByTestId('dc-energy-today')[0]?.textContent).toContain('18.4 kWh')
    expect(screen.queryByText('19%')).toBeNull()
  })

  it('every total of today is its own pill, and each names its unit', () => {
    hub.slice = FULL
    render(<ConnectedEnergyCard deviceId={1} optimistic={false} />)
    const chips = screen.getAllByTestId('dc-energy-today-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Produced18.4 kWh',
      'House11.2 kWh',
      'Imported2.1 kWh',
      'Exported7.3 kWh',
      'Self-use60%',
      'Self-sufficiency81%',
      'Now67%',
      'Health96%',
      'Autonomy≈ 8.2 h',
      'Charged6.1 kWh',
      'Discharged4.2 kWh',
    ])
  })

  it('keeps the Charge pill when the scene does not draw the battery', () => {
    hub.slice = {
      ...FULL,
      storage: {
        stateOfChargePct: 74,
        storedKwh: 7.4,
        capacityKwh: 10,
        powerW: null,
        chargedKwh: 2500,
        dischargedKwh: 2300,
        chargedTodayKwh: 6.1,
        dischargedTodayKwh: 4.2,
        healthPct: 96,
      },
    }
    render(<ConnectedEnergyCard deviceId={1} optimistic={false} />)
    expect(screen.queryByText('Charging · 74%')).toBeNull()
    const chips = screen.getAllByTestId('dc-energy-today-chip')
    expect(chips.map((chip) => chip.textContent)).toContain('Charge74%')
  })

  it('omits a pill whose input is missing, and never draws 0 for it', () => {
    hub.slice = {
      ...FULL,
      house: { powerW: 0, energyKwh: 8000, todayKwh: null },
      solar: null,
      grid: null,
      heatPump: null,
      storage: {
        stateOfChargePct: null,
        storedKwh: null,
        capacityKwh: 10,
        powerW: null,
        chargedKwh: null,
        dischargedKwh: null,
        chargedTodayKwh: null,
        dischargedTodayKwh: null,
        healthPct: null,
      },
    }
    render(<ConnectedEnergyCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-energy-today')).toBeNull()
  })

  it('draws nothing before the cap answers', () => {
    const { container } = render(<ConnectedEnergyCard deviceId={1} optimistic={false} />)
    expect(container.innerHTML).toBe('')
  })
})
