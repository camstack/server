import { describe, it, expect } from 'vitest'
import {
  // B1 — binary sensor family
  contactCapability,
  ContactStatusSchema,
  floodCapability,
  FloodStatusSchema,
  smokeCapability,
  SmokeStatusSchema,
  carbonMonoxideCapability,
  CarbonMonoxideStatusSchema,
  gasCapability,
  GasStatusSchema,
  tamperCapability,
  TamperStatusSchema,
  vibrationCapability,
  VibrationStatusSchema,
  connectivityCapability,
  ConnectivityStatusSchema,
  binaryCapability,
  BinaryStatusSchema,
  // B2 — numeric single-metric
  temperatureSensorCapability,
  TemperatureSensorStatusSchema,
  humiditySensorCapability,
  HumiditySensorStatusSchema,
  ambientLightSensorCapability,
  AmbientLightSensorStatusSchema,
  pressureSensorCapability,
  PressureSensorStatusSchema,
  // B3 — multi-metric + generic
  powerMeterCapability,
  PowerMeterStatusSchema,
  airQualitySensorCapability,
  AirQualitySensorStatusSchema,
  numericSensorCapability,
  NumericSensorStatusSchema,
  enumSensorCapability,
  EnumSensorStatusSchema,
} from '../index.js'
import { DeviceType } from '../device/device-type.js'

describe('HA sensor cap family — phase B', () => {
  describe('B1 — binary sensor family', () => {
    const binaryCaps = [
      {
        cap: contactCapability,
        name: 'contact',
        schema: ContactStatusSchema,
        sample: { entryOpen: true, lastChangedAt: 1 },
      },
      {
        cap: floodCapability,
        name: 'flood',
        schema: FloodStatusSchema,
        sample: { flooded: false, lastChangedAt: 1 },
      },
      {
        cap: smokeCapability,
        name: 'smoke',
        schema: SmokeStatusSchema,
        sample: { detected: true, lastChangedAt: 1 },
      },
      {
        cap: carbonMonoxideCapability,
        name: 'carbon-monoxide',
        schema: CarbonMonoxideStatusSchema,
        sample: { detected: false, lastChangedAt: 0 },
      },
      {
        cap: gasCapability,
        name: 'gas',
        schema: GasStatusSchema,
        sample: { detected: true, lastChangedAt: 1 },
      },
      {
        cap: tamperCapability,
        name: 'tamper',
        schema: TamperStatusSchema,
        sample: { tampered: true, lastChangedAt: 1 },
      },
      {
        cap: vibrationCapability,
        name: 'vibration',
        schema: VibrationStatusSchema,
        sample: { detected: true, lastChangedAt: 1 },
      },
      {
        cap: connectivityCapability,
        name: 'connectivity',
        schema: ConnectivityStatusSchema,
        sample: { connected: true, lastChangedAt: 1 },
      },
      {
        cap: binaryCapability,
        name: 'binary',
        schema: BinaryStatusSchema,
        sample: { on: true, lastChangedAt: 1 },
      },
    ] as const

    it.each(binaryCaps)('$name: registers as push device-scoped sensor cap', ({ cap, name }) => {
      expect(cap.name).toBe(name)
      expect(cap.scope).toBe('device')
      expect(cap.mode).toBe('singleton')
      expect(cap.deviceTypes).toContain(DeviceType.Sensor)
      expect(cap.status.kind).toBe('push')
    })

    it.each(binaryCaps)('$name: status schema validates sample', ({ schema, sample }) => {
      expect(schema.parse(sample)).toEqual(sample)
    })

    it.each(binaryCaps)('$name: runtimeState matches status schema', ({ cap, schema }) => {
      expect(cap.runtimeState).toBe(schema)
    })
  })

  describe('B2 — numeric single-metric sensors', () => {
    const numericCaps = [
      {
        cap: temperatureSensorCapability,
        name: 'temperature-sensor',
        schema: TemperatureSensorStatusSchema,
        sample: { temperature: 21.5, lastFetchedAt: 1 },
      },
      {
        cap: humiditySensorCapability,
        name: 'humidity-sensor',
        schema: HumiditySensorStatusSchema,
        sample: { humidity: 55, lastFetchedAt: 1 },
      },
      {
        cap: ambientLightSensorCapability,
        name: 'ambient-light-sensor',
        schema: AmbientLightSensorStatusSchema,
        sample: { illuminance: 230, lastFetchedAt: 1 },
      },
      {
        cap: pressureSensorCapability,
        name: 'pressure-sensor',
        schema: PressureSensorStatusSchema,
        sample: { pressure: 1013.25, lastFetchedAt: 1 },
      },
    ] as const

    it.each(numericCaps)('$name: registers under Sensor deviceType', ({ cap }) => {
      expect(cap.deviceTypes).toContain(DeviceType.Sensor)
      expect(cap.status.kind).toBe('push')
    })

    it.each(numericCaps)('$name: schema validates sample + lastFetchedAt present', ({
      schema,
      sample,
    }) => {
      const parsed = schema.parse(sample)
      expect(parsed).toEqual(sample)
      expect('lastFetchedAt' in parsed).toBe(true)
    })

    it('humidity-sensor: rejects values outside 0..100', () => {
      expect(HumiditySensorStatusSchema.safeParse({ humidity: -1, lastFetchedAt: 0 }).success).toBe(
        false,
      )
      expect(
        HumiditySensorStatusSchema.safeParse({ humidity: 101, lastFetchedAt: 0 }).success,
      ).toBe(false)
    })

    it('ambient-light-sensor: rejects negative illuminance', () => {
      expect(
        AmbientLightSensorStatusSchema.safeParse({ illuminance: -1, lastFetchedAt: 0 }).success,
      ).toBe(false)
    })

    it('temperature-sensor lives on Thermostat devices too', () => {
      expect(temperatureSensorCapability.deviceTypes).toContain(DeviceType.Thermostat)
      expect(humiditySensorCapability.deviceTypes).toContain(DeviceType.Thermostat)
    })
  })

  describe('B3 — multi-metric + generic sensors', () => {
    it('power-meter accepts any subset of optional fields', () => {
      expect(PowerMeterStatusSchema.parse({ lastFetchedAt: 1 })).toEqual({ lastFetchedAt: 1 })
      expect(PowerMeterStatusSchema.parse({ power: 42, lastFetchedAt: 1 })).toEqual({
        power: 42,
        lastFetchedAt: 1,
      })
      expect(
        PowerMeterStatusSchema.parse({
          power: 42,
          energy: 100,
          voltage: 230,
          current: 0.18,
          apparentPower: 41.4,
          powerFactor: 0.99,
          lastFetchedAt: 1,
        }),
      ).toBeDefined()
    })

    it('power-meter rejects powerFactor outside [0,1]', () => {
      expect(PowerMeterStatusSchema.safeParse({ powerFactor: 1.2, lastFetchedAt: 0 }).success).toBe(
        false,
      )
    })

    it('air-quality-sensor accepts any subset of pollutant fields', () => {
      expect(AirQualitySensorStatusSchema.parse({ lastFetchedAt: 1 })).toEqual({ lastFetchedAt: 1 })
      expect(AirQualitySensorStatusSchema.parse({ co2: 800, lastFetchedAt: 1 })).toEqual({
        co2: 800,
        lastFetchedAt: 1,
      })
      expect(
        AirQualitySensorStatusSchema.parse({
          co2: 600,
          voc: 200,
          pm25: 12,
          pm10: 18,
          aqi: 35,
          lastFetchedAt: 1,
        }),
      ).toBeDefined()
    })

    it('air-quality-sensor rejects negative pollutant values', () => {
      expect(AirQualitySensorStatusSchema.safeParse({ co2: -10, lastFetchedAt: 0 }).success).toBe(
        false,
      )
      expect(AirQualitySensorStatusSchema.safeParse({ pm25: -1, lastFetchedAt: 0 }).success).toBe(
        false,
      )
    })

    it('numeric-sensor is a single-value passthrough', () => {
      expect(NumericSensorStatusSchema.parse({ value: 42.5, lastFetchedAt: 1 })).toEqual({
        value: 42.5,
        lastFetchedAt: 1,
      })
      expect(NumericSensorStatusSchema.safeParse({ value: 'x', lastFetchedAt: 1 }).success).toBe(
        false,
      )
    })

    it('enum-sensor is a single-string passthrough', () => {
      expect(EnumSensorStatusSchema.parse({ value: 'idle', lastFetchedAt: 1 })).toEqual({
        value: 'idle',
        lastFetchedAt: 1,
      })
      expect(EnumSensorStatusSchema.safeParse({ value: 42, lastFetchedAt: 1 }).success).toBe(false)
    })

    it.each([
      ['power-meter', powerMeterCapability],
      ['air-quality-sensor', airQualitySensorCapability],
      ['numeric-sensor', numericSensorCapability],
      ['enum-sensor', enumSensorCapability],
    ])('%s: registers as Sensor push cap', (name, cap) => {
      expect(cap.name).toBe(name)
      expect(cap.scope).toBe('device')
      expect(cap.deviceTypes).toContain(DeviceType.Sensor)
      expect(cap.status.kind).toBe('push')
    })
  })

  it('all 17 new caps have unique names', () => {
    const allCaps = [
      contactCapability,
      floodCapability,
      smokeCapability,
      carbonMonoxideCapability,
      gasCapability,
      tamperCapability,
      vibrationCapability,
      connectivityCapability,
      binaryCapability,
      temperatureSensorCapability,
      humiditySensorCapability,
      ambientLightSensorCapability,
      pressureSensorCapability,
      powerMeterCapability,
      airQualitySensorCapability,
      numericSensorCapability,
      enumSensorCapability,
    ]
    const names = allCaps.map((c) => c.name)
    expect(new Set(names).size).toBe(allCaps.length)
  })
})
