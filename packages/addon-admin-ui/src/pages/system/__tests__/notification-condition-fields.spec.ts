/**
 * The catalog↔form binding layer.
 *
 * The property under test is the one the catalog exists for: the server owns
 * the condition surface, so an id or a group the client has never seen must
 * degrade visibly, never silently — and must never be mapped onto a
 * neighbouring field.
 */
import type { NcConditionDescriptor } from '@camstack/types'
import { NC_CONDITION_CATALOG } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import {
  isAudioKey,
  isCrossingSelectKey,
  isDeviceIdExcludeListKey,
  isDeviceIdListKey,
  isDeviceStateKey,
  isNumber01Key,
  isNumberKey,
  isOccupancyKey,
  isPackagePhaseKey,
  isPlateMatcherKey,
  isSceneKey,
  isSensorTransitionKey,
  isSourceSelectKey,
  isStringListKey,
  isSystemEventKey,
  readNumber,
  readStringList,
} from '../notification-condition-fields'

function descriptor(overrides: Partial<NcConditionDescriptor>): NcConditionDescriptor {
  return {
    id: 'x',
    group: 'scope',
    label: 'X',
    valueType: 'stringList',
    operator: 'in',
    appliesTo: ['immediate'],
    phase: 'P1',
    ...overrides,
  }
}

describe('condition key guards', () => {
  it('accepts exactly the ids their value type can hold', () => {
    expect(isDeviceIdListKey('devices')).toBe(true)
    // D641: the exclusion is its own binding, never an alias of `devices`.
    expect(isDeviceIdExcludeListKey('devicesExclude')).toBe(true)
    expect(isDeviceIdListKey('devicesExclude')).toBe(false)
    expect(isStringListKey('classes')).toBe(true)
    expect(isStringListKey('sensorKinds')).toBe(true)
    expect(isNumber01Key('minLabelConfidence')).toBe(true)
    expect(isNumberKey('minDwellSeconds')).toBe(true)
    expect(isSourceSelectKey('source')).toBe(true)
    expect(isPackagePhaseKey('packagePhase')).toBe(true)
    expect(isCrossingSelectKey('crossing')).toBe(true)
    expect(isPlateMatcherKey('plates')).toBe(true)
    expect(isOccupancyKey('occupancy')).toBe(true)
  })

  it('rejects a NEW id of the same value type rather than aliasing the incumbent', () => {
    // `number` has exactly one condition today. A second one must not be
    // silently bound to `minDwellSeconds`.
    expect(isNumberKey('minLingerSeconds')).toBe(false)
    expect(isAudioKey('audioLevel')).toBe(false)
    expect(isPlateMatcherKey('platesExclude')).toBe(false)
  })

  it('does not treat inherited Object.prototype members as condition keys', () => {
    expect(isStringListKey('constructor')).toBe(false)
    expect(isNumberKey('toString')).toBe(false)
  })

  it('every catalog descriptor with a form key is bindable', () => {
    // A descriptor whose id nothing narrows falls through to the "not editable
    // here" note. `schedule` is rule-level (no NcConditions key), `customZones`
    // is not drawn (R9) and the zone pair is ONE scope field (D690) — everything
    // else is a binding this editor owes the operator.
    const bindable = (d: NcConditionDescriptor): boolean =>
      isDeviceIdListKey(d.id) ||
      isDeviceIdExcludeListKey(d.id) ||
      isCrossingSelectKey(d.id) ||
      isStringListKey(d.id) ||
      isNumber01Key(d.id) ||
      isNumberKey(d.id) ||
      isSourceSelectKey(d.id) ||
      isPackagePhaseKey(d.id) ||
      isPlateMatcherKey(d.id) ||
      isOccupancyKey(d.id) ||
      isDeviceStateKey(d.id) ||
      isSceneKey(d.id) ||
      isAudioKey(d.id) ||
      isSystemEventKey(d.id) ||
      isSensorTransitionKey(d.id)
    const unbound = NC_CONDITION_CATALOG.filter((d) => !bindable(d)).map((d) => d.id)
    expect(unbound).toEqual(['zones', 'zonesExclude', 'customZones', 'schedule'])
  })
})

describe('readers', () => {
  it('reads a string list, defaulting to empty', () => {
    expect(readStringList({ classes: ['person'] }, 'classes')).toEqual(['person'])
    expect(readStringList({}, 'sensorKinds')).toEqual([])
  })

  it('reads a number, keeping 0 and rejecting a non-number', () => {
    expect(readNumber({ minConfidence: 0 }, 'minConfidence')).toBe(0)
    expect(readNumber({}, 'minDwellSeconds')).toBeUndefined()
  })
})
