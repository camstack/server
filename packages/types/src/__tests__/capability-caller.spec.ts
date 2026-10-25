/**
 * D-1 (notification-center P0) — `caller: 'required'` type surface.
 *
 * Verifies at COMPILE time (vitest `expectTypeOf`) that:
 *   - `method(in, out, { caller: 'required' })` carries the literal on
 *     its static type,
 *   - `InferProvider` / `InferNativeProvider` type the provider input as
 *     `Input & { caller: CapCaller }` for caller-required methods,
 *   - caller-less methods keep the plain wire input (zero drift),
 * plus the runtime value plumbing of the `method()` factory.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  method,
  type CapCaller,
  type CapabilityDefinition,
  type InferNativeProvider,
  type InferProvider,
} from '../index.js'

const callerFixtureCap = {
  name: 'caller-type-fixture',
  scope: 'system',
  mode: 'singleton',
  methods: {
    createRule: method(z.object({ label: z.string() }), z.object({ ok: z.boolean() }), {
      kind: 'mutation',
      caller: 'required',
    }),
    plainMethod: method(z.object({ label: z.string() }), z.object({ ok: z.boolean() }), {
      kind: 'mutation',
    }),
  },
} as const satisfies CapabilityDefinition

type Provider = InferProvider<typeof callerFixtureCap>
type NativeProvider = InferNativeProvider<typeof callerFixtureCap>

describe("caller: 'required' — provider type surface", () => {
  it('InferProvider input carries the injected caller field, typed CapCaller', () => {
    type CreateRuleInput = Parameters<Provider['createRule']>[0]
    expectTypeOf<CreateRuleInput>().toHaveProperty('caller')
    expectTypeOf<CreateRuleInput['caller']>().toEqualTypeOf<CapCaller>()
    expectTypeOf<CreateRuleInput['label']>().toEqualTypeOf<string>()
    // The full shape: wire input & { caller } is assignable both ways.
    expectTypeOf<CreateRuleInput>().toMatchTypeOf<{ label: string; caller: CapCaller }>()
  })

  it('InferNativeProvider mirrors the same input enrichment', () => {
    type NativeCreateRuleInput = Parameters<NativeProvider['createRule']>[0]
    expectTypeOf<NativeCreateRuleInput>().toHaveProperty('caller')
    expectTypeOf<NativeCreateRuleInput['caller']>().toEqualTypeOf<CapCaller>()
  })

  it('caller-less methods keep the plain wire input', () => {
    type PlainInput = Parameters<Provider['plainMethod']>[0]
    expectTypeOf<PlainInput>().toEqualTypeOf<{ label: string }>()
    // @ts-expect-error — no caller field on a caller-less method input
    type _NoCaller = PlainInput['caller']
  })

  it('CapCaller is the { userId, isAdmin } pair', () => {
    expectTypeOf<CapCaller>().toEqualTypeOf<{
      readonly userId: string
      readonly isAdmin: boolean
    }>()
  })
})

describe("caller: 'required' — method() factory value plumbing", () => {
  it('carries the caller literal on the schema value', () => {
    expect(callerFixtureCap.methods.createRule.caller).toBe('required')
  })

  it('omits the caller key entirely when not requested', () => {
    expect('caller' in callerFixtureCap.methods.plainMethod).toBe(false)
  })
})
