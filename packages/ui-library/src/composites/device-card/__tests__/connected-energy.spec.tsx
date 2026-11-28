// @vitest-environment jsdom
/**
 * The energy system's connected card (#513): an `energy-system` device resolves
 * to the energy card, the scene's nodes come from the model, and the storage is
 * read from the model's `storage` part — the card never draws a battery corner,
 * because the system is not a device that runs on a battery (#522).
 */
import { DeviceType, type EnergySystemStatus } from '@dominevo/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import { ConnectedEnergyCard } from '../connected/ConnectedEnergyCard'
import {
  energyDailyFacts,
  energyFlowsOf,
  energyTodayOf,
  type LinkedHeatPump,
  type LinkedHeatPumpStatus,
  linkedHeatPumpOf,
} from '../connected/energy-model'

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

const hub = vi.hoisted(() => ({
  slice: null as EnergySystemStatus | null,
  /** The composite device's resolved display (Customize → Display). */
  display: undefined as { precision?: number } | undefined,
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
  useOptionalSystem: () => ({
    getDeviceInfo: () => (hub.display === undefined ? null : { display: hub.display }),
  }),
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
const dayCalls = vi.hoisted(() => ({
  offsets: [] as number[],
  linkedKwh: [] as (number | null | undefined)[],
  past: true,
}))
/** The heat pump link and the device it reads (D1076): `null` = no link holds. */
const link = vi.hoisted(() => ({ linked: null as LinkedHeatPump | null }))
vi.mock('../connected/use-heat-pump-link', () => ({
  useHeatPumpLink: () =>
    link.linked === null ? { status: 'none' } : { status: 'linked', sourceDeviceId: 77 },
  useLinkedHeatPump: (sourceDeviceId: number | null) =>
    sourceDeviceId === null ? null : link.linked,
}))
vi.mock('../connected/use-energy-day', () => ({
  useEnergyDay: (_deviceId: number, offset: number, _t: unknown, linkedKwh?: number | null) => {
    dayCalls.offsets.push(offset)
    dayCalls.linkedKwh.push(linkedKwh)
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
  link.linked = null
  dayCalls.linkedKwh.length = 0
  hub.slice = null
  hub.display = undefined
})
afterEach(cleanup)

describe('energyDailyFacts', () => {
  it('derives each fact from the slice', () => {
    const facts = energyDailyFacts(FULL)
    expect(facts.selfSufficiencyPct).toBeCloseTo((1 - 2.1 / 11.34) * 100, 5)
    expect(facts.producedKwh).toBe(18.44)
    expect(facts.houseKwh).toBe(11.34)
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
    expect(facts.houseKwh).toBe(11.34)
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

  it('today’s totals keep their reported decimals and derive the self-use', () => {
    const today = energyTodayOf(FULL)
    expect(today?.producedKwh).toBe(18.44)
    expect(today?.heatPumpKwh).toBeNull()
    expect(today?.selfConsumptionPct).toBeCloseTo(((18.44 - 7.3) / 18.44) * 100, 5)
  })

  it('without a house day total the household is the balance minus the heat pump', () => {
    const withPump = { ...FULL, heatPump: { powerW: 600, energyKwh: 1500, todayKwh: 3 } }
    // 18.44 + 2.1 − 7.3 + 4.2 − 6.1 = 11.34; minus the pump's 3 = 8.34.
    expect(energyTodayOf(withPump)?.householdKwh).toBe(8.34)
    expect(energyTodayOf(withPump)?.houseKwh).toBe(11.34)
    // The house's own day total wins when it is reported.
    const reported = { ...withPump, house: { powerW: 300, energyKwh: 6500, todayKwh: 5 } }
    expect(energyTodayOf(reported)?.householdKwh).toBe(5)
    // A heat pump with no day total leaves the household unknown, not the whole balance.
    expect(energyTodayOf(FULL)?.householdKwh).toBeNull()
  })

  it('a storage system whose day counters are unknown has no consumption balance', () => {
    const blind = {
      ...FULL,
      storage: FULL.storage && {
        ...FULL.storage,
        chargedTodayKwh: null,
        dischargedTodayKwh: null,
      },
    }
    expect(energyTodayOf(blind)?.houseKwh).toBeNull()
    expect(energyTodayOf(blind)?.sources).toBeNull()
  })

  it('renders the scene with the storage from the model and no battery corner', () => {
    hub.slice = FULL
    render(<ConnectedEnergyCard deviceId={1} />)
    expect(screen.getByText('Charging · 74%')).toBeTruthy()
    expect(screen.getAllByTestId('dc-energy-today')[0]?.textContent).toContain('18.44 kWh')
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
      'Produced18.44 kWh',
      'Consumed11.34 kWh',
      'Imported2.1 kWh',
      'Exported7.3 kWh',
      'Solar44%',
      'Battery37%',
      'Grid19%',
      'Now67%',
      'Health96%',
      'Autonomy≈ 8.22 h',
      'Charged6.1 kWh',
      'Discharged4.2 kWh',
    ])
  })

  it('honours the Precision set on the composite device for every kWh and kW it shows', () => {
    hub.slice = FULL
    hub.display = { precision: 0 }
    render(<ConnectedEnergyCard deviceId={1} />)
    const chips = screen.getAllByTestId('dc-energy-today-chip').map((chip) => chip.textContent)
    expect(chips).toContain('Produced18 kWh')
    expect(chips).toContain('Autonomy≈ 8 h')
    expect(centreOf('produced')).toContain('18kWh')
    expect(screen.getByTestId('dc-energy-node-solar').textContent).toContain('4 kW')
  })

  it('keeps the trailing zeros of an explicit Precision', () => {
    hub.slice = FULL
    hub.display = { precision: 3 }
    render(<ConnectedEnergyCard deviceId={1} />)
    expect(centreOf('imported')).toContain('2.100kWh')
    expect(screen.getByTestId('dc-energy-node-solar').textContent).toContain('4.200 kW')
  })

  it('the centre circle shows self-sufficiency, imported, exported and produced together', () => {
    hub.slice = FULL
    render(<ConnectedEnergyCard deviceId={1} />)
    expect(centreOf('sufficiency')).toContain('81%')
    expect(centreOf('imported')).toContain('2.1kWh')
    expect(centreOf('exported')).toContain('7.3kWh')
    expect(centreOf('produced')).toContain('18.44kWh')
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
    expect(screen.getByTestId('dc-energy-node-solar').textContent).toContain('10 kWh')
    expect(screen.getByTestId('dc-energy-branch-grid').getAttribute('data-direction')).toBe('in')
    expect(centreOf('imported')).toContain('4kWh')
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

  it('a linked heat pump replaces the system branch: its power, its day kWh and its COP', () => {
    // The system's own branch says 600 W; the linked device says 900 W and a 3.2 COP over the day.
    hub.slice = FULL
    link.linked = {
      powerW: 900,
      lifetimeKwh: 1500,
      copNow: 3.5,
      dayKwh: 5,
      dayCop: 3.2,
    }
    dayCalls.past = false
    render(<ConnectedEnergyCard deviceId={1} />)
    expect(dayCalls.linkedKwh.at(-1)).toBe(5)
    const text = screen
      .getAllByTestId('dc-energy-today')
      .map((el) => el.textContent)
      .join(' ')
    expect(text).toContain('5 kWh')
    expect(text).toContain('3.2')
    expect(text).toContain('3.5')
    expect(text).not.toContain('600')
  })

  it('without a link the system branch stands and no COP is shown', () => {
    hub.slice = FULL
    dayCalls.past = false
    render(<ConnectedEnergyCard deviceId={1} />)
    expect(dayCalls.linkedKwh.at(-1)).toBeUndefined()
    expect(screen.queryByText('COP today')).toBeNull()
  })
})

describe('linkedHeatPumpOf', () => {
  const status: LinkedHeatPumpStatus = {
    power: { electricalW: 800, thermalW: 2800, compressorPct: null },
    energy: { electricalKwh: 1200, thermalKwh: 4000 },
  }
  it('is thermal over electrical, now and over the day', () => {
    const hp = linkedHeatPumpOf(status, { thermalKwh: 12, electricalKwh: 4 })
    expect(hp.copNow).toBeCloseTo(3.5, 5)
    expect(hp.dayCop).toBe(3)
    expect(hp.powerW).toBe(800)
    expect(hp.dayKwh).toBe(4)
  })
  it('an unanswered slice or an unread counter is null, never 0', () => {
    const hp = linkedHeatPumpOf(undefined, { thermalKwh: null, electricalKwh: null })
    expect(hp).toEqual({
      powerW: null,
      lifetimeKwh: null,
      copNow: null,
      dayKwh: null,
      dayCop: null,
    })
  })
})
