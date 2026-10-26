/**
 * Every refusal names its reason (D391), and every future variant is refused BY
 * NAME, with the slice that brings it.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { binaryCapability } from '../../capabilities/binary.cap.js'
import type { CapabilityDefinition } from '../../capabilities/capability-definition.js'
import { deviceStatusCapability } from '../../capabilities/device-status.cap.js'
import { motionCapability } from '../../capabilities/motion.cap.js'
import { temperatureSensorCapability } from '../../capabilities/temperature-sensor.cap.js'
import { DeviceType } from '../../device/device-type.js'
import {
  type Composition,
  CompositionSchema,
  composedDeviceRef,
  compositionSourceKey,
} from '../composition.js'
import type { CompositionPeer } from '../composition-graph.js'
import {
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '../examples.js'
import {
  buildCapabilityLookup,
  type CompositionSourceDescription,
  compositionSourceRefs,
  type ValidateCompositionContext,
  validateComposition,
} from '../validate-composition.js'

/** A fake cap with a NULLABLE field, to pin the `null` unavailable mode. */
const LEVEL_CAP = {
  name: 'test-level',
  scope: 'device',
  mode: 'singleton',
  methods: {},
  runtimeState: z.object({
    level: z.number().nullable(),
    /** A plain string, the stand-in for the root `unit` D944 §4 removed. Optional so it is not a required target. */
    label: z.string().optional(),
    lastFetchedAt: z.number(),
  }),
} as const satisfies CapabilityDefinition

/** A fake cap with an ENUM field, to pin the save-time literal check. */
const ENUM_CAP = {
  name: 'test-enum',
  scope: 'device',
  mode: 'singleton',
  methods: {},
  runtimeState: z.object({
    mode: z.enum(['on', 'off', 'auto']),
    lastChangedAt: z.number(),
  }),
} as const satisfies CapabilityDefinition

const lookupCap = buildCapabilityLookup([
  temperatureSensorCapability,
  binaryCapability,
  motionCapability,
  deviceStatusCapability,
  LEVEL_CAP,
  ENUM_CAP,
])

const ROOM = roomCompositionExample({
  temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
  occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
})

function allFound(composition: Composition): ReadonlyMap<string, CompositionSourceDescription> {
  return new Map(
    compositionSourceRefs(composition).map((ref, i) => [
      compositionSourceKey(ref),
      {
        kind: 'found',
        deviceId: 100 + i,
        caps: new Set(['temperature-sensor', 'motion', 'test-level']),
      },
    ]),
  )
}

function ctx(
  composition: Composition,
  over: Partial<ValidateCompositionContext> = {},
): ValidateCompositionContext {
  return {
    lookupCap,
    sources: allFound(composition),
    self: null,
    blockId: null,
    target: null,
    peers: [],
    ...over,
  }
}

function codes(
  composition: Composition,
  over: Partial<ValidateCompositionContext> = {},
): readonly string[] {
  return validateComposition(composition, ctx(composition, over)).problems.map((p) => p.code)
}

function single(
  cap: string,
  fields: Readonly<Record<string, unknown>>,
  type = DeviceType.Sensor,
): Composition {
  return CompositionSchema.parse({
    target: { kind: 'new', type },
    features: [{ kind: 'fields', cap, fields }],
  })
}

const T1 = ROOM_EXAMPLE_TEMPERATURE_SOURCES[0]!
const M1 = ROOM_EXAMPLE_MOTION_SOURCES[0]!
const tempFrom = (fieldPath: string) => ({
  kind: 'from',
  source: T1,
  cap: 'temperature-sensor',
  fieldPath,
})

describe('the room is valid', () => {
  it('plans four fields with their roles and unavailable modes', () => {
    const result = validateComposition(ROOM, ctx(ROOM))
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.fields.map((f) => [f.cap, f.path, f.role, f.unavailable])).toEqual([
      // D944 §4: celsius is nullable (a refused sample is null, D393), so a new
      // device says unavailable with null rather than by taking the field offline.
      ['temperature-sensor', 'celsius', 'derived', 'null'],
      ['temperature-sensor', 'lastFetchedAt', 'derived', 'offline'],
      ['binary', 'on', 'derived', 'offline'],
      ['binary', 'lastChangedAt', 'clock', 'offline'],
    ])
    expect(result.features.map((f) => [f.cap, f.mode])).toEqual([
      ['temperature-sensor', 'new'],
      ['binary', 'new'],
    ])
  })
})

describe('reserved variants are refused by name, with their slice', () => {
  // Each variant gets its OWN composition and its own code+path assertion.
  // A shared composition let the `commands` gate hide behind the passthrough
  // gate's identical "slice 3" substring — deleting the `commands` push left
  // this describe block green (review round 1). `toContainEqual` on the
  // problem's `code` AND `path` cannot be satisfied by a different feature's
  // refusal, so each assertion is pinned to the gate it names.
  it('an existing target is no longer reserved — one whose target was never read is refused as unreadable', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: T1 },
      features: ROOM.features,
    })
    const result = validateComposition(c, ctx(c))
    expect(result.problems.map((p) => p.code)).not.toContain('reserved-variant')
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'target-unreadable', path: 'target' }),
    )
    expect(result.problems.find((p) => p.path === 'target')?.message).toContain('not read')
  })

  it('a whole-capability passthrough → slice 3', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'new', type: DeviceType.Sensor },
      features: [{ kind: 'passthrough', cap: 'snapshot', source: T1 }],
    })
    const result = validateComposition(c, ctx(c))
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'reserved-variant', path: 'features[0]' }),
    )
    expect(result.problems.find((p) => p.path === 'features[0]')?.message).toContain('slice 3')
  })

  it('a `forward` command → slice 3', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'new', type: DeviceType.Sensor },
      features: [
        {
          kind: 'fields',
          cap: 'test-level',
          fields: { level: tempFrom('celsius'), lastFetchedAt: tempFrom('lastFetchedAt') },
          commands: { reset: { kind: 'forward', source: T1, cap: 'x', method: 'y' } },
        },
      ],
    })
    const result = validateComposition(c, ctx(c))
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'reserved-variant', path: 'features[0].commands' }),
    )
    expect(result.problems.find((p) => p.path === 'features[0].commands')?.message).toContain(
      'slice 3',
    )
  })

  it('a `code` source → slice 4', () => {
    const c = single('test-level', {
      level: { kind: 'code', code: 'return 1' },
      lastFetchedAt: tempFrom('lastFetchedAt'),
    })
    const result = validateComposition(c, ctx(c))
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'reserved-variant', path: 'features[0].fields.level' }),
    )
    expect(result.problems.find((p) => p.path === 'features[0].fields.level')?.message).toContain(
      'slice 4',
    )
  })
})

describe('capability fit', () => {
  it('refuses a cap with a method a composed device cannot serve, naming it', () => {
    const c = single('motion', {
      detected: { kind: 'from', source: M1, cap: 'motion', fieldPath: 'detected' },
    })
    const result = validateComposition(c, ctx(c))
    expect(result.problems.find((p) => p.code === 'has-commands')?.message).toContain(
      '`isDetected`',
    )
  })
  it('refuses a cap the device type does not offer', () => {
    const c = single(
      'temperature-sensor',
      { celsius: tempFrom('celsius'), lastFetchedAt: tempFrom('lastFetchedAt') },
      DeviceType.Light,
    )
    expect(codes(c)).toContain('wrong-device-type')
  })
  it('refuses a cap every device registers on itself', () => {
    expect(codes(single('device-status', {}))).toContain('not-composable')
  })
})

describe('fields', () => {
  it('a required field with no source', () => {
    expect(codes(single('temperature-sensor', { celsius: tempFrom('celsius') }))).toContain(
      'missing-field',
    )
  })
  it('an unknown field and a nested path', () => {
    const c = single('temperature-sensor', {
      celsius: tempFrom('celsius'),
      lastFetchedAt: tempFrom('lastFetchedAt'),
      fahrenheit: tempFrom('celsius'),
      'a.b': tempFrom('celsius'),
    })
    expect(codes(c)).toEqual(expect.arrayContaining(['unknown-field', 'nested-field']))
  })
  it('a boolean source into a number field', () => {
    const c = single('temperature-sensor', {
      celsius: { kind: 'from', source: M1, cap: 'motion', fieldPath: 'detected' },
      lastFetchedAt: tempFrom('lastFetchedAt'),
    })
    expect(codes(c)).toContain('kind-mismatch')
  })
  it('a possible null into a non-nullable field — and max() is accepted where latest() is not', () => {
    const f = (expr: string) =>
      single('temperature-sensor', {
        celsius: tempFrom('celsius'),
        lastFetchedAt: { kind: 'expression', expr, bindings: { a: tempFrom('lastFetchedAt') } },
      })
    expect(codes(f('latest(a)'))).toContain('may-be-null')
    expect(codes(f('max(a)'))).toEqual([])
  })
  it('a nullable target field goes null when unavailable', () => {
    const c = single('test-level', {
      level: { kind: 'from', source: T1, cap: 'test-level', fieldPath: 'level' },
      lastFetchedAt: tempFrom('lastFetchedAt'),
    })
    const result = validateComposition(c, ctx(c))
    expect(result.fields.find((f) => f.path === 'level')?.unavailable).toBe('null')
  })
  it("a call whose argument count is outside the builtin's minArgs/maxArgs is refused by name", () => {
    // `abs` takes exactly one argument (builtins.ts); two is refused, not silently accepted.
    const c = single('temperature-sensor', {
      celsius: { kind: 'expression', expr: 'abs(a, a)', bindings: { a: tempFrom('celsius') } },
      lastFetchedAt: tempFrom('lastFetchedAt'),
    })
    const result = validateComposition(c, ctx(c))
    expect(codes(c)).toContain('expression-invalid')
    expect(result.problems.find((p) => p.code === 'expression-invalid')?.message).toContain('abs')
  })
})

describe('enum target fields', () => {
  it('refuses a literal string outside the enum — it is known at save', () => {
    const c = single('test-enum', {
      mode: { kind: 'expression', expr: '"invalid"', bindings: {} },
      lastChangedAt: tempFrom('lastFetchedAt'),
    })
    const result = validateComposition(c, ctx(c))
    const p = result.problems.find(
      (problem) => problem.code === 'kind-mismatch' && problem.path === 'features[0].fields.mode',
    )
    expect(p?.message).toContain('`invalid`')
    expect(p?.message).toContain('`on`')
  })
  it('accepts a literal string inside the enum', () => {
    const c = single('test-enum', {
      mode: { kind: 'expression', expr: '"on"', bindings: {} },
      lastChangedAt: tempFrom('lastFetchedAt'),
    })
    expect(codes(c)).toEqual([])
  })
  it('leaves a dynamic (non-literal) source to runtime — no save-time enum check', () => {
    // D944 §4 removed the root `unit` sibling. `test-level.label` is a plain
    // STRING field, not this enum's set. Reading it collapses to the coarse
    // 'string' KIND only (the live value is unknown at save time) — no way
    // to catch this one until the write. See `literalStringValue`'s doc.
    const c = single('test-enum', {
      mode: {
        kind: 'expression',
        expr: 'a',
        bindings: { a: { kind: 'from', source: T1, cap: 'test-level', fieldPath: 'label' } },
      },
      lastChangedAt: tempFrom('lastFetchedAt'),
    })
    expect(codes(c)).toEqual([])
  })
})

describe('sources', () => {
  it('absent, unreadable and missing-cap sources are each named', () => {
    const [a, b, c] = compositionSourceRefs(ROOM)
    const sources = new Map(allFound(ROOM))
    sources.set(compositionSourceKey(a!), { kind: 'absent' })
    sources.set(compositionSourceKey(b!), { kind: 'unreadable', error: 'timeout' })
    sources.set(compositionSourceKey(c!), {
      kind: 'found',
      deviceId: 7,
      caps: new Set(['battery']),
    })
    const problems = validateComposition(ROOM, ctx(ROOM, { sources })).problems
    expect(problems.map((p) => p.code)).toEqual(
      expect.arrayContaining(['source-missing', 'source-unreadable', 'source-capability-missing']),
    )
    expect(problems.find((p) => p.code === 'source-missing')?.message).toContain(
      compositionSourceKey(a!),
    )
    // Path follows the documented `features[N].fields.<path>` convention.
    expect(problems.every((p) => /^features\[\d+\]\.fields\.\w+$/.test(p.path))).toBe(true)
  })

  it('source-field-unknown: an unknown source capability is named', () => {
    const c = single('temperature-sensor', {
      celsius: { kind: 'from', source: T1, cap: 'no-such-cap', fieldPath: 'x' },
      lastFetchedAt: tempFrom('lastFetchedAt'),
    })
    const result = validateComposition(c, ctx(c))
    expect(result.problems.find((p) => p.code === 'source-field-unknown')?.message).toContain(
      '`no-such-cap`',
    )
  })

  it('source-field-unknown: an unknown field on a known source capability is named', () => {
    const c = single('temperature-sensor', {
      celsius: { kind: 'from', source: T1, cap: 'temperature-sensor', fieldPath: 'bogus' },
      lastFetchedAt: tempFrom('lastFetchedAt'),
    })
    const result = validateComposition(c, ctx(c))
    expect(result.problems.find((p) => p.code === 'source-field-unknown')?.message).toContain(
      '`bogus`',
    )
  })

  it('source-field-unknown: a self-read of a field this device does not compose is named', () => {
    const self = composedDeviceRef('b1')
    // This composition composes `temperature-sensor` only — `binary.on` is a
    // real field on a real cap, just not one THIS device writes.
    const c = single('temperature-sensor', {
      celsius: { kind: 'from', source: self, cap: 'binary', fieldPath: 'on' },
      lastFetchedAt: tempFrom('lastFetchedAt'),
    })
    const result = validateComposition(c, ctx(c, { self }))
    expect(result.problems.find((p) => p.code === 'source-field-unknown')?.message).toContain(
      '`binary.on`',
    )
  })
})

describe('cycles', () => {
  it('refuses a field that reads itself, naming the exact field it reads', () => {
    const self = composedDeviceRef('b1')
    const c = single('test-level', {
      level: { kind: 'from', source: self, cap: 'test-level', fieldPath: 'level' },
      lastFetchedAt: tempFrom('lastFetchedAt'),
    })
    const result = validateComposition(c, ctx(c, { self }))
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'cycle', path: 'features[0].fields.level' }),
    )
  })

  it('refuses, by name, two stored peers that target the same device', () => {
    const self = composedDeviceRef('b1')
    const c = single('test-level', {
      level: tempFrom('celsius'),
      lastFetchedAt: tempFrom('lastFetchedAt'),
    })
    const stolenTarget = composedDeviceRef('b3')
    const peers: readonly CompositionPeer[] = [
      { blockId: 'b3', target: stolenTarget, composition: c },
      { blockId: 'b4', target: stolenTarget, composition: c },
    ]
    const result = validateComposition(c, ctx(c, { self, peers }))
    expect(result.problems.find((p) => p.code === 'duplicate-target')?.message).toContain(
      compositionSourceKey(stolenTarget),
    )
  })
})
