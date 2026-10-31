/**
 * The power-source Customize extension: the link and the off time are read from
 * the STORED composition (D676), never kept as a second copy.
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../generated/customize-catalog.js'
import {
  buildCapabilityLookup,
  CompositionSchema,
  powerSourceLinkOfComposition,
  validateComposition,
  type Composition,
  type CompositionTargetDescription,
  type ValidateCompositionContext,
} from '../index.js'
import type { CompositionFieldsFeature, CompositionSourceRef } from '../composition.js'
import { compileScalarOverride } from '../customize/scalar-compile.js'

const GATEWAY: CompositionSourceRef = {
  addonId: 'provider-x',
  stableId: 'gw-1',
}
const PLUG: CompositionSourceRef = {
  addonId: 'provider-x',
  stableId: 'plug-1',
}

function compiledFeature() {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'power-source',
      targetId: 'switch',
      source: { ...PLUG, cap: 'switch', fieldPath: 'on' },
      transform: { kind: 'identity' },
    },
    device: GATEWAY,
    apply: 'add',
    sourceValueKind: 'boolean',
    changedAtField: null,
    sourceUnit: null,
  })
  if (!out.ok) throw new Error(`compile refused: ${out.reason}`)
  return out.value
}

function composition(feature = compiledFeature()): Composition {
  return CompositionSchema.parse({
    target: { kind: 'existing', device: GATEWAY },
    features: [feature],
  })
}

describe('the power-source declaration', () => {
  it('is an add target sourced from a switch, on devices that can hang', () => {
    const target = CAP_CUSTOMIZE_CATALOG['power-source']?.targets.find((t) => t.id === 'switch')
    expect(target?.apply).toBe('add')
    expect(target?.path).toBe('switchOn')
    expect(target?.deviceTypes).toContain(DeviceType.Gateway)
  })

  it('also lets a plug-fed appliance host the link', () => {
    const target = CAP_CUSTOMIZE_CATALOG['power-source']?.targets.find((t) => t.id === 'switch')
    for (const type of [
      DeviceType.Washer,
      DeviceType.Dryer,
      DeviceType.Dishwasher,
      DeviceType.PetFountain,
      DeviceType.Fan,
      DeviceType.Humidifier,
      DeviceType.Climate,
      DeviceType.WaterHeater,
    ]) {
      expect(target?.deviceTypes).toContain(type)
    }
  })
})

describe('powerSourceLinkOfComposition', () => {
  it('reads the switch and the default off time from a compiled customization', () => {
    expect(powerSourceLinkOfComposition(composition())).toEqual({
      device: GATEWAY,
      switch: PLUG,
      offSeconds: 10,
    })
  })

  it('reads a stored off time', () => {
    const base = compiledFeature()
    const stored: CompositionFieldsFeature = {
      ...base,
      fields: {
        ...base.fields,
        offSeconds: { kind: 'expression', expr: '45', bindings: {} },
      },
    }
    expect(powerSourceLinkOfComposition(composition(stored))?.offSeconds).toBe(45)
  })

  it('falls back to 10 when no off time is stored', () => {
    const base = compiledFeature()
    const { offSeconds: _drop, ...rest } = base.fields
    const link = powerSourceLinkOfComposition(composition({ ...base, fields: rest }))
    expect(link?.offSeconds).toBe(10)
  })

  it('CLAMPS an out-of-range off time to 3..120 instead of refusing the link', () => {
    const base = compiledFeature()
    const withOff = (expr: string) =>
      composition({
        ...base,
        fields: {
          ...base.fields,
          offSeconds: { kind: 'expression', expr, bindings: {} },
        },
      })
    expect(powerSourceLinkOfComposition(withOff('1'))?.offSeconds).toBe(3)
    expect(powerSourceLinkOfComposition(withOff('9999'))?.offSeconds).toBe(120)
    expect(powerSourceLinkOfComposition(withOff('7.6'))?.offSeconds).toBe(8)
    expect(powerSourceLinkOfComposition(withOff('"abc"'))?.offSeconds).toBe(10)
  })

  it('is null without a composition, for a new device, a disabled feature or another cap', () => {
    expect(powerSourceLinkOfComposition(null)).toBeNull()
    const fresh = CompositionSchema.parse({
      target: { kind: 'new', type: DeviceType.Sensor },
      features: [compiledFeature()],
    })
    expect(powerSourceLinkOfComposition(fresh)).toBeNull()
    expect(
      powerSourceLinkOfComposition(composition({ ...compiledFeature(), enabled: false })),
    ).toBeNull()
    const other = CompositionSchema.parse({
      target: { kind: 'existing', device: GATEWAY },
      features: [
        {
          kind: 'fields',
          cap: 'power-meter',
          fields: { power: { kind: 'expression', expr: '1', bindings: {} } },
        },
      ],
    })
    expect(powerSourceLinkOfComposition(other)).toBeNull()
  })
})

describe('the stored feature is a valid customization of a gateway', () => {
  const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
  const target: CompositionTargetDescription = {
    kind: 'found',
    deviceId: 50,
    type: DeviceType.Gateway,
    nativeCaps: new Map(),
  }
  const ctx: ValidateCompositionContext = {
    lookupCap,
    self: GATEWAY,
    blockId: null,
    peers: [],
    target,
    sources: new Map([
      [
        `${PLUG.addonId}/${PLUG.stableId}`,
        { kind: 'found', deviceId: 51, caps: new Set(['switch']) },
      ],
    ]),
  }

  it('plans as an add with no problem, with or without a stored off time', () => {
    const v = validateComposition(composition(), ctx)
    expect(v.problems).toEqual([])
    expect(v.features).toEqual([{ featureIndex: 0, cap: 'power-source', mode: 'add' }])
  })
})
