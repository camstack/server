import { describe, expect, it } from 'vitest'
import { heatPumpInstantCop, HeatPumpStatusSchema } from '@camstack/types'
import {
  circuitOptionWrite,
  circuitRangeWrite,
  dhwChargeDurationWrite,
  dhwOptionWrite,
  extraHotWaterWrite,
  heatPumpStatusFrom,
  HomeComHeatPumpRefusalError,
  readHeatPump,
  systemModeWrite,
} from '../homecom-heat-pump.js'
import { buildDiscoverables } from '../homecom-gateway.js'
import type { HomeComSystemSnapshot } from '../homecom-api-client.js'

/**
 * Recorded-shape PointT envelopes of a hydronic heat pump ({ value, minValue,
 * maxValue, allowedValues }). The paths are the unverified table of
 * homecom-heat-pump.ts; the spec pins the mapping, not the gateway.
 */

function envelope(value: unknown, extra: Record<string, unknown> = {}): unknown {
  return { value, ...extra }
}

function bodies(withElectrical: boolean): Record<string, unknown> {
  const all: Record<string, unknown> = {
    '/heatSources/hs1/silentMode': envelope('off', { allowedValues: ['off', 'auto', 'on'] }),
    '/system/awayMode': envelope('off', { allowedValues: ['off', 'on'] }),
    '/heatSources/hs1/additionalHeaterMode': envelope('auto', {
      allowedValues: ['off', 'manual', 'auto'],
    }),
    '/system/holidayMode': envelope('off', { allowedValues: ['off', 'hm1', 'hm2'] }),
    '/heatSources/hs1/heatPumpPower': envelope(9200),
    '/heatSources/hs1/compressorModulation': envelope(18),
    '/heatSources/hs1/supplyTemperature': envelope(59.7),
    '/heatSources/hs1/returnTemperature': envelope(52.3),
    '/system/sensors/temperatures/outdoor_t1': envelope(8.8),
    '/heatSources/hs1/waterPressure': envelope(1.8),
    '/heatSources/hs1/numberOfStarts': envelope(494),
    '/heatingCircuits/hc1/operationMode': envelope('manual', {
      allowedValues: ['off', 'manual', 'auto'],
    }),
    '/heatingCircuits/hc1/heatCoolMode': envelope('heating', {
      allowedValues: ['heating', 'cooling'],
    }),
    '/heatingCircuits/hc1/temperatureLevels/comfort2': envelope(21, { minValue: 5, maxValue: 30 }),
    '/heatingCircuits/hc1/maxSupplyTemperature': envelope(55, { minValue: 25, maxValue: 75 }),
    '/heatingCircuits/hc1/roomtemperature': envelope(20.1),
    '/heatingCircuits/hc1/currentRoomSetpoint': envelope(30),
    '/dhwCircuits/dhw1/operationMode': envelope('eco', {
      allowedValues: ['off', 'eco', 'comfort'],
    }),
    '/dhwCircuits/dhw1/currentTemperatureLevel': envelope('low', {
      allowedValues: ['off', 'low', 'high'],
    }),
    '/dhwCircuits/dhw1/charge/duration': envelope(60, { minValue: 15, maxValue: 240 }),
    '/dhwCircuits/dhw1/charge': envelope('stop', { allowedValues: ['start', 'stop'] }),
    '/dhwCircuits/dhw1/actualTemp': envelope(48.5),
  }
  if (withElectrical) all['/heatSources/hs1/electricalPower'] = envelope(2991)
  return all
}

async function read(withElectrical: boolean) {
  const table = bodies(withElectrical)
  return readHeatPump({
    get: async (path) => table[path] ?? null,
    circuitIds: { hc: ['hc1'], dhw: ['dhw1'] },
  })
}

describe('HomeCom heat pump mapping (D1026)', () => {
  it('maps every circuit with its label, kind and the values the gateway allowed', async () => {
    const status = heatPumpStatusFrom(await read(true), 1000)
    expect(HeatPumpStatusSchema.safeParse(status).success).toBe(true)
    expect(status.circuits.map((c) => [c.id, c.kind, c.label])).toEqual([
      ['hc1', 'heating', 'Heating circuit 1'],
      ['dhw1', 'dhw', 'Hot water'],
    ])
    expect(status.circuits[0]?.operationMode).toEqual({
      value: 'manual',
      allowed: ['off', 'manual', 'auto'],
    })
    expect(status.circuits[0]?.maxFlowTemp).toEqual({ value: 55, min: 25, max: 75, step: null })
    expect(status.system.holiday?.allowed).toEqual(['off', 'hm1', 'hm2'])
    expect(status.temperatures).toEqual({ supply: 59.7, return: 52.3, outdoor: 8.8 })
  })

  it('offers an empty holiday as off when the gateway listed off, and leaves a missing mode out', async () => {
    const reading = await readHeatPump({
      get: async (path) => {
        if (path === '/system/holidayMode') {
          return envelope('', { allowedValues: ['off', 'hm1'] })
        }
        if (path === '/system/awayMode') return envelope('off', { allowedValues: ['off', 'on'] })
        return null
      },
      circuitIds: { hc: [], dhw: [] },
    })
    const status = heatPumpStatusFrom(reading, 1)
    expect(status.system.holiday).toEqual({ value: 'off', allowed: ['off', 'hm1'] })
    expect(status.system.silent).toBeNull()
    expect(status.power.thermalW).toBeNull()
  })

  it('reads an absent resource as null, never 0', async () => {
    const status = heatPumpStatusFrom(await read(true), 1)
    expect(status.circuits[0]?.ecoSetpoint).toBeNull()
    expect(status.circuits[0]?.summerWinter).toBeNull()
    expect(status.energy).toEqual({ thermalKwh: null, electricalKwh: null })
  })

  it('has no COP when the electrical power is missing', async () => {
    const withBoth = heatPumpStatusFrom(await read(true), 1)
    expect(heatPumpInstantCop(withBoth.power)).toBeCloseTo(9200 / 2991, 5)
    const without = heatPumpStatusFrom(await read(false), 1)
    expect(without.power.electricalW).toBeNull()
    expect(heatPumpInstantCop(without.power)).toBeNull()
  })
})

describe('HomeCom heat pump writes are checked against the gateway limits', () => {
  it('sends an allowed value to the path the gateway answered on', async () => {
    const reading = await read(true)
    expect(systemModeWrite(reading, 'silent', 'auto')).toEqual({
      path: '/heatSources/hs1/silentMode',
      value: 'auto',
    })
    expect(circuitRangeWrite(reading, 'hc1', 'maxFlow', 60).value).toBe(60)
    expect(dhwOptionWrite(reading, 'dhw1', 'level', 'high').path).toBe(
      '/dhwCircuits/dhw1/currentTemperatureLevel',
    )
    expect(dhwChargeDurationWrite(reading, 'dhw1', 90).value).toBe(90)
    expect(extraHotWaterWrite(reading, 'dhw1')).toEqual({
      path: '/dhwCircuits/dhw1/charge',
      value: 'start',
    })
  })

  it('refuses a value outside allowedValues', async () => {
    const reading = await read(true)
    expect(() => systemModeWrite(reading, 'silent', 'loud')).toThrow(HomeComHeatPumpRefusalError)
    expect(() => circuitOptionWrite(reading, 'hc1', 'operationMode', 'turbo')).toThrow(
      HomeComHeatPumpRefusalError,
    )
  })

  it('refuses a number outside min and max, and a setting the gateway did not answer', async () => {
    const reading = await read(true)
    expect(() => circuitRangeWrite(reading, 'hc1', 'maxFlow', 90)).toThrow(/outside/)
    expect(() => dhwChargeDurationWrite(reading, 'dhw1', 5)).toThrow(/outside/)
    expect(() => circuitRangeWrite(reading, 'hc1', 'eco', 18)).toThrow(/not available/)
    expect(() => circuitOptionWrite(reading, 'hc1', 'summerWinter', 'summer')).toThrow(
      /not available/,
    )
  })

  it('refuses a setting that carries no allowed values (read-only)', async () => {
    const reading = await read(true)
    const readOnly = {
      ...reading,
      away: reading.away === null ? null : { ...reading.away, allowed: [] },
    }
    expect(() => systemModeWrite(readOnly, 'away', 'on')).toThrow(/read-only/)
  })

  it('refuses a circuit the gateway does not have', async () => {
    const reading = await read(true)
    expect(() => circuitOptionWrite(reading, 'hc9', 'operationMode', 'auto')).toThrow(
      /no hc circuit/,
    )
  })
})

describe('HomeCom heat pump discovery', () => {
  const base: HomeComSystemSnapshot = {
    gateway: { gatewayId: '1', name: 'K40', model: 'k40' },
    circuits: [],
    dhw: null,
    deviceType: 'k40',
    family: 'hydronic',
  }

  it('offers one heat pump only when a heat-pump reading exists', async () => {
    expect(buildDiscoverables(base).some((d) => d.kind === 'heat-pump')).toBe(false)
    const withReading = { ...base, heatPump: await read(true) }
    const picks = buildDiscoverables(withReading)
    expect(picks).toEqual([
      { nativeId: 'hp:0', name: 'Heat pump', kind: 'heat-pump', children: [] },
    ])
  })
})
