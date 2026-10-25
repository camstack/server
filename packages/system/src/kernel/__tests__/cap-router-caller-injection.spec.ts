/**
 * D-1 (notification-center P0) — opt-in caller-identity injection.
 *
 * A cap method declared with `caller: 'required'` must receive a
 * SERVER-derived `caller: { userId, isAdmin }` on the input object handed
 * to the provider:
 *   - the identity comes from the authenticated tRPC session (`ctx.user`),
 *   - any client-supplied `caller` field is DISCARDED (spoof-proof),
 *   - an unauthenticated context FAILS the call (UNAUTHORIZED) — a
 *     fabricated caller is never injected,
 *   - caller-less methods are byte-for-byte unchanged,
 *   - non-object / subscription shapes are rejected at router-BUILD time.
 *
 * Driven through `buildOneCapRouter` with synthetic cap defs (no live cap
 * adopts the flag in this slice), using the same recording doubles as
 * `cap-router-builder.spec.ts`.
 */

import {
  method,
  type CapCaller,
  type CapabilityDefinition,
  type InferNativeProvider,
  type InferProvider,
} from '@camstack/types'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  buildOneCapRouter,
  type CapRouterPrimitives,
  type CapRouterServices,
  type ProcedureBuilder,
} from '../cap-router-builder.js'

// ── Recording doubles (mirrors cap-router-builder.spec.ts) ──────────────

interface RecordedProcedure {
  kind: 'query' | 'mutation' | 'subscription'
  call: (input: unknown, ctx: unknown) => unknown
}

function makeProcedureBuilder(): ProcedureBuilder {
  const builder: ProcedureBuilder = {
    input() {
      return builder
    },
    output() {
      return builder
    },
    query(resolver) {
      const proc: RecordedProcedure = {
        kind: 'query',
        call: (input, ctx) => resolver({ input, ctx }),
      }
      return proc
    },
    mutation(resolver) {
      const proc: RecordedProcedure = {
        kind: 'mutation',
        call: (input, ctx) => resolver({ input, ctx }),
      }
      return proc
    },
    subscription(resolver) {
      const proc: RecordedProcedure = {
        kind: 'subscription',
        call: (input, ctx) => resolver({ input, ctx }),
      }
      return proc
    },
  }
  return builder
}

function makePrimitives(): CapRouterPrimitives {
  return {
    router: (procs) => procs,
    procedures: {
      public: makeProcedureBuilder(),
      protected: makeProcedureBuilder(),
      admin: makeProcedureBuilder(),
    },
    iterableSubscription: <T>(subscribe: (push: (value: T) => void) => () => void) => {
      async function* gen(): AsyncGenerator<T> {
        const values: T[] = []
        const unsub = subscribe((v) => values.push(v))
        try {
          for (const v of values) yield v
        } finally {
          unsub()
        }
      }
      return gen()
    },
  }
}

interface CallRecord {
  cap: string
  method: string
  args: unknown[]
  nodeId: string | 'local'
}

interface ServicesDouble {
  services: CapRouterServices
  calls: CallRecord[]
}

function makeServices(options?: { readonly omitUnauthorized?: boolean }): ServicesDouble {
  const calls: CallRecord[] = []
  const makeProvider = (
    cap: string,
    nodeId: string,
  ): Record<string, (...a: unknown[]) => unknown> =>
    new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (typeof prop !== 'string') return undefined
          return (...args: unknown[]) => {
            calls.push({ cap, method: prop, args, nodeId })
            return { ok: true }
          }
        },
      },
    )
  const base: CapRouterServices = {
    getLocalProvider: (cap) => makeProvider(cap, 'local'),
    remoteProxy: (cap, nodeId) => makeProvider(cap, nodeId),
    noProvider: (cap, nodeId) => {
      throw new Error(`noProvider:${cap}:${nodeId ?? ''}`)
    },
    noNodeRouting: (cap) => {
      throw new Error(`noNodeRouting:${cap}`)
    },
    badRequest: (m) => {
      throw new Error(`badRequest:${m}`)
    },
    unauthorized: (m) => {
      throw new Error(`unauthorized:${m}`)
    },
  }
  if (options?.omitUnauthorized === true) {
    // Framework-live-update skew shape: an older server hands the builder
    // a services object WITHOUT the `unauthorized` raiser.
    const { unauthorized: _omitted, ...withoutUnauthorized } = base
    return { services: withoutUnauthorized, calls }
  }
  return { services: base, calls }
}

// ── Synthetic cap defs ───────────────────────────────────────────────────

const callerCap = {
  name: 'caller-fixture',
  scope: 'system',
  mode: 'singleton',
  methods: {
    createRule: method(z.object({ label: z.string() }), z.object({ ok: z.boolean() }), {
      kind: 'mutation',
      caller: 'required',
    }),
    listRules: method(z.object({ limit: z.number().optional() }), z.array(z.unknown()), {
      caller: 'required',
    }),
    plainMethod: method(z.object({ label: z.string() }), z.object({ ok: z.boolean() }), {
      kind: 'mutation',
    }),
  },
} as const satisfies CapabilityDefinition

type Router = Record<string, RecordedProcedure>

function buildRouter(def: CapabilityDefinition, services: CapRouterServices): Router {
  return buildOneCapRouter(def, makePrimitives(), services) as Router
}

const adminCtx = { user: { id: 'user-7', isAdmin: true } }
const viewerCtx = { user: { id: 'user-9', isAdmin: false } }

// ── Injection ────────────────────────────────────────────────────────────

describe('caller: required — injection from the authenticated session', () => {
  it('injects { userId, isAdmin } from ctx.user into the provider input', () => {
    const { services, calls } = makeServices()
    const router = buildRouter(callerCap, services)
    router.createRule!.call({ label: 'zone-a' }, viewerCtx)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toEqual({
      label: 'zone-a',
      caller: { userId: 'user-9', isAdmin: false },
    })
  })

  it('propagates isAdmin: true for admin sessions', () => {
    const { services, calls } = makeServices()
    const router = buildRouter(callerCap, services)
    router.listRules!.call({ limit: 5 }, adminCtx)
    expect(calls[0]!.args[0]).toEqual({
      limit: 5,
      caller: { userId: 'user-7', isAdmin: true },
    })
  })

  it('DISCARDS a client-supplied caller field (spoof-proof)', () => {
    const { services, calls } = makeServices()
    const router = buildRouter(callerCap, services)
    router.createRule!.call(
      { label: 'zone-a', caller: { userId: 'admin-spoof', isAdmin: true } },
      viewerCtx,
    )
    expect(calls[0]!.args[0]).toEqual({
      label: 'zone-a',
      caller: { userId: 'user-9', isAdmin: false },
    })
  })

  it('still strips the out-of-band nodeId selector before injection', () => {
    const { services, calls } = makeServices()
    const router = buildRouter(callerCap, services)
    router.createRule!.call({ label: 'x', nodeId: 'hub' }, viewerCtx)
    expect(calls[0]!.args[0]).toEqual({
      label: 'x',
      caller: { userId: 'user-9', isAdmin: false },
    })
  })

  it('does not mutate the parsed input object', () => {
    const { services, calls } = makeServices()
    const router = buildRouter(callerCap, services)
    const input = { label: 'immutable' }
    router.createRule!.call(input, viewerCtx)
    expect(input).toEqual({ label: 'immutable' })
    expect(calls[0]!.args[0]).not.toBe(input)
  })
})

// ── Unauthenticated / malformed contexts fail closed ────────────────────

describe('caller: required — unauthenticated context', () => {
  it.each([
    ['empty ctx', {}],
    ['null user', { user: null }],
    ['user without id', { user: { isAdmin: true } }],
    ['user without isAdmin', { user: { id: 'u1' } }],
    ['non-string id', { user: { id: 42, isAdmin: true } }],
    ['empty-string id', { user: { id: '', isAdmin: true } }],
    ['non-boolean isAdmin', { user: { id: 'u1', isAdmin: 'yes' } }],
  ])('raises UNAUTHORIZED for %s — never injects a fabricated caller', (_label, ctx) => {
    const { services, calls } = makeServices()
    const router = buildRouter(callerCap, services)
    expect(() => router.createRule!.call({ label: 'x' }, ctx)).toThrow(/^unauthorized:/)
    expect(calls).toHaveLength(0)
  })

  it('falls back to badRequest when the services object predates `unauthorized` (version skew)', () => {
    const { services, calls } = makeServices({ omitUnauthorized: true })
    const router = buildRouter(callerCap, services)
    expect(() => router.createRule!.call({ label: 'x' }, {})).toThrow(/^badRequest:/)
    expect(calls).toHaveLength(0)
  })
})

// ── Caller-less methods unchanged ────────────────────────────────────────

describe('caller-less methods — zero behaviour change', () => {
  it('never injects a caller, even with an authenticated session', () => {
    const { services, calls } = makeServices()
    const router = buildRouter(callerCap, services)
    router.plainMethod!.call({ label: 'plain' }, adminCtx)
    expect(calls[0]!.args[0]).toEqual({ label: 'plain' })
  })

  it('does not reject an unauthenticated context (auth stays the procedure tier concern)', () => {
    const { services, calls } = makeServices()
    const router = buildRouter(callerCap, services)
    router.plainMethod!.call({ label: 'plain' }, {})
    expect(calls[0]!.args[0]).toEqual({ label: 'plain' })
  })
})

// ── nodeIdMode: 'data' path ──────────────────────────────────────────────

describe("caller: required — nodeIdMode: 'data' pass-through path", () => {
  const dataCap = {
    name: 'caller-data-fixture',
    scope: 'system',
    mode: 'singleton',
    nodeIdMode: 'data',
    methods: {
      setThing: method(
        z.object({ nodeId: z.string().optional(), value: z.string() }),
        z.object({ ok: z.boolean() }),
        { kind: 'mutation', caller: 'required' },
      ),
    },
  } as const satisfies CapabilityDefinition

  it('keeps nodeId as data AND injects the caller', () => {
    const { services, calls } = makeServices()
    const router = buildRouter(dataCap, services)
    router.setThing!.call({ nodeId: 'agent-1', value: 'v' }, viewerCtx)
    expect(calls[0]!.args[0]).toEqual({
      nodeId: 'agent-1',
      value: 'v',
      caller: { userId: 'user-9', isAdmin: false },
    })
  })

  it('overwrites a spoofed caller on the data path too', () => {
    const { services, calls } = makeServices()
    const router = buildRouter(dataCap, services)
    router.setThing!.call({ value: 'v', caller: { userId: 'spoof', isAdmin: true } }, adminCtx)
    expect(calls[0]!.args[0]).toEqual({
      value: 'v',
      caller: { userId: 'user-7', isAdmin: true },
    })
  })
})

// ── Collection path ──────────────────────────────────────────────────────

describe('caller: required — collection cap path', () => {
  const collectionCap = {
    name: 'caller-collection-fixture',
    scope: 'system',
    mode: 'collection',
    methods: {
      upsertTarget: method(
        z.object({ target: z.object({ id: z.string() }) }),
        z.object({ ok: z.boolean() }),
        { kind: 'mutation', caller: 'required' },
      ),
    },
  } as const satisfies CapabilityDefinition

  it('strips nodeId/addonId selectors and injects the caller', () => {
    const { services, calls } = makeServices()
    const router = buildRouter(collectionCap, services)
    router.upsertTarget!.call(
      { target: { id: 't1' }, addonId: 'addon-x', caller: { userId: 'spoof', isAdmin: true } },
      viewerCtx,
    )
    expect(calls[0]!.args[0]).toEqual({
      target: { id: 't1' },
      caller: { userId: 'user-9', isAdmin: false },
    })
  })
})

// ── Type surface (compile-gated by `npm run typecheck -w packages/system`,
//    which — unlike packages/types' tsconfig — includes __tests__; these
//    assertions also exercise the EMITTED @camstack/types declarations) ──

describe("caller: 'required' — InferProvider/InferNativeProvider type surface", () => {
  type Provider = InferProvider<typeof callerCap>
  type NativeProvider = InferNativeProvider<typeof callerCap>

  it('types the provider input as wire Input & { caller: CapCaller }', () => {
    type CreateRuleInput = Parameters<Provider['createRule']>[0]
    expectTypeOf<CreateRuleInput>().toHaveProperty('caller')
    expectTypeOf<CreateRuleInput['caller']>().toEqualTypeOf<CapCaller>()
    expectTypeOf<CreateRuleInput>().toMatchTypeOf<{ label: string; caller: CapCaller }>()
  })

  it('mirrors the enrichment on native providers', () => {
    type NativeInput = Parameters<NativeProvider['createRule']>[0]
    expectTypeOf<NativeInput['caller']>().toEqualTypeOf<CapCaller>()
  })

  it('leaves caller-less method inputs untouched', () => {
    type PlainInput = Parameters<Provider['plainMethod']>[0]
    expectTypeOf<PlainInput>().toEqualTypeOf<{ label: string }>()
  })
})

// ── Build-time shape guard ───────────────────────────────────────────────

describe('caller: required — unsupported method shapes fail at build time', () => {
  it('rejects a void-input caller-required method', () => {
    const def = {
      name: 'caller-void-fixture',
      scope: 'system',
      mode: 'singleton',
      methods: {
        // Bypass `method()` (whose overloads steer users right) to model a
        // hand-written schema object declaring the invalid combination.
        badVoid: {
          input: z.void(),
          output: z.object({ ok: z.boolean() }),
          kind: 'query',
          auth: 'protected',
          caller: 'required',
        },
      },
    } as const satisfies CapabilityDefinition
    const { services } = makeServices()
    expect(() => buildRouter(def, services)).toThrow(/caller: 'required' is only/)
  })

  it('rejects a non-object (scalar) input caller-required method', () => {
    const def = {
      name: 'caller-scalar-fixture',
      scope: 'system',
      mode: 'singleton',
      methods: {
        badScalar: {
          input: z.string(),
          output: z.object({ ok: z.boolean() }),
          kind: 'query',
          auth: 'protected',
          caller: 'required',
        },
      },
    } as const satisfies CapabilityDefinition
    const { services } = makeServices()
    expect(() => buildRouter(def, services)).toThrow(/caller: 'required' is only/)
  })

  it('rejects a subscription caller-required method', () => {
    const def = {
      name: 'caller-sub-fixture',
      scope: 'system',
      mode: 'singleton',
      methods: {
        badSub: {
          input: z.object({ topic: z.string() }),
          output: z.object({ tick: z.number() }),
          kind: 'subscription',
          auth: 'protected',
          caller: 'required',
        },
      },
    } as const satisfies CapabilityDefinition
    const { services } = makeServices()
    expect(() => buildRouter(def, services)).toThrow(/caller: 'required' is only/)
  })
})
