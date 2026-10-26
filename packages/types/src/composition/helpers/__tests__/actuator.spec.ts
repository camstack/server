/**
 * Actuator groups (D944 phase 1b). Unknown members are not off. A command
 * reaches every member that binds the cap, and one throw does not cancel
 * the rest. A light exposes only the caps every member binds.
 */
import { describe, expect, it } from 'vitest'
import { groupStatusCapability } from '../../../capabilities/group-status.cap.js'
import { switchCapability } from '../../../capabilities/switch.cap.js'
import { DeviceFeature, DeviceType } from '../../../device/device-type.js'
import {
  type Composition,
  CompositionSchema,
  compositionSourceKey,
  type CompositionSourceRef,
} from '../../composition.js'
import {
  buildCapabilityLookup,
  type CompositionSourceDescription,
  type ValidateCompositionContext,
  validateComposition,
} from '../../validate-composition.js'
import { evaluateAggregate } from '../aggregate.js'
import {
  fanOutTargets,
  reducerForActive,
  runFanOut,
  sharedColorModes,
  sharedLightCaps,
} from '../actuator.js'
import { compileHelper } from '../compile.js'
import { type GroupHelperSpec, type HelperMember } from '../spec.js'

const lookupCap = buildCapabilityLookup([switchCapability, groupStatusCapability])

function ref(n: number): CompositionSourceRef {
  return { addonId: 'provider-homeassistant', stableId: `switch-${n}` }
}

function member(n: number): HelperMember {
  return { source: ref(n), cap: 'switch', fieldPath: 'on' }
}

function actuator(
  templateId: 'switch' | 'light',
  active: 'at-least-one' | 'all',
  members: readonly HelperMember[],
): GroupHelperSpec {
  return {
    kind: 'group',
    templateId,
    aggregate: reducerForActive(active),
    active,
    members: [...members],
  }
}

function context(composition: Composition, deviceType: DeviceType): ValidateCompositionContext {
  const sources = new Map<string, CompositionSourceDescription>()
  const members =
    composition.helper === undefined
      ? []
      : composition.helper.kind === 'group'
        ? composition.helper.members
        : [composition.helper.member]
  for (const [index, item] of members.entries()) {
    sources.set(compositionSourceKey(item.source), {
      kind: 'found',
      deviceId: 5000 + index,
      caps: new Set(['switch', 'brightness', 'color']),
      deviceType,
    })
  }
  return { lookupCap, sources, self: null, blockId: null, target: null, peers: [] }
}

describe('active criterion', () => {
  it('counts a fresh on and leaves unknown members out, never as off', () => {
    const outcome = evaluateAggregate({
      reducer: reducerForActive('at-least-one'),
      publish: 'value',
      empty: 'offline',
      members: [
        { state: 'fresh', value: true },
        { state: 'stale', value: false, reason: 'offline' },
        { state: 'unavailable', fatal: false, reason: 'unknown' },
      ],
    })
    expect(outcome).toEqual({
      kind: 'value',
      value: true,
      counts: { included: 1, excluded: 2, total: 3 },
    })
  })

  it('does not publish on:false when every member is unknown', () => {
    const outcome = evaluateAggregate({
      reducer: reducerForActive('all'),
      publish: 'value',
      empty: 'offline',
      members: [
        { state: 'stale', value: true, reason: 'offline' },
        { state: 'unavailable', fatal: false, reason: 'unknown' },
      ],
    })
    expect(outcome.kind).toBe('unavailable')
    if (outcome.kind !== 'unavailable') return
    expect(outcome.fatal).toBe(false)
    expect(outcome.counts).toEqual({ included: 0, excluded: 2, total: 2 })
  })

  it('all is false only when an included member is off', () => {
    const outcome = evaluateAggregate({
      reducer: reducerForActive('all'),
      publish: 'value',
      empty: 'offline',
      members: [
        { state: 'fresh', value: true },
        { state: 'fresh', value: false },
        { state: 'unavailable', fatal: false, reason: 'unknown' },
      ],
    })
    expect(outcome).toMatchObject({
      kind: 'value',
      value: false,
      counts: { included: 2, excluded: 1 },
    })
  })
})

describe('command fan-out', () => {
  it('skips a member that lacks the cap and still commands an offline member', () => {
    const calls = fanOutTargets(
      [
        { deviceId: 1, caps: ['switch', 'brightness'], online: true },
        { deviceId: 2, caps: ['switch'], online: false },
        { deviceId: 3, caps: ['brightness'], online: true },
      ],
      'switch',
      'setState',
      { on: true },
    )
    expect(calls.map((call) => call.deviceId)).toEqual([1, 2])
    expect(calls[0]?.args).toEqual({ on: true })
  })

  it('reports one member that throws and still completes the others', async () => {
    const calls = fanOutTargets(
      [
        { deviceId: 1, caps: ['switch'], online: true },
        { deviceId: 2, caps: ['switch'], online: true },
        { deviceId: 3, caps: ['switch'], online: false },
      ],
      'switch',
      'setState',
      { on: false },
    )
    const started: number[] = []
    const results = await runFanOut(calls, async (call) => {
      started.push(call.deviceId)
      if (call.deviceId === 2) throw new Error('relay refused')
    })
    expect(started.toSorted((a, b) => a - b)).toEqual([1, 2, 3])
    expect(results).toEqual([
      { deviceId: 1, ok: true },
      { deviceId: 2, ok: false, error: 'relay refused' },
      { deviceId: 3, ok: true },
    ])
  })
})

describe('shared light capabilities', () => {
  it('keeps brightness and colour only when every member binds them', () => {
    expect(
      sharedLightCaps([
        ['switch', 'brightness', 'color'],
        ['switch', 'brightness'],
      ]),
    ).toEqual(['switch', 'brightness'])
    expect(
      sharedLightCaps([
        ['switch', 'brightness', 'color'],
        ['switch', 'color'],
      ]),
    ).toEqual(['switch', 'color'])
  })

  it('drops colour when a member that had it is joined by one that does not', () => {
    const before = sharedLightCaps([
      ['switch', 'brightness', 'color'],
      ['switch', 'brightness', 'color'],
    ])
    const after = sharedLightCaps([
      ['switch', 'brightness', 'color'],
      ['switch', 'brightness', 'color'],
      ['switch', 'brightness'],
    ])
    expect(before).toContain('color')
    expect(after).not.toContain('color')
  })

  it('intersects colour modes and does not treat a missing feature list as every mode', () => {
    expect(
      sharedColorModes([
        [DeviceFeature.LightColorRgb, DeviceFeature.LightColorMired],
        [DeviceFeature.LightColorMired, DeviceFeature.LightColorHsv],
      ]),
    ).toEqual([DeviceFeature.LightColorMired])
    expect(sharedColorModes([[DeviceFeature.LightColorRgb], []])).toEqual([])
  })
})

describe('actuator template round-trip', () => {
  it('compiles a switch group and reads the same spec back', () => {
    const spec = actuator('switch', 'at-least-one', [member(1), member(2)])
    const compiled = compileHelper(spec)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const stored = CompositionSchema.parse(compiled.composition)
    expect(stored.helper).toEqual(spec)
    expect(stored.target).toEqual({ kind: 'new', type: DeviceType.Switch })
    const again = compileHelper(spec)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(JSON.stringify(again.composition.features)).toBe(JSON.stringify(stored.features))
    const judged = validateComposition(stored, context(stored, DeviceType.Switch))
    expect(judged.problems).toEqual([])
    const on = stored.features.find((feature) => feature.cap === 'switch')
    expect(on?.kind === 'fields' ? on.fields.on : null).toMatchObject({
      kind: 'aggregate',
      reducer: 'any',
      empty: 'offline',
    })
  })

  it('compiles a light group the same way, on a light', () => {
    const spec = actuator('light', 'all', [member(1)])
    const compiled = compileHelper(spec)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const stored = CompositionSchema.parse(compiled.composition)
    expect(stored.helper).toEqual(spec)
    expect(stored.target).toEqual({ kind: 'new', type: DeviceType.Light })
    expect(validateComposition(stored, context(stored, DeviceType.Light)).problems).toEqual([])
    expect(stored.features.map((feature) => feature.cap)).toEqual(['switch', 'group-status'])
  })

  it('refuses a switch group with no criterion and a temperature group that has one', () => {
    const missing = compileHelper({
      kind: 'group',
      templateId: 'switch',
      aggregate: 'any',
      members: [member(1)],
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.problems.map((item) => item.path)).toContain('helper.active')
    const reading = compileHelper({
      kind: 'group',
      templateId: 'temperature',
      aggregate: 'mean',
      active: 'all',
      members: [
        {
          source: { addonId: 'provider-homeassistant', stableId: 'sensor-1' },
          cap: 'temperature-sensor',
          fieldPath: 'celsius',
        },
      ],
    })
    expect(reading.ok).toBe(false)
  })

  it('a free composition that names switch is still has-commands', () => {
    const judged = validateComposition(
      {
        target: { kind: 'new', type: DeviceType.Switch },
        features: [
          {
            kind: 'fields',
            cap: 'switch',
            fields: { on: { kind: 'expression', expr: 'true', bindings: {} } },
          },
        ],
      },
      { lookupCap, sources: new Map(), self: null, blockId: null, target: null, peers: [] },
    )
    expect(judged.problems.map((item) => item.code)).toContain('has-commands')
  })
})
