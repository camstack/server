import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import {
  buildCapabilityLookup,
  planComposition,
  type Composition,
  type CompositionTargetDescription,
} from '../index.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const HOST = { addonId: 'provider-homeassistant', stableId: 'ha:dryer' }
const METER = { addonId: 'provider-homeassistant', stableId: 'ha:dryer-meter' }

function target(
  type: DeviceType,
  nativeCaps: Record<string, string> = {},
): CompositionTargetDescription {
  return { kind: 'found', deviceId: 5356, type, nativeCaps: new Map(Object.entries(nativeCaps)) }
}

function linkComposition(extra: Composition['features'] = []): Composition {
  return {
    target: { kind: 'existing', device: HOST },
    features: [
      { kind: 'capLink', cap: 'power-meter', linkId: 'meter-device', source: METER },
      ...extra,
    ],
  }
}

describe('planComposition: capLink (D1076)', () => {
  it('expands a project link to one identity read per host field, plus the clock', () => {
    const plan = planComposition(linkComposition(), lookupCap, target(DeviceType.Switch))
    expect(plan.problems).toEqual([])
    const power = plan.fields.find((f) => f.path === 'power')
    expect(power?.source).toEqual({
      kind: 'from',
      source: METER,
      cap: 'power-meter',
      fieldPath: 'power',
    })
    const clock = plan.fields.find((f) => f.path === 'lastFetchedAt')
    expect(clock?.source.kind).toBe('expression')
    expect(plan.fields.every((f) => f.cap === 'power-meter')).toBe(true)
  })

  it('plans nothing for a disabled link', () => {
    const plan = planComposition(
      {
        target: { kind: 'existing', device: HOST },
        features: [
          {
            kind: 'capLink',
            cap: 'power-meter',
            linkId: 'meter-device',
            source: METER,
            enabled: false,
          },
        ],
      },
      lookupCap,
      target(DeviceType.Switch),
    )
    expect(plan.problems).toEqual([])
    expect(plan.fields).toEqual([])
  })

  it('refuses a link the cap does not declare', () => {
    const plan = planComposition(
      {
        target: { kind: 'existing', device: HOST },
        features: [{ kind: 'capLink', cap: 'power-meter', linkId: 'nope', source: METER }],
      },
      lookupCap,
      target(DeviceType.Switch),
    )
    expect(plan.problems.map((p) => p.code)).toEqual(['link-undeclared'])
  })

  it('refuses a project link on a device that serves the cap itself', () => {
    const plan = planComposition(
      linkComposition(),
      lookupCap,
      target(DeviceType.Switch, { 'power-meter': 'some-addon' }),
    )
    expect(plan.problems.map((p) => p.code)).toContain('link-native')
  })

  it('refuses a device type the link is not offered on', () => {
    const plan = planComposition(linkComposition(), lookupCap, target(DeviceType.Sensor))
    expect(plan.problems.map((p) => p.code)).toContain('wrong-device-type')
  })

  it('refuses a plain feature that writes a field the link serves', () => {
    const plan = planComposition(
      linkComposition([
        {
          kind: 'fields',
          cap: 'power-meter',
          fields: {
            power: { kind: 'from', source: METER, cap: 'power-meter', fieldPath: 'power' },
          },
        },
      ]),
      lookupCap,
      target(DeviceType.Switch),
    )
    expect(plan.problems.map((p) => p.code)).toContain('link-overlaps-fields')
  })

  it('a reference link claims nothing', () => {
    const plan = planComposition(
      {
        target: { kind: 'existing', device: HOST },
        features: [{ kind: 'capLink', cap: 'energy-system', linkId: 'heat-pump', source: METER }],
      },
      lookupCap,
      target(DeviceType.Sensor),
    )
    expect(plan.problems).toEqual([])
    expect(plan.fields).toEqual([])
  })
})
