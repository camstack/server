/**
 * Weather station Customize: one scalar target per reading, `add` on a device with no
 * `weather-station` slice and a single-field `replace` on a native station. Targets of one cap
 * share one stored feature, so a target must own only its own path (no cross-field companion).
 */
import { describe, expect, it } from 'vitest'
import { WeatherStationStatusSchema } from '../../../capabilities/weather-station.cap.js'
import type { CompositionSourceRef } from '../../composition.js'
import { compileScalarOverride, type ScalarCompileInput } from '../scalar-compile.js'
import { decodeScalarOverride } from '../scalar-decode.js'
import { mergeScalarTarget } from '../scalar-merge.js'

const HOST: CompositionSourceRef = { addonId: 'provider-x', stableId: 'station-1' }
const TEMP_SENSOR: CompositionSourceRef = { addonId: 'provider-x', stableId: 'temp-1' }
const HUMIDITY_SENSOR: CompositionSourceRef = { addonId: 'provider-x', stableId: 'hum-1' }

function input(
  targetId: string,
  source: CompositionSourceRef,
  unit: string,
  apply: 'add' | 'replace',
): ScalarCompileInput {
  return {
    draft: {
      kind: 'scalar',
      cap: 'weather-station',
      targetId,
      source: { ...source, cap: 'numeric-sensor', fieldPath: 'value' },
      transform: { kind: 'identity' },
    },
    device: HOST,
    apply,
    sourceValueKind: 'number',
    changedAtField: null,
    sourceUnit: unit,
  }
}

function compiled(args: ScalarCompileInput) {
  const out = compileScalarOverride(args)
  if (!out.ok) throw new Error(`compile refused: ${out.reason}`)
  return out.value
}

describe.each(['add', 'replace'] as const)('two station readings assigned (%s)', (apply) => {
  const temperature = compiled(input('temperature', TEMP_SENSOR, '°C', apply))
  const humidity = compiled(input('humidity', HUMIDITY_SENSOR, '%', apply))
  const merged = mergeScalarTarget(
    mergeScalarTarget(null, temperature, 'weather-station', 'temperature'),
    humidity,
    'weather-station',
    'humidity',
  )

  it('keeps both readings and writes no other reading', () => {
    // add also supplies the clock the device lacks; replace keeps the native one
    const expected =
      apply === 'add' ? ['humidity', 'lastFetchedAt', 'temperature'] : ['humidity', 'temperature']
    expect(Object.keys(merged.fields).toSorted()).toEqual(expected)
    expect(merged.fields['temperature']).toEqual(temperature.fields['temperature'])
    expect(merged.fields['humidity']).toEqual(humidity.fields['humidity'])
  })

  it('decodes back to both rows', () => {
    for (const [targetId, source] of [
      ['temperature', TEMP_SENSOR],
      ['humidity', HUMIDITY_SENSOR],
    ] as const) {
      const decoded = decodeScalarOverride({
        feature: merged,
        device: HOST,
        cap: 'weather-station',
        targetId,
      })
      expect(decoded?.draft.source.stableId).toBe(source.stableId)
      expect(decoded?.apply).toBe(apply)
    }
  })
})

describe('a station slice built from two assigned readings', () => {
  it('leaves every other reading null, never 0', () => {
    const slice = WeatherStationStatusSchema.parse({
      temperature: 18,
      humidity: 60,
      lastFetchedAt: 1,
    })
    expect(slice.temperature).toBe(18)
    expect(slice.humidity).toBe(60)
    expect(slice.windSpeed).toBeNull()
    expect(slice.rainYearly).toBeNull()
    expect(slice.pressure).toBeNull()
  })
})
