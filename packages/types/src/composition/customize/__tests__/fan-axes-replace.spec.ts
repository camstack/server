/**
 * A fan's oscillation axes are linked by the OPERATOR, field by field, to
 * sibling devices (D1034): each axis leaf is a `replace` over a path the
 * fan-control cap lists in `overridable`. The angle link also carries the
 * axis limits from the linked control's own range; a select links to
 * `preset` and passes its string as it is.
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
import { compileScalarOverride, type ScalarCompileInput } from '../scalar-compile.js'
import { decodeScalarOverride } from '../scalar-decode.js'
import { mergeScalarTarget } from '../scalar-merge.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const FAN: CompositionSourceRef = { addonId: 'homeassistant', stableId: 'fan.studio' }
const ANGLE: CompositionSourceRef = { addonId: 'homeassistant', stableId: 'number.h_angle' }
const SWING: CompositionSourceRef = { addonId: 'homeassistant', stableId: 'switch.h_swing' }
const SELECT: CompositionSourceRef = { addonId: 'homeassistant', stableId: 'select.preset_3d' }

const ctx = (nativeCaps: Record<string, string>): ValidateCompositionContext => {
  const target: CompositionTargetDescription = {
    kind: 'found',
    deviceId: 3370,
    type: DeviceType.Fan,
    nativeCaps: new Map(Object.entries(nativeCaps)),
  }
  return {
    lookupCap,
    self: FAN,
    blockId: null,
    peers: [],
    target,
    sources: new Map([
      [
        `${ANGLE.addonId}/${ANGLE.stableId}`,
        { kind: 'found', deviceId: 3364, caps: new Set(['control']) },
      ],
      [
        `${SWING.addonId}/${SWING.stableId}`,
        { kind: 'found', deviceId: 3361, caps: new Set(['switch']) },
      ],
      [
        `${SELECT.addonId}/${SELECT.stableId}`,
        { kind: 'found', deviceId: 3375, caps: new Set(['control']) },
      ],
    ]),
  }
}

function compile(
  draft: Pick<ScalarCompileInput['draft'], 'targetId' | 'source'>,
  sourceValueKind: ScalarCompileInput['sourceValueKind'],
) {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'fan-control',
      transform: { kind: 'identity' },
      ...draft,
    },
    device: FAN,
    apply: 'replace',
    sourceValueKind,
    changedAtField: null,
    sourceUnit: null,
  })
  if (!out.ok) throw new Error(`compile refused: ${out.reason}`)
  return out.value
}

const angle = () =>
  compile(
    { targetId: 'horizontal-angle', source: { ...ANGLE, cap: 'control', fieldPath: 'value' } },
    'number',
  )
const swing = () =>
  compile(
    { targetId: 'horizontal-oscillating', source: { ...SWING, cap: 'switch', fieldPath: 'on' } },
    'boolean',
  )
const preset = () =>
  compile(
    { targetId: 'preset', source: { ...SELECT, cap: 'control', fieldPath: 'value' } },
    'string',
  )

describe('fan-control declares every axis leaf and preset overridable', () => {
  it('lists each axis field once, by its own target', () => {
    const overridable = CAP_CUSTOMIZE_CATALOG['fan-control']?.overridable ?? []
    expect(overridable).toContainEqual({
      path: 'oscillationAxes.vertical.sweepTo',
      by: 'vertical-sweepTo',
    })
    expect(overridable).toContainEqual({ path: 'preset', by: 'preset' })
    expect(overridable.map((o) => o.path)).not.toContain('oscillationAxes.horizontal.min')
  })
})

describe('the compiled axis links', () => {
  it('the angle link writes the angle and the limits from the SAME control', () => {
    const fields = angle().fields
    expect(Object.keys(fields).sort()).toEqual([
      'oscillationAxes.horizontal.angle',
      'oscillationAxes.horizontal.max',
      'oscillationAxes.horizontal.min',
      'oscillationAxes.horizontal.step',
    ])
    expect(JSON.stringify(fields['oscillationAxes.horizontal.max'])).toContain('"max"')
  })

  it('a select linked to preset passes its string through, never number(x)', () => {
    expect(JSON.stringify(preset().fields['preset'])).not.toContain('number(')
  })

  it.each([
    ['horizontal-angle', angle],
    ['horizontal-oscillating', swing],
    ['preset', preset],
  ] as const)('round-trips %s as a replace', (targetId, build) => {
    const decoded = decodeScalarOverride({
      feature: build(),
      device: FAN,
      cap: 'fan-control',
      targetId,
    })
    expect(decoded?.apply).toBe('replace')
    expect(decoded?.draft.targetId).toBe(targetId)
  })
})

/** The fan's ONE shared fan-control feature with the three links merged in (D951). */
function shared() {
  const withAngle = mergeScalarTarget(null, angle(), 'fan-control', 'horizontal-angle')
  const withSwing = mergeScalarTarget(withAngle, swing(), 'fan-control', 'horizontal-oscillating')
  return mergeScalarTarget(withSwing, preset(), 'fan-control', 'preset')
}

describe('the shared feature', () => {
  it.each([
    'horizontal-angle',
    'horizontal-oscillating',
    'preset',
  ])('decodes %s back out of the merged feature', (targetId) => {
    const decoded = decodeScalarOverride({
      feature: shared(),
      device: FAN,
      cap: 'fan-control',
      targetId,
    })
    expect(decoded?.apply).toBe('replace')
  })
})

describe('planning a nested axis leaf', () => {
  it('plans a declared replace of an axis leaf on the native fan, with no problem', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FAN },
      features: [swing()],
    })
    const v = validateComposition(c, ctx({ 'fan-control': 'homeassistant' }))
    expect(v.problems).toEqual([])
    expect(v.features).toEqual([{ featureIndex: 0, cap: 'fan-control', mode: 'replace' }])
  })

  it('refuses a replace that also writes the summary `oscillating`, which no link owns', () => {
    const base = swing()
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FAN },
      features: [
        {
          ...base,
          fields: {
            ...base.fields,
            oscillating: { kind: 'expression', expr: 'true', bindings: {} },
          },
        },
      ],
    })
    const v = validateComposition(c, ctx({ 'fan-control': 'homeassistant' }))
    // Not a declared replace, so it is planned as a whole fan-control — which is not composable.
    expect(v.problems.map((p) => p.code)).toEqual(['not-composable'])
    expect(v.features).toEqual([])
  })
})
