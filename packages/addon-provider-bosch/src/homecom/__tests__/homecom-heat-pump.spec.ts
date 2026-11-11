import { describe, expect, it } from 'vitest'
import { heatPumpInstantCop, HeatPumpStatusSchema } from '@camstack/types'
import {
  circuitOptionWrite,
  circuitRangeWrite,
  dhwChargeDurationWrite,
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
