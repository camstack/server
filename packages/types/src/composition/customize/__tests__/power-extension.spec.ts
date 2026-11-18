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
      DeviceType.Climate,
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
    expect(ids).toEqual(['power', 'energy', 'voltage', 'current'])
    for (const target of entry?.targets ?? []) {
      expect(target.cardinality).toBe('scalar')
      expect(target.apply).toBe('add')
      expect(target.deviceTypes).toContain(DeviceType.Switch)
      expect(target.deviceTypes).not.toContain(DeviceType.Sensor)
    }
  })
})

describe('two targets of one cap share one stored feature', () => {
  const power = compiled(input('power', WATTS_SENSOR, 'power', 'W'))
  const energy = compiled(input('energy', KWH_SENSOR, 'energy', 'kWh'))

  it('merges the second target without losing the first', () => {
    const merged = mergeScalarTarget(
      mergeScalarTarget(null, power, 'power-meter', 'power'),
      energy,
      'power-meter',
      'energy',
    )
    expect(Object.keys(merged.fields).toSorted()).toEqual(['energy', 'lastFetchedAt', 'power'])
    for (const [targetId, source] of [
      ['power', WATTS_SENSOR],
      ['energy', KWH_SENSOR],
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
      mergeScalarTarget(null, power, 'power-meter', 'power'),
      energy,
      'power-meter',
      'energy',
    )
    const onlyEnergy = removeScalarTarget(both, 'power-meter', 'power')
    expect(onlyEnergy).not.toBeNull()
    expect(Object.keys(onlyEnergy?.fields ?? {}).toSorted()).toEqual(['energy', 'lastFetchedAt'])
    expect(removeScalarTarget(onlyEnergy, 'power-meter', 'energy')).toBeNull()
  })

  it('a target not stored reads as absent, not as the neighbour', () => {
    const only = mergeScalarTarget(null, power, 'power-meter', 'power')
    expect(
      decodeScalarOverride({
        feature: only,
        device: HOST,
        cap: 'power-meter',
        targetId: 'energy',
      }),
    ).toBeNull()
  })

  it('a feature stored for a neighbour is no assignment of this target', () => {
    const only = mergeScalarTarget(null, power, 'power-meter', 'power')
    expect(targetFeature(only, 'power-meter', 'energy')).toBeNull()
    expect(targetFeature(only, 'power-meter', 'power')).toBe(only)
    expect(targetFeature(null, 'power-meter', 'power')).toBeNull()
  })
})

describe('an operator edit of a link-contributed feature drops the stamp (D1063)', () => {
  const STAMP = { linkId: 'poe-power:x/port-7|x/plug-1' }
  const stampedPower = () => ({
    ...compiled(input('power', WATTS_SENSOR, 'power', 'W')),
    contributedBy: STAMP,
  })

  it('assigning ANOTHER target of the stamped feature leaves no stamp — the operator now owns the feature', () => {
    const operator = compiled(input('energy', KWH_SENSOR, 'energy', 'kWh'))
    const merged = mergeScalarTarget(stampedPower(), operator, 'power-meter', 'energy')
    expect(Object.keys(merged.fields)).toEqual(expect.arrayContaining(['power', 'energy']))
    expect(merged.contributedBy).toBeUndefined()
  })

  it('re-assigning the stamped target leaves no stamp', () => {
    const operator = compiled(input('power', KWH_SENSOR, 'power', 'W'))
    expect(
      mergeScalarTarget(stampedPower(), operator, 'power-meter', 'power').contributedBy,
    ).toBeUndefined()
  })

  it('the link re-stamping its own compile keeps its stamp', () => {
    const merged = mergeScalarTarget(stampedPower(), stampedPower(), 'power-meter', 'power')
    expect(merged.contributedBy).toEqual(STAMP)
  })

  it('removing a target leaves no stamp on what remains', () => {
    const both = mergeScalarTarget(
      stampedPower(),
      { ...compiled(input('energy', KWH_SENSOR, 'energy', 'kWh')), contributedBy: STAMP },
      'power-meter',
      'energy',
    )
    expect(both.contributedBy).toEqual(STAMP)
    expect(removeScalarTarget(both, 'power-meter', 'power')?.contributedBy).toBeUndefined()
  })
})
