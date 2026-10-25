import {
  ALL_CAPABILITY_DEFINITIONS,
  type CapabilityDefinition,
  type Composition,
  consumablesCapability,
  DeviceType,
  planComposition,
  unwrapSchema,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LOOKUP_CAP } from './fixtures.js'

/** The cap-level refusals: a cap refused by one of these cannot be composed whatever its fields. */
const CAP_PATH = 'features[0].cap'

function composable(cap: CapabilityDefinition): boolean {
  const composition: Composition = {
    target: { kind: 'new', type: cap.deviceTypes?.[0] ?? DeviceType.Sensor },
    features: [{ kind: 'fields', cap: cap.name, fields: {} }],
  }
  const plan = planComposition(composition, LOOKUP_CAP)
  return !plan.problems.some((p) => p.path === CAP_PATH)
}

function jsonShape(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }))
}

/**
 * Every way a status key can disagree with its runtime-state twin: absent,
 * a different optionality (JSON shape alone loses `.optional()`), a different
 * nullability, or a different shape. An EXTRA runtime-state key is not listed
 * — output parsing strips it. Empty = the verbatim slice parses as the status.
 */
function statusKeyMismatches(status: z.ZodType, runtime: z.ZodType): readonly string[] {
  const statusShape = unwrapSchema(status)
  const runtimeShape = unwrapSchema(runtime)
  if (!(statusShape instanceof z.ZodObject) || !(runtimeShape instanceof z.ZodObject)) {
    return ['status and runtimeState must both be object schemas']
  }
  return Object.entries(statusShape.shape).flatMap(([key, field]): readonly string[] => {
    const twin: unknown = runtimeShape.shape[key]
    if (twin === undefined) return [`${key}: a status key but not a runtime-state key`]
    if (!(field instanceof z.ZodType) || !(twin instanceof z.ZodType))
      return [`${key}: not a schema`]
    const optional = (s: z.ZodType): boolean => s.safeParse(undefined).success
    const nullable = (s: z.ZodType): boolean => s.safeParse(null).success
    return [
      ...(optional(field) === optional(twin) ? [] : [`${key}: optionality differs`]),
      ...(nullable(field) === nullable(twin) ? [] : [`${key}: nullability differs`]),
      ...(jsonShape(field) === jsonShape(twin) ? [] : [`${key}: shape differs`]),
    ]
  })
}

describe('statusKeyMismatches — what the invariant below can see', () => {
  it('a key required in status but optional in runtimeState is a mismatch', () => {
    expect(
      statusKeyMismatches(z.object({ a: z.string() }), z.object({ a: z.string().optional() })),
    ).toEqual(['a: optionality differs'])
  })
  it('a key optional in status but required in runtimeState is a mismatch', () => {
    expect(
      statusKeyMismatches(z.object({ a: z.string().optional() }), z.object({ a: z.string() })),
    ).toEqual(['a: optionality differs'])
  })
  it('a key nullable on one side only is a mismatch', () => {
    expect(
      statusKeyMismatches(z.object({ a: z.number() }), z.object({ a: z.number().nullable() })),
    ).toEqual(expect.arrayContaining(['a: nullability differs']))
  })
  it('a status key missing from runtimeState is a mismatch; an extra runtime key is not', () => {
    expect(statusKeyMismatches(z.object({ a: z.number() }), z.object({ b: z.number() }))).toEqual([
      'a: a status key but not a runtime-state key',
    ])
    expect(
      statusKeyMismatches(z.object({ a: z.number() }), z.object({ a: z.number(), b: z.number() })),
    ).toEqual([])
  })
})

describe('the invariant the kernel default getStatus relies on: every status key is a runtime-state key with the same shape, for every composable cap', () => {
  const composableCaps = ALL_CAPABILITY_DEFINITIONS.filter(composable)

  it('the validator accepts at least the room example caps', () => {
    expect(composableCaps.map((c) => c.name)).toEqual(
      expect.arrayContaining(['binary', 'temperature-sensor']),
    )
  })
  it.each(
    composableCaps.map((cap) => [cap.name, cap] as const),
  )('%s: every status key, when a status contract is present, is a runtime-state key with the same shape', (_name, cap) => {
    if (cap.status === undefined) return
    expect(cap.runtimeState).toBeDefined()
    if (cap.runtimeState === undefined) return
    expect(statusKeyMismatches(cap.status.schema, cap.runtimeState)).toEqual([])
  })
  it('consumables: runtimeState carries lastFetchedAt, which status does not — the extra key is on the runtime side only', () => {
    expect(composableCaps).toContain(consumablesCapability)
    const statusShape = unwrapSchema(consumablesCapability.status.schema)
    const runtimeShape = unwrapSchema(consumablesCapability.runtimeState)
    if (!(statusShape instanceof z.ZodObject) || !(runtimeShape instanceof z.ZodObject)) {
      throw new Error('consumables: status and runtimeState must both be object schemas')
    }
    expect('lastFetchedAt' in runtimeShape.shape && !('lastFetchedAt' in statusShape.shape)).toBe(
      true,
    )
    // Read the other way round, the extra key IS a mismatch: the subset has a direction.
    expect(
      statusKeyMismatches(consumablesCapability.runtimeState, consumablesCapability.status.schema),
    ).toEqual(['lastFetchedAt: a status key but not a runtime-state key'])
  })
})
