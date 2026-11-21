import {
  ALL_CAPABILITY_DEFINITIONS,
  DeviceType,
  buildCapabilityLookup,
  expandCapLinks,
  planComposition,
  topLevelFieldsOf,
  type Composition,
  type CompositionTargetDescription,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { storedPeers } from '../composition-peers.js'
import { HOST_REF, METER_REF, block, fullMeterFields } from './cap-links-fixtures.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const TARGET: CompositionTargetDescription = {
  kind: 'found',
  deviceId: 5356,
  type: DeviceType.Switch,
  nativeCaps: new Map(),
}
const LINK: Composition = {
  target: { kind: 'existing', device: HOST_REF },
  features: [{ kind: 'capLink', cap: 'power-meter', linkId: 'meter-device', source: METER_REF }],
}

describe('a capLink composes like the per-field links it replaces (D1076)', () => {
  it('claims the same values the explicit per-field feature claimed', () => {
    const explicit: Composition = {
      target: LINK.target,
      features: [{ kind: 'fields', cap: 'power-meter', fields: fullMeterFields() }],
    }
    const linked = planComposition(LINK, lookupCap, TARGET)
    const old = planComposition(explicit, lookupCap, TARGET)
    expect(linked.problems).toEqual([])
    const valuesOf = (plan: typeof linked) => plan.fields.map((f) => [f.path, f.source]).sort()
    expect(valuesOf(linked)).toEqual(valuesOf(old))
  })

  it('removing the link restores the native state: nothing is claimed', () => {
    const without = planComposition({ ...LINK, features: [] }, lookupCap, TARGET)
    expect(without.fields).toEqual([])
  })

  it('a stored link is a graph peer reading its source, as its fields would', () => {
    const { peers } = storedPeers(
      [block('b1', LINK)],
      new Map([['provider-homeassistant/ha:dryer', TARGET]]),
      lookupCap,
      null,
    )
    const features = peers[0]?.composition.features ?? []
    expect(features.every((f) => f.kind === 'fields')).toBe(true)
    expect(expandCapLinks(LINK, (cap) => topLevelFieldsOf(cap, lookupCap)).features[0]?.kind).toBe(
      'fields',
    )
  })
})
