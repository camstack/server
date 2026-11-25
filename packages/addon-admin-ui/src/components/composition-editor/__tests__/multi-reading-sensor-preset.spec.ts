/**
 * The "Multi-reading sensor" preset: each reading the operator picks becomes
 * one measuring cap on ONE new sensor, and nothing picked builds nothing.
 */
import {
  buildHeroModel,
  type Composition,
  type CompositionSourceRef,
  DeviceRole,
  DeviceType,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { sensorLayoutOf } from '@camstack/ui-library'
import { missingSlots, presetById, type CompositionPreset } from '../composition-presets'

const ref = (stableId: string): CompositionSourceRef => ({
  addonId: 'ha',
  stableId,
})

function requirePreset(): CompositionPreset {
  const found = presetById('multi-reading-sensor')
  if (found === null) throw new Error('no multi-reading-sensor preset')
  return found
}

const preset = requirePreset()

const SLICES: Readonly<Record<string, unknown>> = {
  'temperature-sensor': { temperature: 21, lastFetchedAt: 1 },
  'humidity-sensor': { humidity: 50, lastFetchedAt: 1 },
  'ambient-light-sensor': { illuminance: 300, lastFetchedAt: 1 },
}

/** What the sensor card decides for the device this composition would create. */
function cardLayoutOf(composition: Composition | null) {
  if (composition === null) throw new Error('nothing built')
  const caps = composition.features.map((f) => f.cap)
  const role = composition.target.kind === 'new' ? (composition.target.role ?? null) : null
  const model = buildHeroModel({
    device: {
      id: 1,
      type: DeviceType.Sensor,
      role,
      name: 'Multi',
      online: true,
    },
    caps,
    features: [],
    slices: Object.fromEntries(caps.map((cap) => [cap, SLICES[cap]])),
    now: 2,
    remoteCommands: null,
    access: { canActuate: true },
  })
  return sensorLayoutOf(model)
}

describe('multi-reading sensor preset', () => {
  it('builds a device the sensor card draws as a pie, in the role order', () => {
    const layout = cardLayoutOf(
      preset.build({ humidity: ref('sensor.h'), temperature: ref('sensor.t') }),
    )
    expect(layout?.kind).toBe('pie')
    expect(layout?.kind === 'pie' ? layout.shown.map((m) => m.quantity) : []).toEqual([
      'temperature',
      'humidity',
    ])
  })

  it('refuses a single reading: one reading is not a pie', () => {
    expect(preset.build({ temperature: ref('sensor.t') })).toBeNull()
  })

  it('refuses an empty pick: nothing builds, and no slot is required on its own', () => {
    expect(preset.build({})).toBeNull()
    expect(missingSlots(preset, {})).toEqual([])
  })

  it('turns each picked reading into one cap on one new sensor', () => {
    const composition = preset.build({
      temperature: ref('sensor.t'),
      humidity: ref('sensor.h'),
      illuminance: ref('sensor.l'),
    })
    expect(composition?.target).toMatchObject({
      kind: 'new',
      type: DeviceType.Sensor,
    })
    expect(composition?.features.map((f) => f.cap)).toEqual([
      'temperature-sensor',
      'humidity-sensor',
      'ambient-light-sensor',
    ])
  })

  it('builds only the readings picked, led by the first one as the role', () => {
    const composition = preset.build({
      humidity: ref('sensor.h'),
      illuminance: ref('sensor.l'),
    })
    expect(composition?.features.map((f) => f.cap)).toEqual([
      'humidity-sensor',
      'ambient-light-sensor',
    ])
    expect(composition?.target).toMatchObject({
      role: DeviceRole.HumiditySensor,
    })
  })

  it('keeps each reading bound to the source picked for it, on the cap that carries its unit', () => {
    const composition = preset.build({
      temperature: ref('sensor.t'),
      humidity: ref('sensor.h'),
    })
    const temperature = composition?.features.find((f) => f.cap === 'temperature-sensor')
    const field = temperature?.kind === 'fields' ? temperature.fields.temperature : undefined
    expect(field).toEqual({
      kind: 'from',
      source: ref('sensor.t'),
      cap: 'temperature-sensor',
      fieldPath: 'temperature',
    })
    const humidity = composition?.features.find((f) => f.cap === 'humidity-sensor')
    expect(humidity?.kind === 'fields' ? humidity.fields.humidity : undefined).toMatchObject({
      source: ref('sensor.h'),
      fieldPath: 'humidity',
    })
  })
})
