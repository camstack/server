import type { EnergySystemStatus } from '@dominevo/types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultUiText } from '../../../contexts/ui-text'
import { energyFixtures } from '../__fixtures__/energy'
import { energyDayTotalsFixture } from '../__fixtures__/energy-day'
import { energyTodayOfDay } from '../connected/energy-day'
import { energyFlowsOf } from '../connected/energy-model'
import { EnergyFlowIllustration } from '../illustrations/EnergyFlowIllustration'
import {
  EnergyCard,
  energyCentreFigures,
  energyDayNodes,
  energyNodes,
} from '../scenes/energy/EnergyCard'
import type { EnergyCardModel } from '../scenes/energy/model'

afterEach(cleanup)

const t = defaultUiText

function baseModel(): EnergyCardModel {
  const base = energyFixtures()[0]
  if (base === undefined) throw new Error('no energy fixture')
  return base.model
}

function dayModel(): EnergyCardModel {
  return { ...baseModel(), today: energyTodayOfDay(energyDayTotalsFixture, true, true) }
}

describe('a past day of the energy card', () => {
  it('draws the five nodes from the day kWh with the arrow of the net flow', () => {
    const nodes = energyDayNodes(energyTodayOfDay(energyDayTotalsFixture, true, true), t)
    const by = (id: string) => nodes.find((n) => n.id === id)
    expect(by('solar')?.value).toBe('9.3 kWh')
    // Net grid +17.3 imported: into the bus.
    expect(by('grid')).toMatchObject({
      watts: 17.3,
      label: 'Import',
      value: '17.3 kWh',
      still: false,
    })
    // Discharged 3.2 minus charged 3.8: net charge, out of the bus.
    expect(by('battery')).toMatchObject({ watts: -0.6, label: 'Charged', still: false })
    // Household 4.1 and heat pump 21.9 consume: out of the bus.
    expect(by('house')).toMatchObject({ watts: -4.1, value: '4.1 kWh' })
    expect(by('heatPump')).toMatchObject({ watts: -21.9, value: '21.9 kWh' })
    expect(nodes.every((n) => n.animate === false)).toBe(true)
  })

  it('zero net flow draws no arrow; an unknown total draws no node', () => {
    const today = energyTodayOfDay(
      { ...energyDayTotalsFixture, importedKwh: 1, exportedKwh: 1, heatPumpKwh: null },
      false,
      true,
    )
    const nodes = energyDayNodes(today, t)
    expect(nodes.find((n) => n.id === 'grid')?.still).toBe(true)
    expect(nodes.find((n) => n.id === 'heatPump')).toBeUndefined()
  })

  it('renders arrowheads by direction, with no live state and no "Live now"', () => {
    render(<EnergyCard model={dayModel()} actions={{}} nodesLive={false} />)
    expect(screen.queryByText('Live now')).toBeNull()
    expect(screen.queryByText('Producing')).toBeNull()
    expect(screen.queryByText('Not producing')).toBeNull()
    expect(screen.getByTestId('dc-energy-branch-grid').getAttribute('data-direction')).toBe('in')
    expect(screen.getByTestId('dc-energy-branch-heatPump').getAttribute('data-direction')).toBe(
      'out',
    )
    for (const id of ['solar', 'grid', 'battery', 'house', 'heatPump']) {
      expect(screen.getByTestId(`dc-energy-arrow-${id}`)).toBeTruthy()
    }
  })

  it('shows where the consumption came from in the day totals', () => {
    render(<EnergyCard model={dayModel()} actions={{}} nodesLive={false} />)
    const chips = screen.getAllByTestId('dc-energy-today-chip').map((c) => c.textContent)
    expect(chips).toContain('Consumed26 kWh')
    expect(chips).toContain('Solar21%')
    expect(chips).toContain('Battery12%')
    expect(chips).toContain('Grid67%')
  })

  it('the centre figures are autarky, imported, exported and produced', () => {
    const f = energyCentreFigures(energyTodayOfDay(energyDayTotalsFixture, true, true), t)
    expect(f.map((x) => [x.id, x.value, x.unit])).toEqual([
      ['sufficiency', '33%', undefined],
      ['imported', '17.4', 'kWh'],
      ['exported', '0.1', 'kWh'],
      ['produced', '9.3', 'kWh'],
    ])
  })
})

describe('arrowhead placement', () => {
  it('sits at the midpoint of the visible branch, outside the centre circle', () => {
    render(
      <EnergyFlowIllustration
        ariaLabel="energy"
        nodes={[{ id: 'solar', watts: 3000, label: 'Solar', value: '3 kW', still: false }]}
        centre={[{ id: 'sufficiency', label: 'Autarky', value: '50%' }]}
      />,
    )
    // Solar node (130,-6), node radius 19, centre radius 48, bus (130,92):
    // the branch shows from y=13 to y=44, so its midpoint is y=28.5 (not 43).
    const transform = screen.getByTestId('dc-energy-arrow-solar').getAttribute('transform')
    expect(transform).toContain('translate(130.0 28.5)')
  })
})

describe('live arrows', () => {
  const GRID_NO_POWER: EnergySystemStatus = {
    solar: { powerW: 0, energyKwh: null, todayKwh: 0 },
    grid: {
      powerW: null,
      importKwh: null,
      exportKwh: null,
      importTodayKwh: 0,
      exportTodayKwh: null,
    },
    house: null,
    heatPump: null,
    storage: null,
    lastFetchedAt: 0,
  }

  it('a grid that exists without a power reading is unknown, not 0 W', () => {
    const flows = energyFlowsOf(GRID_NO_POWER)
    expect(flows.gridW).toBeNull()
    expect(flows.gridPowerUnknown).toBe(true)
    expect(energyFlowsOf({ ...GRID_NO_POWER, grid: null }).gridPowerUnknown).toBeFalsy()
  })

  it('the grid node of an unanswered power shows a dash, is still and has no arrow', () => {
    const nodes = energyNodes(energyFlowsOf(GRID_NO_POWER), t)
    const grid = nodes.find((n) => n.id === 'grid')
    expect(grid?.value).toBe('—')
    expect(grid?.still).toBe(true)
    expect(
      energyNodes(energyFlowsOf({ ...GRID_NO_POWER, grid: null }), t).some((n) => n.id === 'grid'),
    ).toBe(false)
  })

  it('every moving branch carries an arrowhead, the solar one included', () => {
    render(<EnergyCard model={baseModel()} actions={{}} />)
    let moving = 0
    for (const id of ['solar', 'grid', 'battery', 'house', 'heatPump']) {
      const branch = screen.queryByTestId(`dc-energy-branch-${id}`)
      if (branch === null || branch.getAttribute('data-direction') === 'still') continue
      moving += 1
      expect(screen.getByTestId(`dc-energy-arrow-${id}`)).toBeTruthy()
    }
    expect(moving).toBeGreaterThan(2)
  })
})
