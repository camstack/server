import { describe, expect, it } from 'vitest'
import { DeviceType, heatPumpInstantCop, HeatPumpStatusSchema } from '@dominevo/types'
import {
  circuitControlTypeWrite,
  circuitIdentitiesFrom,
  circuitOptionWrite,
  circuitRangeWrite,
  dhwChargeDurationWrite,
  dhwLevelTempWrite,
  dhwOptionWrite,
  extraHotWaterWrite,
  hasSystemDevice,
  heatPumpReadingFrom,
  heatPumpStatusFrom,
  HomeComHeatPumpRefusalError,
  systemModeWrite,
} from '../homecom-heat-pump.js'
import { buildDiscoverables } from '../homecom-gateway.js'
import type { HomeComSystemSnapshot } from '../homecom-api-client.js'
import type { HomeComBridgeReading } from '../homecom-bridge.js'
import { k40Reading, setting } from './homecom-bridge-fixture.js'

function reading(patch: (r: HomeComBridgeReading) => HomeComBridgeReading = (r) => r) {
  return heatPumpReadingFrom(patch(k40Reading()))
}

describe('HomeCom heat pump mapping from the bridge (D1026)', () => {
  it('maps the heat-source values the K40 answered into the cap fields', () => {
    const status = heatPumpStatusFrom(reading(), 1000)
    expect(HeatPumpStatusSchema.safeParse(status).success).toBe(true)
    expect(status.power).toEqual({
      thermalW: null,
      electricalW: null,
      compressorPct: 89,
    })
    expect(status.temperatures).toEqual({
      supply: 52.2,
      return: 47.8,
      outdoor: 7.5,
    })
    expect(status.waterPressureBar).toBe(1.7)
    expect(status.starts).toBe(516)
  })

  it('keeps a refused meter null, never 0, and has no COP without both powers', () => {
    const status = heatPumpStatusFrom(reading(), 1000)
    expect(status.energy).toEqual({ thermalKwh: null, electricalKwh: null })
    expect(status.system.silent).toBeNull()
    expect(status.system.additionalHeater).toBeNull()
    expect(heatPumpInstantCop(status.power)).toBeNull()
  })

  it('maps the energy totals when the gateway answers them', () => {
    const status = heatPumpStatusFrom(
      reading((r) => ({
        ...r,
        heatSource: { ...r.heatSource, thermalKwh: 9000, electricalKwh: 2512 },
      })),
      1,
    )
    expect(status.energy).toEqual({ thermalKwh: 9000, electricalKwh: 2512 })
  })

  it('maps every circuit with its label, kind, target and allowed values', () => {
    const [hc, dhw] = heatPumpStatusFrom(reading(), 1).circuits
    expect(hc).toMatchObject({
      id: 'hc1',
      kind: 'heating',
      label: 'Heating circuit 1',
      currentTemp: 21.4,
      targetTemp: 30,
      mode: 'manual',
      heatCoolMode: { value: 'heat', allowed: ['heat', 'cool', 'heatCool'] },
      maxFlowTemp: { value: 60, min: 30, max: 60, step: null },
      comfortSetpoint: null,
    })
    expect(dhw).toMatchObject({
      id: 'dhw1',
      kind: 'dhw',
      label: 'Hot water',
      currentTemp: 48,
      targetTemp: 51,
      temperatureLevel: { value: 'eco' },
      chargeDuration: { value: 60, min: 60, max: 2880 },
      extraHotWater: false,
    })
  })

  it('shows a circuit in heat/cool mode cool as cooling, on its cooling setpoint', () => {
    const [hc] = heatPumpStatusFrom(
      reading((r) => ({
        ...r,
        heatingCircuits: r.heatingCircuits.map((c) => ({
          ...c,
          heatCoolMode: setting('cool', { allowed: ['heat', 'cool'] }),
          coolingRoomSetpoint: setting(24, { min: 18, max: 30 }),
        })),
      })),
      1,
    ).circuits
    expect(hc?.kind).toBe('cooling')
    expect(hc?.targetTemp).toBe(24)
  })

  it('offers an empty holiday as none when the gateway listed no off', () => {
    expect(heatPumpStatusFrom(reading(), 1).system.holiday).toEqual({
      value: 'none',
      allowed: [],
    })
  })
})

describe('HomeCom heat pump writes are named ops, checked against the gateway', () => {
  it('names the op and the circuit of an accepted value', () => {
    const r = reading()
    expect(systemModeWrite(r, 'away', 'on')).toEqual({
      op: 'awayMode',
      value: 'on',
    })
    expect(circuitOptionWrite(r, 'hc1', 'operationMode', 'auto')).toEqual({
      op: 'hcOperationMode',
      circuitId: 'hc1',
      value: 'auto',
    })
    expect(circuitRangeWrite(r, 'hc1', 'maxFlow', 45)).toEqual({
      op: 'hcMaxFlowTemp',
      circuitId: 'hc1',
      value: 45,
    })
    expect(dhwOptionWrite(r, 'dhw1', 'operationMode', 'high')).toEqual({
      op: 'dhwOperationMode',
      circuitId: 'dhw1',
      value: 'high',
    })
    expect(dhwChargeDurationWrite(r, 'dhw1', 120)).toEqual({
      op: 'dhwChargeDuration',
      circuitId: 'dhw1',
      value: 120,
    })
    expect(extraHotWaterWrite(r, 'dhw1')).toEqual({
      op: 'dhwCharge',
      circuitId: 'dhw1',
      value: 'start',
    })
  })

  it('refuses a setting the gateway marks read-only, even with allowed values', () => {
    const r = reading()
    expect(() => circuitOptionWrite(r, 'hc1', 'heatCoolMode', 'cool')).toThrow(/read-only/)
    expect(() => dhwOptionWrite(r, 'dhw1', 'level', 'high')).toThrow(/read-only/)
  })

  it('refuses a value outside allowedValues or the limits, and a refused setting', () => {
    const r = reading()
    expect(() => systemModeWrite(r, 'away', 'maybe')).toThrow(/not an accepted value/)
    expect(() => circuitRangeWrite(r, 'hc1', 'maxFlow', 75)).toThrow(/outside/)
    expect(() => systemModeWrite(r, 'silent', 'on')).toThrow(/not available/)
    expect(() => circuitRangeWrite(r, 'hc1', 'comfort', 21)).toThrow(HomeComHeatPumpRefusalError)
  })

  it('refuses a circuit the gateway does not have', () => {
    expect(() => circuitOptionWrite(reading(), 'hc2', 'operationMode', 'auto')).toThrow(
      /no hc circuit hc2/,
    )
  })
})

describe('HomeCom heat pump discovery', () => {
  const boiler = (r: HomeComBridgeReading): HomeComBridgeReading => ({
    ...r,
    heatSource: { ...r.heatSource, heatPumpType: null },
    heatingCircuits: r.heatingCircuits.map((c) => ({
      ...c,
      heatCoolMode: setting('heat', { allowed: ['heat'] }),
    })),
  })

  it('is a heat pump on its heat-pump type alone', () => {
    expect(hasSystemDevice(reading())).toBe(true)
  })

  it('keeps a boiler a boiler although it answers away, holiday, flow, pressure and starts', () => {
    expect(hasSystemDevice(reading(boiler))).toBe(false)
  })

  it('recognises a heat pump from a circuit that can cool, or from the silent mode', () => {
    const cooling = (r: HomeComBridgeReading): HomeComBridgeReading => ({
      ...boiler(r),
      heatingCircuits: r.heatingCircuits.map((c) => ({
        ...c,
        heatCoolMode: setting('heat', { allowed: ['heat', 'cool'] }),
      })),
    })
    expect(hasSystemDevice(reading(cooling))).toBe(true)
    const silent = (r: HomeComBridgeReading): HomeComBridgeReading => ({
      ...boiler(r),
      system: {
        ...r.system,
        silent: setting('off', { allowed: ['on', 'off'] }),
      },
    })
    expect(hasSystemDevice(reading(silent))).toBe(true)
  })

  it('offers one heat pump only when a heat-pump reading exists', () => {
    const base: HomeComSystemSnapshot = {
      gateway: { gatewayId: '1', name: 'K40', model: 'k40' },
      circuits: [],
      dhw: null,
      deviceType: 'k40',
      family: 'hydronic',
    }
    expect(buildDiscoverables(base).some((d) => d.kind === 'heat-pump')).toBe(false)
    const picks = buildDiscoverables({ ...base, heatPump: reading() })
    expect(picks.map((p) => p.nativeId)).toEqual(['gateway:0', 'hp:0'])
  })
})

describe('HomeCom heat pump batch A (planning#741)', () => {
  it('starts extra hot water when the charge is unreadable, refuses when it is read-only', () => {
    const unreadable = reading((r) => ({
      ...r,
      dhwCircuits: r.dhwCircuits.map((d) => ({ ...d, charge: null })),
    }))
    expect(extraHotWaterWrite(unreadable, 'dhw1')).toEqual({
      op: 'dhwCharge',
      circuitId: 'dhw1',
      value: 'start',
    })
    const readOnly = reading((r) => ({
      ...r,
      dhwCircuits: r.dhwCircuits.map((d) => ({
        ...d,
        charge: setting('stop', { allowed: ['start', 'stop'], writeable: false }),
      })),
    }))
    expect(() => extraHotWaterWrite(readOnly, 'dhw1')).toThrow(/read-only/)
    expect(() => extraHotWaterWrite(unreadable, 'dhw9')).toThrow(/no dhw circuit/)
  })

  it('carries the gateway stepSize into a range, null when it gave none', () => {
    const stepped = reading((r) => ({
      ...r,
      heatingCircuits: r.heatingCircuits.map((c) => ({
        ...c,
        maxFlowTemp: setting(60, { min: 30, max: 60, writeable: true, step: 0.5 }),
        ecoSetpoint: setting(18, { min: 10, max: 25, writeable: true }),
      })),
    }))
    const circuit = heatPumpStatusFrom(stepped, 1).circuits.find((c) => c.id === 'hc1')
    expect(circuit?.maxFlowTemp?.step).toBe(0.5)
    expect(circuit?.ecoSetpoint?.step).toBeNull()
  })

  it('writes holiday off as the empty value when the gateway lists the empty value', () => {
    const r = reading((x) => ({
      ...x,
      system: {
        ...x.system,
        holiday: setting('', { allowed: ['', 'hm1', 'hm2'], writeable: true }),
      },
    }))
    expect(systemModeWrite(r, 'holiday', 'off')).toEqual({ op: 'holidayMode', value: '' })
    expect(systemModeWrite(r, 'holiday', 'hm1')).toEqual({ op: 'holidayMode', value: 'hm1' })
  })
})

describe('HomeCom heat pump batch B (planning#741)', () => {
  const identities = new Map([
    ['hc1', { deviceId: 5631, label: 'Living room' }],
    ['dhw1', { deviceId: 5633, label: 'Boiler' }],
  ])

  it('maps working time, heat demand, heat source type and the compressor from the heat source', () => {
    const status = heatPumpStatusFrom(
      reading((r) => ({
        ...r,
        heatSource: {
          ...r.heatSource,
          workingTimeS: 36_000,
          heatDemand: 'dhw',
          compressorRunning: true,
        },
      })),
      1,
    )
    expect(status).toMatchObject({
      workingTime: 36_000,
      heatDemand: 'dhw',
      heatSourceType: 'air_water',
      compressorRunning: true,
    })
    expect(HeatPumpStatusSchema.safeParse(status).success).toBe(true)
  })

  it('keeps an unanswered working time, demand and compressor null', () => {
    const status = heatPumpStatusFrom(
      reading((r) => ({
        ...r,
        heatSource: { ...r.heatSource, heatDemand: null },
      })),
      1,
    )
    expect(status.workingTime).toBeNull()
    expect(status.heatDemand).toBeNull()
    expect(status.compressorRunning).toBeNull()
  })

  it('adds the solar circuit as a circuit entry with its collector, tank limit and yield', () => {
    const status = heatPumpStatusFrom(
      reading((r) => ({
        ...r,
        solarCircuits: [
          {
            id: 'sc1',
            collectorTemp: 72.5,
            tankTemp: 48,
            tankBottomTemp: 41,
            maxCylinderTemp: 60,
            yieldKwh: 1234.5,
          },
        ],
      })),
      1,
    )
    const solar = status.circuits.find((c) => c.id === 'sc1')
    expect(solar).toMatchObject({
      kind: 'solar',
      label: 'Solar',
      currentTemp: 72.5,
      tankBottomTemp: 41,
      maxCylinderTemp: 60,
      yieldKwh: 1234.5,
      deviceId: null,
      operationMode: null,
    })
    expect(HeatPumpStatusSchema.safeParse(status).success).toBe(true)
  })

  it('carries the control type, and the temperature of each hot-water level', () => {
    const status = heatPumpStatusFrom(
      reading((r) => ({
        ...r,
        heatingCircuits: r.heatingCircuits.map((c) => ({
          ...c,
          controlType: setting('wdcoptimized', {
            allowed: ['wdcoptimized', 'ISRC'],
            writeable: true,
          }),
        })),
      })),
      1,
    )
    const [hc, dhw] = status.circuits
    expect(hc?.controlType).toEqual({ value: 'wdcoptimized', allowed: ['wdcoptimized', 'ISRC'] })
    expect(dhw?.levelTemperatures).toEqual({
      eco: { value: 51, min: 30, max: 60, step: null },
    })
  })

  it('names the registry child that owns a circuit, and takes its name as the label', () => {
    const [hc, dhw] = heatPumpStatusFrom(reading(), 1, identities).circuits
    expect(hc).toMatchObject({ deviceId: 5631, label: 'Living room' })
    expect(dhw).toMatchObject({ deviceId: 5633, label: 'Boiler' })
    const [bare] = heatPumpStatusFrom(reading(), 1).circuits
    expect(bare).toMatchObject({ deviceId: null, label: 'Heating circuit 1' })
  })

  it('writes the control type and the level temperature, refusing outside what the gateway allows', () => {
    const r = reading((x) => ({
      ...x,
      heatingCircuits: x.heatingCircuits.map((c) => ({
        ...c,
        controlType: setting('wdcoptimized', {
          allowed: ['wdcoptimized', 'ISRC'],
          writeable: true,
        }),
      })),
    }))
    expect(circuitControlTypeWrite(r, 'hc1', 'ISRC')).toEqual({
      op: 'hcControlType',
      circuitId: 'hc1',
      value: 'ISRC',
    })
    expect(() => circuitControlTypeWrite(r, 'hc1', 'nope')).toThrow(/not an accepted value/)
    expect(() => circuitControlTypeWrite(reading(), 'hc1', 'ISRC')).toThrow(/not available/)

    expect(dhwLevelTempWrite(r, 'dhw1', 'eco', 55)).toEqual({
      op: 'dhwLevelTemp',
      circuitId: 'dhw1',
      level: 'eco',
      value: 55,
    })
    expect(() => dhwLevelTempWrite(r, 'dhw1', 'eco', 65)).toThrow(/outside/)
    expect(() => dhwLevelTempWrite(r, 'dhw1', 'high', 55)).toThrow(/no level/)
    expect(() => dhwLevelTempWrite(r, 'dhw9', 'eco', 55)).toThrow(/no dhw circuit/)
  })

  it('maps registry children onto circuits: a climate child by its circuit, the water heater to the first hot-water circuit', () => {
    const circuits = reading().circuits
    const found = circuitIdentitiesFrom(
      [
        { id: 5631, name: 'Living room', type: DeviceType.Climate, config: { circuitId: 'hc1' } },
        { id: 5632, name: 'Elsewhere', type: DeviceType.Climate, config: { circuitId: 'hc9' } },
        { id: 5633, name: 'Boiler', type: DeviceType.WaterHeater, config: {} },
        { id: 5634, name: 'Other', type: DeviceType.Climate, config: {} },
      ],
      circuits,
    )
    expect([...found]).toEqual([
      ['hc1', { deviceId: 5631, label: 'Living room' }],
      ['dhw1', { deviceId: 5633, label: 'Boiler' }],
    ])
  })
})
