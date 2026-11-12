// @vitest-environment jsdom
/**
 * The Wave-C scenes and their pure models: what a heat pump and a water heater
 * draw from a status, which card a device type resolves to, and every mockup
 * fixture rendering through the shell.
 */
import {
  DeviceType,
  type HeatPumpCircuit,
  type HeatPumpStatus,
  type WaterHeaterStatus,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultUiText } from '../../../contexts/ui-text'
import { energyFixtures } from '../__fixtures__/energy'
import { heatPumpFixtures } from '../__fixtures__/heat-pump'
import { waterHeaterFixtures } from '../__fixtures__/water-heater'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import {
  heatPumpActivityOf,
  heatPumpCircuitPicker,
  heatPumpCircuitView,
  heatPumpSystemModes,
} from '../connected/heat-pump-model'
import { waterHeaterActivityOf, waterHeaterOnMode } from '../connected/water-heater-model'
import { EnergyCard, energyNodes, energySince } from '../scenes/energy/EnergyCard'
import type { EnergyFlows } from '../scenes/energy/model'
import { HeatPumpCard } from '../scenes/heat-pump/HeatPumpCard'
import type { HeatPumpCardActions } from '../scenes/heat-pump/model'
import { WaterHeaterCard, waterHeaterFill } from '../scenes/water-heater/WaterHeaterCard'
import type { WaterHeaterCardActions } from '../scenes/water-heater/model'

afterEach(cleanup)

const t = defaultUiText

const CIRCUIT: HeatPumpCircuit = {
  id: 'hc1',
  kind: 'heating',
  label: 'Circuit 1',
  icon: 'flame',
  currentTemp: 21,
  targetTemp: 22,
  mode: 'auto',
  active: false,
  operationMode: { value: 'auto', allowed: ['auto', 'manual'] },
  heatCoolMode: null,
  summerWinter: null,
  comfortSetpoint: null,
  ecoSetpoint: null,
  maxFlowTemp: null,
  temperatureLevel: null,
  chargeDuration: null,
  extraHotWater: null,
}
const DHW: HeatPumpCircuit = {
  ...CIRCUIT,
  id: 'dhw1',
  kind: 'dhw',
  currentTemp: 48,
  targetTemp: 55,
  operationMode: null,
  temperatureLevel: { value: 'eco', allowed: ['low', 'high', 'eco'] },
}
const PUMP: HeatPumpStatus = {
  circuits: [CIRCUIT, DHW],
  system: { silent: null, away: null, additionalHeater: null, holiday: null },
  power: { thermalW: null, electricalW: null, compressorPct: null },
  temperatures: { supply: null, return: null, outdoor: null },
  energy: { thermalKwh: null, electricalKwh: null },
  waterPressureBar: null,
  starts: null,
  lastFetchedAt: 0,
}
const WATER: WaterHeaterStatus = {
  currentTemp: 50,
  targetTemp: 55,
  operationMode: 'eco',
  availableModes: ['off', 'eco', 'boost'],
  away: false,
  minTemp: 30,
  maxTemp: 60,
  lastChangedAt: 0,
}

describe('heat pump model', () => {
  it('is idle when the compressor is still, whatever circuit claims to be active', () => {
    const active = { ...PUMP, circuits: [{ ...DHW, active: true }] }
    expect(heatPumpActivityOf({ ...active, power: { ...PUMP.power, compressorPct: 0 } })).toBe(
      'idle',
    )
    expect(heatPumpActivityOf({ ...active, power: { ...PUMP.power, compressorPct: 40 } })).toBe(
      'dhw',
    )
    expect(heatPumpActivityOf(PUMP)).toBe('idle')
  })

  it('reads running from the electrical draw when no compressor is reported', () => {
    const cooling = { ...CIRCUIT, kind: 'cooling' as const, active: true }
    expect(
      heatPumpActivityOf({
        ...PUMP,
        circuits: [cooling],
        power: { ...PUMP.power, electricalW: 900 },
      }),
    ).toBe('cool')
  })

  it('offers only declared, choosable system modes, in a fixed order', () => {
    const modes = heatPumpSystemModes(
      {
        holiday: { value: 'off', allowed: ['off', 'hm2', 'hm3'] },
        silent: { value: 'off', allowed: ['off', 'on'] },
        away: { value: null, allowed: [] },
        additionalHeater: { value: 'auto', allowed: ['auto', 'manual', 'off'] },
      },
      t,
    )
    expect(modes.map((m) => m.id)).toEqual(['silent', 'additionalHeater', 'holiday'])
    expect(modes.find((m) => m.id === 'silent')?.toggleOn).toBe('on')
    expect(modes.find((m) => m.id === 'additionalHeater')?.toggleOn).toBeNull()
    expect(modes.find((m) => m.id === 'holiday')?.toggleOn).toBe('hm2')
  })

  it('picks a level for hot water and a mode for a heating circuit', () => {
    expect(heatPumpCircuitPicker(DHW, t)?.kind).toBe('level')
    expect(heatPumpCircuitPicker(CIRCUIT, t)?.kind).toBe('mode')
    expect(heatPumpCircuitPicker({ ...CIRCUIT, operationMode: null }, t)).toBeNull()
    expect(heatPumpCircuitView({ ...DHW, active: true }, t).detail).toContain('55')
  })
})

describe('water heater model', () => {
  it('derives off, away, heating and ready', () => {
    expect(waterHeaterActivityOf({ ...WATER, operationMode: 'off' })).toBe('off')
    expect(waterHeaterActivityOf({ ...WATER, away: true })).toBe('away')
    expect(waterHeaterActivityOf(WATER)).toBe('heat')
    expect(waterHeaterActivityOf({ ...WATER, currentTemp: 56 })).toBe('idle')
  })

  it('turns back on in the last mode it ran, else the first one that is not off', () => {
    expect(waterHeaterOnMode({ ...WATER, lastActiveMode: 'boost' })).toBe('boost')
    expect(waterHeaterOnMode(WATER)).toBe('eco')
    expect(waterHeaterOnMode({ ...WATER, availableModes: ['eco', 'boost'] })).toBeNull()
  })

  it('fills the tank to the temperature, never empty', () => {
    expect(waterHeaterFill(null, 60)).toBeCloseTo(0.08)
    expect(waterHeaterFill(60, 60)).toBe(1)
    expect(waterHeaterFill(35, 60)).toBeCloseTo(0.5)
  })
})

describe('dispatch', () => {
  it('draws a heat pump only with its status, and a water heater only with its cap', () => {
    expect(connectedCardKindOf(DeviceType.HeatPump, null, ['heat-pump-status'])).toBe('heat-pump')
    expect(connectedCardKindOf(DeviceType.HeatPump, null, ['switch'])).toBeNull()
    expect(connectedCardKindOf(DeviceType.WaterHeater, null, ['water-heater'])).toBe('water-heater')
    expect(connectedCardKindOf(DeviceType.WaterHeater, null, ['switch'])).toBeNull()
  })
})

describe('fixtures', () => {
  const hpActions = (): HeatPumpCardActions => ({ onCircuit: vi.fn(), onSystemMode: vi.fn() })
  const whActions = (): WaterHeaterCardActions => ({
    onPower: vi.fn(),
    onTarget: vi.fn(),
    onMode: vi.fn(),
    onAway: vi.fn(),
  })

  it.each(heatPumpFixtures().map((f) => [f.id, f] as const))('heat pump %s renders', (_, f) => {
    render(<HeatPumpCard model={f.model} actions={hpActions()} orientation={f.orientation} />)
    expect(screen.getByTestId('device-card').getAttribute('data-card-kind')).toBe('heat-pump')
    expect(screen.getByTestId('dc-hp-temps')).toBeTruthy()
  })

  it('toggles a system mode to its on value and back to off', () => {
    const f = heatPumpFixtures().find((x) => x.id === 'heatpump-system')
    if (f === undefined) throw new Error('no system fixture')
    const actions = hpActions()
    render(<HeatPumpCard model={f.model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-hp-system-away'))
    expect(actions.onSystemMode).toHaveBeenCalledWith('away', 'off')
    fireEvent.click(screen.getByTestId('dc-hp-system-holiday'))
    expect(actions.onSystemMode).toHaveBeenCalledWith('holiday', 'hm1')
  })

  it.each(waterHeaterFixtures().map((f) => [f.id, f] as const))('water %s renders', (_, f) => {
    render(<WaterHeaterCard model={f.model} actions={whActions()} orientation={f.orientation} />)
    expect(screen.getByTestId('device-card').getAttribute('data-card-kind')).toBe('water-heater')
    expect(screen.getByTestId('dc-wh-target')).toBeTruthy()
  })

  it('holds the target and the mode while the heater is off', () => {
    const f = waterHeaterFixtures().find((x) => x.id === 'water-off')
    if (f === undefined) throw new Error('no off fixture')
    render(<WaterHeaterCard model={f.model} actions={whActions()} />)
    expect(screen.getByRole('button', { name: 'Raise target' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByTestId('dc-wh-away')).toBeNull()
  })
})

describe('energy system', () => {
  const FLOWS: EnergyFlows = {
    solarW: 4200,
    gridW: -500,
    batteryW: -2600,
    batteryPct: 78,
    houseW: 600,
    heatPumpW: 500,
  }

  it('draws a node per reported power, signed against the bus', () => {
    const nodes = energyNodes(FLOWS, t)
    expect(nodes.map((n) => n.id)).toEqual(['solar', 'grid', 'battery', 'house', 'heatPump'])
    expect(nodes.find((n) => n.id === 'grid')?.label).toBe('Export')
    expect(nodes.find((n) => n.id === 'battery')?.label).toBe('Charging · 78%')
    expect(nodes.find((n) => n.id === 'house')?.watts).toBe(-600)
    const plain = energyNodes({ ...FLOWS, batteryW: null, heatPumpW: null }, t)
    expect(plain.map((n) => n.id)).toEqual(['solar', 'grid', 'house'])
  })

  it('holds a node below the still threshold', () => {
    const grid = energyNodes({ ...FLOWS, gridW: 20 }, t).find((n) => n.id === 'grid')
    expect(grid?.still).toBe(true)
    expect(grid?.label).toBe('Grid')
  })

  it('says where the house draws from when the sun does not produce', () => {
    expect(energySince(FLOWS, t)).toBe('4.2 kW')
    expect(energySince({ ...FLOWS, solarW: 0, batteryW: 1500 }, t)).toBe('from the battery')
    expect(energySince({ ...FLOWS, solarW: 0, batteryW: -2000, gridW: 2500 }, t)).toBe(
      'from the grid',
    )
  })

  it.each(energyFixtures().map((f) => [f.id, f] as const))('%s renders', (_, f) => {
    render(<EnergyCard model={f.model} actions={{}} orientation={f.orientation} />)
    expect(screen.getByTestId('device-card').getAttribute('data-card-kind')).toBe('energy')
    expect(screen.getByTestId('dc-energy-node-solar')).toBeTruthy()
  })

  it('runs the grid into the bus at night and draws no battery without one', () => {
    const night = energyFixtures().find((f) => f.id === 'energy-night')
    const plain = energyFixtures().find((f) => f.id === 'energy-plain')
    if (night === undefined || plain === undefined) throw new Error('missing fixture')
    render(<EnergyCard model={night.model} actions={{}} />)
    const direction = (id: string): string | null =>
      screen.getByTestId(`dc-energy-branch-${id}`).getAttribute('data-direction')
    expect(direction('grid')).toBe('in')
    expect(direction('battery')).toBe('out')
    expect(direction('solar')).toBe('still')
    cleanup()
    render(<EnergyCard model={plain.model} actions={{}} />)
    expect(screen.queryByTestId('dc-energy-node-battery')).toBeNull()
    expect(screen.queryByTestId('dc-energy-node-heatPump')).toBeNull()
  })
})
