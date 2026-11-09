import { describe, expect, it } from 'vitest'
import {
  heatPumpInstantCop,
  HeatPumpStatusSchema,
  type HeatPumpCircuit,
  type HeatPumpStatus,
} from '../../../capabilities/heat-pump-status.cap.js'
import { DeviceType } from '../../device-type.js'
import { buildHeroModel } from '../build-hero-model.js'
import type { HeroControl, HeroModel, HeroRow } from '../hero-model.js'

function build(slice: HeatPumpStatus | undefined): HeroModel {
  return buildHeroModel({
    device: {
      id: 9,
      type: DeviceType.HeatPump,
      role: null,
      name: 'Pompa di calore',
      online: true,
    },
    caps: ['heat-pump-status', 'heat-pump-control'],
    features: [],
    slices: slice === undefined ? {} : { 'heat-pump-status': slice },
    now: 1_700_000_000_000,
    remoteCommands: null,
    access: { canActuate: true },
  })
}

const options = (value: string, allowed: readonly string[]) => ({
  value,
  allowed: [...allowed],
})
const range = (value: number) => ({ value, min: 5, max: 30, step: 0.5 })

function heating(id: string, label: string): HeatPumpCircuit {
  return {
    id,
    kind: 'heating',
    label,
    icon: 'flame',
    currentTemp: 20.1,
    targetTemp: 30,
    mode: 'manual',
    active: false,
    operationMode: options('manual', ['off', 'manual', 'auto']),
    heatCoolMode: options('heat', ['heat', 'cool']),
    summerWinter: null,
    comfortSetpoint: range(21),
    ecoSetpoint: range(17),
    maxFlowTemp: range(45),
    temperatureLevel: null,
    chargeDuration: null,
    extraHotWater: null,
  }
}

const DHW: HeatPumpCircuit = {
  ...heating('dhw1', 'Hot water'),
  kind: 'dhw',
  icon: 'droplets',
  active: true,
  operationMode: options('eco', ['off', 'eco', 'high']),
  temperatureLevel: options('high', ['off', 'low', 'high', 'eco']),
  chargeDuration: { value: 60, min: 60, max: 2880, step: 30 },
  extraHotWater: false,
}

const SOLAR: HeatPumpCircuit = {
  ...heating('sol1', 'Solar'),
  kind: 'solar',
  icon: 'sun',
  operationMode: null,
  targetTemp: null,
  mode: null,
}

const SLICE: HeatPumpStatus = {
  circuits: [heating('hc1', 'Circuit 1'), heating('hc2', 'Circuit 2'), DHW, SOLAR],
  system: {
    silent: options('off', ['off', 'auto', 'on']),
    away: options('off', ['off', 'on']),
    additionalHeater: options('auto', ['off', 'manual', 'auto']),
    holiday: options('off', ['off', 'hm1', 'hm2', 'hm3', 'hm4', 'hm5', 'hm6', 'hm7', 'hm8']),
  },
  power: { thermalW: 9200, electricalW: 2991, compressorPct: 18 },
  temperatures: { supply: 59.7, return: 52.3, outdoor: 8.8 },
  energy: { thermalKwh: null, electricalKwh: null },
  waterPressureBar: 1.8,
  starts: 494,
  lastFetchedAt: 1,
}

const rowsOf = (model: HeroModel, id: HeroRow['id']): readonly HeroRow[] =>
  model.rows.filter((row) => row.id === id)

const pickerOf = (row: HeroRow): Extract<HeroControl, { kind: 'picker' }> => {
  const control = row.controls[0]
  if (control === undefined || control.kind !== 'picker') throw new Error('no picker')
  return control
}

describe('heat pump hero (D1026)', () => {
  it('draws the compressor scene and every circuit as a row with its own label and icon', () => {
    const model = build(SLICE)
    expect(model.scene.id).toBe('heat-pump')
    const circuits = rowsOf(model, 'circuit')
    expect(circuits.map((r) => r.label?.en)).toEqual([
      'Circuit 1',
      'Circuit 2',
      'Hot water',
      'Solar',
    ])
    expect(circuits.map((r) => r.icon)).toEqual(['flame', 'flame', 'droplets', 'sun'])
  })

  it('draws as many circuits as the gateway reports', () => {
    const more = {
      ...SLICE,
      circuits: [...SLICE.circuits, heating('hc3', 'Circuit 3')],
    }
    expect(rowsOf(build(more), 'circuit')).toHaveLength(5)
  })

  it('sets a circuit through its own typed method, with the values the gateway allowed', () => {
    const model = build(SLICE)
    const [first, , dhw, solar] = rowsOf(model, 'circuit')
    if (first === undefined || dhw === undefined || solar === undefined) throw new Error('rows')
    const mode = pickerOf(first)
    expect(mode.call).toEqual({
      cap: 'heat-pump-control',
      method: 'setCircuitOperationMode',
      args: { circuitId: 'hc1' },
    })
    expect(mode.options).toEqual(['off', 'manual', 'auto'])
    const level = pickerOf(dhw)
    expect(level.call.method).toBe('setDhwTemperatureLevel')
    expect(level.valueArg).toBe('level')
    expect(level.options).toEqual(['off', 'low', 'high', 'eco'])
    expect(solar.controls).toEqual([])
  })

  it('shows the COP only when both powers are known, and never as 0', () => {
    const pill = (m: HeroModel) =>
      rowsOf(m, 'heat-pump-power')[0]?.pills?.map((p) => p.text.en) ?? []
    expect(pill(build(SLICE))).toEqual([
      'Thermal 9.2 kW',
      'Electrical 2.99 kW',
      'Instantaneous COP 3.1',
    ])
    const noElectrical = {
      ...SLICE,
      power: { ...SLICE.power, electricalW: null },
    }
    expect(pill(build(noElectrical)).some((t) => t.includes('COP'))).toBe(false)
    const idle = { ...SLICE, power: { ...SLICE.power, electricalW: 0 } }
    expect(pill(build(idle)).some((t) => t.includes('COP'))).toBe(false)
    const none = {
      ...SLICE,
      power: { thermalW: null, electricalW: null, compressorPct: null },
    }
    expect(rowsOf(build(none), 'heat-pump-power')).toEqual([])
  })

  it('draws a System group with one selector per mode and its real values', () => {
    const rows = rowsOf(build(SLICE), 'system-mode')
    expect(rows.map((r) => r.label?.en)).toEqual(['Silent', 'Away', 'Additional heater', 'Holiday'])
    expect(rows.every((r) => r.group?.en === 'System')).toBe(true)
    expect(rows.map((r) => pickerOf(r).call.method)).toEqual([
      'setSilentMode',
      'setAwayMode',
      'setAdditionalHeaterMode',
      'setHolidayMode',
    ])
    expect(pickerOf(rows[3] as HeroRow).options).toEqual([
      'off',
      'hm1',
      'hm2',
      'hm3',
      'hm4',
      'hm5',
      'hm6',
      'hm7',
      'hm8',
    ])
    expect(pickerOf(rows[0] as HeroRow).options).toEqual(['off', 'auto', 'on'])
  })

  it('draws no selector for a mode the gateway has no values for', () => {
    const bare = {
      ...SLICE,
      system: { ...SLICE.system, silent: null, away: options('off', []) },
    }
    expect(rowsOf(build(bare), 'system-mode').map((r) => r.label?.en)).toEqual([
      'Additional heater',
      'Holiday',
    ])
  })

  it('reads unknown, with no rows, when the slice has not answered', () => {
    const model = build(undefined)
    expect(model.state).toBe('unknown')
    expect(model.rows).toEqual([])
  })
})

describe('heat pump status cap (D1026)', () => {
  it('parses the fixture and keeps a missing reading null', () => {
    expect(HeatPumpStatusSchema.parse(SLICE).power.thermalW).toBe(9200)
    const parsed = HeatPumpStatusSchema.parse({
      ...SLICE,
      temperatures: { supply: null, return: null, outdoor: null },
    })
    expect(parsed.temperatures.supply).toBeNull()
  })

  it('computes the COP at read time from the two powers', () => {
    expect(
      heatPumpInstantCop({
        thermalW: 6000,
        electricalW: 2000,
        compressorPct: null,
      }),
    ).toBe(3)
    expect(
      heatPumpInstantCop({
        thermalW: null,
        electricalW: 2000,
        compressorPct: null,
      }),
    ).toBeNull()
    expect(
      heatPumpInstantCop({
        thermalW: 6000,
        electricalW: 0,
        compressorPct: null,
      }),
    ).toBeNull()
  })
})
