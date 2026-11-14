/**
 * A thermostat's own `currentTemp` / `currentHumidity` can be REPLACED by a room
 * sensor the OPERATOR links in Customize. A linked sensor always wins, a null
 * native value included; a device with no link is not touched.
 */
import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../../../generated/capability-router-map.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../../generated/customize-catalog.js'
import { DeviceType } from '../../../device/device-type.js'
import {
  buildCapabilityLookup,
  CompositionSchema,
  validateComposition,
  type CompositionTargetDescription,
  type ValidateCompositionContext,
} from '../../index.js'
import type { CompositionSourceRef } from '../../composition.js'
import { compileScalarOverride } from '../scalar-compile.js'
import { decodeScalarOverride } from '../scalar-decode.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const THERMOSTAT: CompositionSourceRef = { addonId: 'homematic', stableId: 'hmip-wth-1' }
const SENSOR: CompositionSourceRef = { addonId: 'zigbee', stableId: 'room-1' }

const target: CompositionTargetDescription = {
  kind: 'found',
  deviceId: 40,
  type: DeviceType.Climate,
  nativeCaps: new Map([['climate-control', 'homematic']]),
}

const ctx: ValidateCompositionContext = {
  lookupCap,
  self: THERMOSTAT,
  blockId: null,
  peers: [],
  target,
  sources: new Map([
    [
      `${SENSOR.addonId}/${SENSOR.stableId}`,
      { kind: 'found', deviceId: 41, caps: new Set(['temperature-sensor']) },
    ],
  ]),
}

function link(targetId: 'room-temperature' | 'room-humidity') {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'climate-control',
      targetId,
      source: { ...SENSOR, cap: 'temperature-sensor', fieldPath: 'temperature' },
      transform: { kind: 'identity' },
    },
    device: THERMOSTAT,
    apply: 'replace',
    sourceValueKind: 'number',
    changedAtField: null,
    sourceUnit: null,
  })
  if (!out.ok) throw new Error(`compile refused: ${out.reason}`)
  return out.value
}

describe('climate-control room sensor', () => {
  it('declares exactly the two readings overridable, each by its own target', () => {
    expect(CAP_CUSTOMIZE_CATALOG['climate-control']?.overridable).toEqual([
      { path: 'currentTemp', by: 'room-temperature' },
      { path: 'currentHumidity', by: 'room-humidity' },
    ])
  })

  it.each([
    ['room-temperature', 'currentTemp'],
    ['room-humidity', 'currentHumidity'],
  ] as const)('%s replaces %s with the sensor reading, unconditionally', (id, field) => {
    const feature = link(id)
    expect(Object.keys(feature.fields)).toEqual([field])
    // No fallback to the native value: a null native is replaced too.
    expect(JSON.stringify(feature.fields[field])).not.toContain('native')
    const decoded = decodeScalarOverride({
      feature,
      device: THERMOSTAT,
      cap: 'climate-control',
      targetId: id,
    })
    expect(decoded?.apply).toBe('replace')
  })

  it('plans the link as a declared replace of the native climate-control, no problem', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: THERMOSTAT },
      features: [link('room-temperature')],
    })
    const v = validateComposition(c, ctx)
    expect(v.problems).toEqual([])
    expect(v.features).toEqual([{ featureIndex: 0, cap: 'climate-control', mode: 'replace' }])
  })

  it('an unlinked device plans nothing (no feature, no change)', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: THERMOSTAT },
      features: [],
    })
    const v = validateComposition(c, ctx)
    expect(v.problems).toEqual([])
    expect(v.features).toEqual([])
  })
})
