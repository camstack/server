// @vitest-environment jsdom
/**
 * The energy system's connected card (#513): an `energy-system` device resolves
 * to the energy card, the scene's nodes come from the model, and the storage is
 * read from the model's `storage` part — the card never draws a battery corner,
 * because the system is not a device that runs on a battery (#522).
 */
import { DeviceType, type EnergySystemStatus } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  house: { powerW: 300, energyKwh: 6500, todayKwh: null },
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
// The day reads history through tRPC; the card's wiring is what these specs judge.
const PAST_DAY = {
  producedKwh: 10,
  selfConsumptionPct: 75,
  importedKwh: 4,
  exportedKwh: 2.5,
  netGridKwh: 1.5,
  heatPumpKwh: null,
  houseKwh: 12,
  householdKwh: 12,
  sources: null,
  selfSufficiencyPct: 66.7,
  autonomyHours: null,
  chargedTodayKwh: null,
  dischargedTodayKwh: null,
  socPct: null,
  healthPct: null,
  heatPumpShareNowPct: null,
}
/** The centre circle shows four figures at once; read one by id. */
function centreOf(id: string): string {
  return screen.getByTestId(`dc-energy-centre-${id}`).textContent ?? ''
}
const dayCalls = vi.hoisted(() => ({ offsets: [] as number[], past: true }))
vi.mock('../connected/use-energy-day', () => ({
  useEnergyDay: (_deviceId: number, offset: number) => {
    dayCalls.offsets.push(offset)
    return {
      window: { from: 1_700_000_000_000, to: 1_700_086_400_000 },
      status: 'ready',
      powerSeries: [],
      socSeries: [],
      flowSpans: [],
      today: dayCalls.past ? PAST_DAY : null,
    }
  },
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
    expect(facts.selfSufficiencyPct).toBeCloseTo((1 - 2.1 / 11.34) * 100, 5)
    expect(facts.producedKwh).toBe(18.4)
    expect(facts.houseKwh).toBe(11.3)
    expect(facts.importedKwh).toBe(2.1)
    expect(facts.exportedKwh).toBe(7.3)
    expect(facts.autonomyHours).toBeCloseTo(7.4 / 0.9, 5)
    expect(facts.chargedTodayKwh).toBe(6.1)
    expect(facts.dischargedTodayKwh).toBe(4.2)
    expect(facts.socPct).toBe(74)
    expect(facts.healthPct).toBe(96)
    expect(facts.heatPumpShareNowPct).toBeCloseTo((600 / 900) * 100, 5)
  })

  it('the heat pump share is of house + heat pump: 1000 / (500 + 1000)', () => {
    const facts = energyDailyFacts({
      ...FULL,
      house: { powerW: 500, energyKwh: null, todayKwh: null },
      heatPump: { powerW: 1000, energyKwh: null, todayKwh: null },
    })
    expect(facts.heatPumpShareNowPct).toBeCloseTo(66.667, 2)
  })

  it('a heat pump whose power is unknown leaves the share and autonomy unknown', () => {
    const facts = energyDailyFacts({
      ...FULL,
      heatPump: { powerW: null, energyKwh: 1500, todayKwh: null },
    })
    expect(facts.heatPumpShareNowPct).toBeNull()
    expect(facts.autonomyHours).toBeNull()
  })

  it('derives house consumption from produced + import − export when the day total is absent', () => {
    const facts = energyDailyFacts({
      ...FULL,
      house: { powerW: 900, energyKwh: 8000, todayKwh: null },
    })
    // 18.44 + 2.1 − 7.3 = 13.24
    expect(facts.houseKwh).toBe(11.3)
    expect(facts.selfSufficiencyPct).toBeCloseTo((1 - 2.1 / 11.34) * 100, 5)
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
        heatPump: null,
        grid,
      }).selfSufficiencyPct,
    ).toBe(0)
    expect(
      energyDailyFacts({
        ...FULL,
        house: { powerW: 900, energyKwh: 1, todayKwh: 4 },
        heatPump: null,
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
    render(<ConnectedEnergyCard deviceId={1} />)
    expect(screen.getByText('Charging · 74%')).toBeTruthy()
    expect(screen.getAllByTestId('dc-energy-today')[0]?.textContent).toContain('18.4 kWh')
    // The corner's 19% is not drawn (a "19%" source share may sit in the totals).
    expect(
      screen
        .queryAllByText('19%')
        .filter((el) => el.closest('[data-testid="dc-energy-today"]') === null),
    ).toEqual([])
  })

  it('every total of today is its own pill, and each names its unit', () => {
    hub.slice = FULL
    render(<ConnectedEnergyCard deviceId={1} />)
    const chips = screen.getAllByTestId('dc-energy-today-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Produced18.4 kWh',
      'Consumed11.3 kWh',
      'Imported2.1 kWh',
      'Exported7.3 kWh',
      'Solar44%',
      'Battery37%',
      'Grid19%',
      'Now67%',
      'Health96%',
      'Autonomy≈ 8.2 h',
      'Charged6.1 kWh',
      'Discharged4.2 kWh',
    ])
  })

  it('the centre circle shows self-sufficiency, imported, exported and produced together', () => {
    hub.slice = FULL
    render(<ConnectedEnergyCard deviceId={1} />)
    expect(centreOf('sufficiency')).toContain('81%')
    expect(centreOf('imported')).toContain('2.1kWh')
    expect(centreOf('exported')).toContain('7.3kWh')
    expect(centreOf('produced')).toContain('18.4kWh')
    expect(screen.getByTestId('dc-energy-centre').getAttribute('role')).toBe('group')
  })

  it('a missing input reads as a dash in the centre, never 0', () => {
    hub.slice = { ...FULL, grid: { ...FULL.grid!, importTodayKwh: null, exportTodayKwh: null } }
    render(<ConnectedEnergyCard deviceId={1} />)
    expect(centreOf('imported')).toContain('—')
    expect(centreOf('exported')).toContain('—')
    expect(centreOf('sufficiency')).toContain('—')
  })

  it('the day selector steps back a day and shows that day’s figures, then returns to today', () => {
    hub.slice = FULL
    dayCalls.offsets = []
    render(<ConnectedEnergyCard deviceId={1} />)
    expect(screen.getByTestId('dc-energy-day-label').textContent).toBe('Today')
    expect((screen.getByLabelText('Next day') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Previous day'))
    expect(dayCalls.offsets.at(-1)).toBe(1)
    // The scene's nodes read that day's kWh, with no live marker or live state.
    expect(screen.queryByText('Live now')).toBeNull()
    expect(screen.queryByText('Producing')).toBeNull()
    expect(screen.getByTestId('dc-energy-node-solar').textContent).toContain('10.0 kWh')
    expect(screen.getByTestId('dc-energy-branch-grid').getAttribute('data-direction')).toBe('in')
    expect(centreOf('imported')).toContain('4.0kWh')
    expect(centreOf('exported')).toContain('2.5kWh')
    expect((screen.getByLabelText('Next day') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('Today'))
    expect(dayCalls.offsets.at(-1)).toBe(0)
    expect(screen.getByText('Producing')).toBeTruthy()
    expect(centreOf('exported')).toContain('7.3kWh')
  })

  it('a past day with no recording shows dashes, not zeros', () => {
    hub.slice = FULL
    dayCalls.past = false
    render(<ConnectedEnergyCard deviceId={1} />)
    fireEvent.click(screen.getByLabelText('Previous day'))
    dayCalls.past = true
    expect(centreOf('imported')).toContain('—')
    expect(centreOf('sufficiency')).toContain('—')
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
    render(<ConnectedEnergyCard deviceId={1} />)
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
    render(<ConnectedEnergyCard deviceId={1} />)
    expect(screen.queryByTestId('dc-energy-today')).toBeNull()
  })

  it('draws nothing before the cap answers', () => {
    const { container } = render(<ConnectedEnergyCard deviceId={1} />)
    expect(container.innerHTML).toBe('')
  })
})
