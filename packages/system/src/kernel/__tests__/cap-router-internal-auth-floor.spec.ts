/**
 * Task 7.5c — `internal: true` does not gate the mount, and never gated
 * auth either: `resolveCapMount` never reads the field, and the runtime
 * builder resolved a method with no EXPLICIT `auth` to `'protected'` no
 * matter what the enclosing cap declared. That is how 45 procedures across
 * 13 `internal` caps ended up reachable by any authenticated session —
 * including `ssoBridge.signBridgeToken`, a full privilege escalation
 * (caller-supplied `isAdmin` claims, redeemed at `/api/auth/sso/finish`).
 *
 * The fix is a FLOOR, not a hard skip: an `internal` cap's un-annotated
 * method resolves to `'admin'`; an EXPLICIT `auth` on the method — public,
 * protected, or admin — always wins, because the author already made a
 * deliberate choice. `resolveMethodAuth` (`cap-router-predicates.ts`) is
 * the single source of truth the runtime builder AND the codegen both call,
 * so the two can never disagree (a documented failure mode in this repo).
 *
 * Driven through `buildOneCapRouter` with synthetic, SINGLE-method cap defs
 * (mirroring `cap-router-caller-injection.spec.ts`'s doubles) — one method
 * per cap keeps "which auth tier got used" unambiguous without depending on
 * builder iteration order.
 */

import { type CapabilityDefinition, method } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildOneCapRouter,
  type CapRouterPrimitives,
  type CapRouterServices,
  type ProcedureBuilder,
} from '../cap-router-builder.js'

/** Procedure builder that records which auth tier built the procedure. */
function makeProcedureBuilder(
  authTier: 'public' | 'protected' | 'admin',
  sink: { used?: string },
): ProcedureBuilder {
  const builder: ProcedureBuilder = {
    input() {
      return builder
    },
    output() {
      return builder
    },
    query() {
      sink.used = authTier
      return { kind: 'query' }
    },
    mutation() {
      sink.used = authTier
      return { kind: 'mutation' }
    },
    subscription() {
      sink.used = authTier
      return { kind: 'subscription' }
    },
  }
  return builder
}

function makePrimitives(sink: { used?: string }): CapRouterPrimitives {
  return {
    router: (procs) => procs,
    procedures: {
      public: makeProcedureBuilder('public', sink),
      protected: makeProcedureBuilder('protected', sink),
      admin: makeProcedureBuilder('admin', sink),
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

function makeServices(): CapRouterServices {
  return {
    getLocalProvider: () => null,
    remoteProxy: () => null,
    noProvider: (cap, nodeId) => {
      throw new Error(`noProvider:${cap}:${nodeId ?? ''}`)
    },
    noNodeRouting: (cap) => {
      throw new Error(`noNodeRouting:${cap}`)
    },
    badRequest: (m) => {
      throw new Error(`badRequest:${m}`)
    },
  }
}

/** Build a single-method cap's router and return which auth tier it used. */
function authTierUsed(def: CapabilityDefinition): string | undefined {
  const sink: { used?: string } = {}
  buildOneCapRouter(def, makePrimitives(sink), makeServices())
  return sink.used
}

describe('internal-cap auth floor (Task 7.5c)', () => {
  it('floors an unannotated method on an internal cap to admin', () => {
    const internalCap = {
      name: 'fake-internal-floor',
      scope: 'system',
      mode: 'singleton',
      internal: true,
      methods: {
        leaky: method(z.void(), z.void()),
      },
    } as const satisfies CapabilityDefinition
    expect(authTierUsed(internalCap)).toBe('admin')
  })

  it('keeps an EXPLICIT public auth on an internal cap method', () => {
    const internalCap = {
      name: 'fake-internal-explicit-public',
      scope: 'system',
      mode: 'singleton',
      internal: true,
      methods: {
        deliberatelyPublic: method(z.void(), z.void(), { auth: 'public' }),
      },
    } as const satisfies CapabilityDefinition
    expect(authTierUsed(internalCap)).toBe('public')
  })

  it('keeps an EXPLICIT protected auth on an internal cap method', () => {
    const internalCap = {
      name: 'fake-internal-explicit-protected',
      scope: 'system',
      mode: 'singleton',
      internal: true,
      methods: {
        deliberatelyProtected: method(z.void(), z.void(), { auth: 'protected' }),
      },
    } as const satisfies CapabilityDefinition
    expect(authTierUsed(internalCap)).toBe('protected')
  })

  it('does NOT floor an unannotated method on a non-internal cap', () => {
    const publicCap = {
      name: 'fake-public-cap',
      scope: 'system',
      mode: 'singleton',
      methods: {
        ordinary: method(z.void(), z.void()),
      },
    } as const satisfies CapabilityDefinition
    expect(authTierUsed(publicCap)).toBe('protected')
  })
})
