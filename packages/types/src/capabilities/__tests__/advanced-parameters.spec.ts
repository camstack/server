/**
 * D939 — derived advanced parameters from runtime Zod (top-level leaves only).
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ADVANCED_SHORT_STRING_MAX,
  collectCustomizeOwnedPaths,
  collectEventTimestampPaths,
  deriveAdvancedParameters,
  type DerivedAdvancedParameter,
} from '../advanced-parameters.js'
import { AmbientLightSensorStatusSchema } from '../ambient-light-sensor.cap.js'
import { BinaryStatusSchema } from '../binary.cap.js'
import { HumiditySensorStatusSchema } from '../humidity-sensor.cap.js'
import { PowerMeterStatusSchema } from '../power-meter.cap.js'
import { RunningStateStatusSchema, runningStateCapability } from '../running-state.cap.js'
import { SwitchStatusSchema } from '../switch.cap.js'
import { TemperatureSensorStatusSchema } from '../temperature-sensor.cap.js'

const owned = new Set(['percentage', 'running', 'cardPath'])
const eventTs = new Set<string>()

const synth = z.object({
  withUnit: z.number().meta({ unit: 'W', label: 'Power' }),
  bareNumber: z.number(),
  flag: z.boolean().meta({ label: 'Flag' }),
  mode: z.enum(['a', 'b']).meta({ label: 'Mode' }),
  unbounded: z.string(),
  short: z.string().min(1).max(ADVANCED_SHORT_STRING_MAX),
  longMax: z.string().max(200),
  lastFetchedAt: z.number(),
  lastPressedAt: z.number(),
  deviceId: z.string(),
  nested: z.object({ x: z.boolean() }),
  secretField: z.string().meta({ secret: true }),
  cardPath: z.boolean(),
})

describe('deriveAdvancedParameters', () => {
  it('allows number with unit, boolean, enum, and bounded short string', () => {
    const rows = deriveAdvancedParameters(synth, owned, eventTs)
    expect(rows.map((r) => r.path).toSorted()).toEqual(['flag', 'mode', 'short', 'withUnit'])
    expect(rows.find((r) => r.path === 'withUnit')).toMatchObject({
      kind: 'number',
      label: 'Power',
      unit: 'W',
    })
    expect(rows.find((r) => r.path === 'mode')?.enumValues).toEqual(['a', 'b'])
  })

  it('refuses number without unit, unbounded string, and max(200) string', () => {
    const rows = deriveAdvancedParameters(synth, owned, eventTs)
    expect(rows.some((r) => r.path === 'bareNumber')).toBe(false)
    expect(rows.some((r) => r.path === 'unbounded')).toBe(false)
    expect(rows.some((r) => r.path === 'longMax')).toBe(false)
  })

  it('always excludes bookkeeping, ids, secrets, nested, and card-owned paths', () => {
    const rows = deriveAdvancedParameters(synth, owned, eventTs)
    for (const path of [
      'lastFetchedAt',
      'lastPressedAt',
      'deviceId',
      'nested',
      'secretField',
      'cardPath',
    ]) {
      expect(rows.some((r) => r.path === path)).toBe(false)
    }
  })

  it('allows event timestamp paths when listed', () => {
    const rows = deriveAdvancedParameters(synth, owned, new Set(['lastPressedAt']))
    expect(rows.some((r) => r.path === 'lastPressedAt')).toBe(false)
  })

  it('excludes provenance enums named source, origin, or kind', () => {
    const schema = z.object({
      source: z.enum(['native', 'assigned']).meta({ label: 'Source' }),
      origin: z.enum(['hub', 'device']),
      kind: z.enum(['a', 'b']),
      mode: z.enum(['auto', 'manual']).meta({ label: 'Mode' }),
      flagged: z.boolean(),
    })
    const rows = deriveAdvancedParameters(schema, new Set(), new Set())
    expect(rows.map((row) => row.path).toSorted()).toEqual(['flagged', 'mode'])
  })

  it('drops running-state.source once the card owns running', () => {
    const spec = runningStateCapability.customize
    const rows = deriveAdvancedParameters(
      RunningStateStatusSchema,
      collectCustomizeOwnedPaths(spec),
      collectEventTimestampPaths(spec),
    )
    expect(rows.map((row) => row.path)).not.toContain('source')
  })
})

describe('derived parameters an operator could opt into', () => {
  function rows(schema: z.ZodObject<z.core.$ZodLooseShape>): readonly DerivedAdvancedParameter[] {
    return deriveAdvancedParameters(schema, new Set(), new Set())
  }

  it('derives temperature, humidity, illuminance, power and energy from schema meta', () => {
    expect(rows(TemperatureSensorStatusSchema)).toEqual([
      { path: 'celsius', kind: 'number', label: 'Temperature', unit: '°C' },
    ])
    expect(rows(HumiditySensorStatusSchema)).toEqual([
      { path: 'percent', kind: 'number', label: 'Humidity', unit: '%' },
    ])
    expect(rows(AmbientLightSensorStatusSchema)).toEqual([
      { path: 'lux', kind: 'number', label: 'Illuminance', unit: 'lx' },
    ])
    expect(rows(PowerMeterStatusSchema).map((row) => row.path)).toEqual(['kwhTotal', 'watts'])
    expect(rows(PowerMeterStatusSchema)).toEqual([
      { path: 'kwhTotal', kind: 'number', label: 'Energy', unit: 'kWh' },
      { path: 'watts', kind: 'number', label: 'Power', unit: 'W' },
    ])
  })

  it('puts switch.on and binary.on in Advanced when no card owns them', () => {
    expect(rows(SwitchStatusSchema)).toEqual([{ path: 'on', kind: 'boolean', label: 'On' }])
    expect(rows(BinaryStatusSchema)).toEqual([{ path: 'on', kind: 'boolean', label: 'On' }])
  })
})
