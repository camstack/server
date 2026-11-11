/**
 * The Dreo studio fan as production has it (D1034): the HA integration exposes
 * the axes as sibling devices — numeric `control`s 3364–3369 (angle, sweep
 * from/to per axis), a `control` select 3375 (the 3D preset) and the swing
 * `switch`es 3361/3362. `control.value` is a union of number and string: a
 * link is judged by the member that fits the target, and at save time by the
 * kind the linked control reads NOW.
 */
import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../../../generated/capability-router-map.js'
import { DeviceType } from '../../../device/device-type.js'
import { enumerateSchemaFields } from '../../../device/schema-fields.js'
import {
  buildCapabilityLookup,
  CompositionSchema,
  validateComposition,
  type CompositionSourceFound,
  type ValidateCompositionContext,
} from '../../index.js'
import type { CompositionFieldSource, CompositionSourceRef } from '../../composition.js'
import { evaluateCompositionField } from '../../evaluate-field.js'
import { compileScalarOverride, type ScalarCompileInput } from '../scalar-compile.js'
import { mergeScalarTarget } from '../scalar-merge.js'
import type { WireableScalarKind } from '../../../device/schema-fields.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const ha = (stableId: string): CompositionSourceRef => ({ addonId: 'homeassistant', stableId })
const FAN = ha('fan.studio')

/** Prod-shaped siblings of container 3360: [deviceId, stableId, cap]. */
const SIBLINGS = [
  [3361, 'switch.studio_h_swing', 'switch'],
  [3362, 'switch.studio_v_swing', 'switch'],
  [3364, 'number.studio_h_angle', 'control'],
  [3365, 'number.studio_h_sweep_from', 'control'],
  [3366, 'number.studio_h_sweep_to', 'control'],
  [3367, 'number.studio_v_angle', 'control'],
  [3368, 'number.studio_v_sweep_from', 'control'],
  [3369, 'number.studio_v_sweep_to', 'control'],
  [3375, 'select.studio_preset_3d', 'control'],
] as const

type LiveKinds = Readonly<Record<number, WireableScalarKind>>

/** Numeric controls read numbers, the select reads a string — unless a test says otherwise. */
const PROD_LIVE: LiveKinds = {
  3364: 'number',
  3365: 'number',
  3366: 'number',
  3367: 'number',
  3368: 'number',
  3369: 'number',
  3375: 'string',
}

function ctx(live: LiveKinds = PROD_LIVE): ValidateCompositionContext {
  const sources = new Map<string, CompositionSourceFound>(
    SIBLINGS.map(([deviceId, stableId, cap]) => {
      const kind = live[deviceId]
      return [
        `homeassistant/${stableId}`,
        {
          kind: 'found',
          deviceId,
          caps: new Set([cap]),
          ...(kind === undefined ? {} : { liveKinds: new Map([['control.value', kind]]) }),
        },
      ]
    }),
  )
  return {
    lookupCap,
    self: FAN,
    blockId: null,
    peers: [],
    target: {
      kind: 'found',
      deviceId: 3370,
      type: DeviceType.Fan,
      nativeCaps: new Map([['fan-control', 'homeassistant']]),
    },
    sources,
  }
}

function link(
  targetId: string,
  stableId: string,
  cap: string,
  fieldPath: string,
  sourceValueKind: ScalarCompileInput['sourceValueKind'],
) {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'fan-control',
      transform: { kind: 'identity' },
      targetId,
      source: { ...ha(stableId), cap, fieldPath },
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

/** Every prod link merged into the fan's one fan-control feature (D951). */
function prodFeature() {
  const links = [
    ['horizontal-oscillating', 'switch.studio_h_swing', 'switch', 'on', 'boolean'],
    ['vertical-oscillating', 'switch.studio_v_swing', 'switch', 'on', 'boolean'],
    ['horizontal-angle', 'number.studio_h_angle', 'control', 'value', 'number'],
    ['horizontal-sweepFrom', 'number.studio_h_sweep_from', 'control', 'value', 'number'],
    ['horizontal-sweepTo', 'number.studio_h_sweep_to', 'control', 'value', 'number'],
    ['vertical-angle', 'number.studio_v_angle', 'control', 'value', 'number'],
    ['vertical-sweepFrom', 'number.studio_v_sweep_from', 'control', 'value', 'number'],
    ['vertical-sweepTo', 'number.studio_v_sweep_to', 'control', 'value', 'number'],
    ['preset', 'select.studio_preset_3d', 'control', 'value', 'string'],
  ] as const
  return links.reduce<ReturnType<typeof link> | null>(
    (acc, [targetId, stableId, cap, path, kind]) =>
      mergeScalarTarget(acc, link(targetId, stableId, cap, path, kind), 'fan-control', targetId),
    null,
  )
}

function validate(live?: LiveKinds) {
  const c = CompositionSchema.parse({
    target: { kind: 'existing', device: FAN },
    features: [prodFeature()],
  })
  return validateComposition(c, ctx(live))
}

describe('control.value is an enumerated union', () => {
  it('reports its scalar members, so a picker can offer it by the live kind', () => {
    const schema = lookupCap('control')?.runtimeState
    if (schema === undefined) throw new Error('control has no runtimeState')
    const value = enumerateSchemaFields(schema).find((f) => f.path === 'value')
    expect(value?.kind).toBe('union')
    expect([...(value?.unionMembers ?? [])].sort()).toEqual(['number', 'string'])
  })
})

describe('the prod links plan', () => {
  it('links the six numeric controls, the select and both switches with no problem', () => {
    const v = validate()
    expect(v.problems).toEqual([])
    expect(v.features).toEqual([{ featureIndex: 0, cap: 'fan-control', mode: 'replace' }])
  })

  it('refuses a numeric control that reads a string NOW (the select linked as an angle)', () => {
    const v = validate({ ...PROD_LIVE, 3364: 'string' })
    expect(v.problems.map((p) => p.code)).toContain('source-kind-mismatch')
    expect(v.problems.find((p) => p.code === 'source-kind-mismatch')?.message).toContain('3364')
  })

  it('refuses the select linked to preset when it reads a number NOW', () => {
    const v = validate({ ...PROD_LIVE, 3375: 'number' })
    expect(v.problems.map((p) => p.code)).toEqual(['source-kind-mismatch'])
  })

  it('an unknown live kind is not a refusal (the member that fits decides)', () => {
    expect(validate({}).problems).toEqual([])
  })
})

describe('the read-time guard', () => {
  const source: CompositionFieldSource = {
    kind: 'from',
    source: ha('number.studio_h_angle'),
    cap: 'control',
    fieldPath: 'value',
  }

  it('a number field fed a string is unavailable, never a coerced value (D393)', () => {
    const out = evaluateCompositionField({
      source,
      read: () => ({ state: 'fresh', value: 'Preset 2' }),
      now: 0,
      targetKind: 'number',
    })
    expect(out.state).toBe('unavailable')
    expect(out.value).toBeNull()
    if (out.state === 'unavailable') expect(out.reason).toContain('source-kind-mismatch')
  })

  it('a number field fed a number passes it through', () => {
    const out = evaluateCompositionField({
      source,
      read: () => ({ state: 'fresh', value: 45 }),
      now: 0,
      targetKind: 'number',
    })
    expect(out).toMatchObject({ state: 'fresh', value: 45 })
  })
})
