/**
 * The "Power and energy" extension (D951): ONE cap, several scalar targets,
 * each sourced from another device. Targets of one cap share one stored
 * feature, so a target writes and reads only the paths it owns.
 */
import { describe, expect, it } from 'vitest'
import { powerMeterCapability } from '../../../capabilities/power-meter.cap.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../../generated/customize-catalog.js'
import { DeviceType } from '../../../device/device-type.js'
import type { CompositionSourceRef } from '../../composition.js'
import { compileScalarOverride } from '../scalar-compile.js'
import { decodeScalarOverride } from '../scalar-decode.js'
import { mergeScalarTarget, removeScalarTarget, targetFeature } from '../scalar-merge.js'
import type { ScalarCompileInput } from '../scalar-compile.js'

const HOST: CompositionSourceRef = { addonId: 'provider-x', stableId: 'plug-1' }
const WATTS_SENSOR: CompositionSourceRef = { addonId: 'provider-x', stableId: 'plug-1-power' }
const KWH_SENSOR: CompositionSourceRef = { addonId: 'provider-x', stableId: 'plug-1-energy' }

function input(
  targetId: string,
  source: CompositionSourceRef,
  fieldPath: string,
  unit: string,
): ScalarCompileInput {
  return {
    draft: {
      kind: 'scalar',
      cap: 'power-meter',
      targetId,
      source: { ...source, cap: 'power-meter', fieldPath },
      transform: { kind: 'identity' },
    },
    device: HOST,
    apply: 'add',
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

describe('power-meter is a feature of any electrical device', () => {
  it('declares the loads that draw metered power, beyond sensors and appliances', () => {
    const types: readonly DeviceType[] = powerMeterCapability.deviceTypes
    for (const type of [
      DeviceType.Switch,
      DeviceType.Light,
      DeviceType.Fan,
      DeviceType.Climate,
      DeviceType.Thermostat,
      DeviceType.WaterHeater,
      DeviceType.MediaPlayer,
      DeviceType.Vacuum,
      DeviceType.Sensor,
    ]) {
      expect(types).toContain(type)
    }
  })

  it('offers a Customize target per reading, never on a bare sensor', () => {
    const entry = CAP_CUSTOMIZE_CATALOG['power-meter']
    expect(entry).toBeDefined()
    const ids = entry?.targets.map((target) => target.id)
    expect(ids).toEqual(['watts', 'kwhTotal', 'volts', 'amps'])
    for (const target of entry?.targets ?? []) {
      expect(target.cardinality).toBe('scalar')
      expect(target.apply).toBe('add')
      expect(target.deviceTypes).toContain(DeviceType.Switch)
      expect(target.deviceTypes).not.toContain(DeviceType.Sensor)
    }
  })
})

describe('two targets of one cap share one stored feature', () => {
  const watts = compiled(input('watts', WATTS_SENSOR, 'watts', 'W'))
  const energy = compiled(input('kwhTotal', KWH_SENSOR, 'kwhTotal', 'kWh'))

  it('merges the second target without losing the first', () => {
    const merged = mergeScalarTarget(
      mergeScalarTarget(null, watts, 'power-meter', 'watts'),
      energy,
      'power-meter',
      'kwhTotal',
    )
    expect(Object.keys(merged.fields).toSorted()).toEqual(['kwhTotal', 'lastFetchedAt', 'watts'])
    for (const [targetId, source] of [
      ['watts', WATTS_SENSOR],
      ['kwhTotal', KWH_SENSOR],
    ] as const) {
      const decoded = decodeScalarOverride({
        feature: merged,
        device: HOST,
        cap: 'power-meter',
        targetId,
      })
      expect(decoded?.draft.source.stableId).toBe(source.stableId)
    }
  })

  it('removing one target leaves the other, removing both leaves nothing', () => {
    const both = mergeScalarTarget(
      mergeScalarTarget(null, watts, 'power-meter', 'watts'),
      energy,
      'power-meter',
      'kwhTotal',
    )
    const onlyEnergy = removeScalarTarget(both, 'power-meter', 'watts')
    expect(onlyEnergy).not.toBeNull()
    expect(Object.keys(onlyEnergy?.fields ?? {}).toSorted()).toEqual(['kwhTotal', 'lastFetchedAt'])
    expect(removeScalarTarget(onlyEnergy, 'power-meter', 'kwhTotal')).toBeNull()
  })

  it('a target not stored reads as absent, not as the neighbour', () => {
    const only = mergeScalarTarget(null, watts, 'power-meter', 'watts')
    expect(
      decodeScalarOverride({
        feature: only,
        device: HOST,
        cap: 'power-meter',
        targetId: 'kwhTotal',
      }),
    ).toBeNull()
  })

  it('a feature stored for a neighbour is no assignment of this target', () => {
    const only = mergeScalarTarget(null, watts, 'power-meter', 'watts')
    expect(targetFeature(only, 'power-meter', 'kwhTotal')).toBeNull()
    expect(targetFeature(only, 'power-meter', 'watts')).toBe(only)
    expect(targetFeature(null, 'power-meter', 'watts')).toBeNull()
  })
})
