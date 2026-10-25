/**
 * Comprehensive null-provider spec — verifies that EVERY cap router the
 * LIVE runtime builder mounts returns a non-success when the provider is
 * null.
 *
 * This is a safety net: if a new cap is added and the runtime builder
 * doesn't guard against a null provider, this test catches it.
 *
 * Migrated 2026-07-11 off the retired codegen `createCapRouter_*` value
 * factories onto `@camstack/system` `buildCapRouters` — the exact router
 * the running hub builds.
 *
 * NOTE: some caps have methods that require non-void input (z.object({...})).
 * For those, Zod input validation may reject our empty input before the
 * null-provider check runs — in which case we expect BAD_REQUEST or
 * PRECONDITION_FAILED (both are acceptable: the point is that the call
 * does NOT succeed and return garbage data).
 */
import { describe, it, expect } from 'vitest'
import { buildCapRouters, type CapRouterServices } from '@camstack/system'
import { TRPCError } from '@trpc/server'
import { createCapRouterPrimitives } from '../../api/trpc/cap-router-runtime.js'
import { makeCtx, invokeProcedure } from './harness.js'

// Build EVERY cap router the runtime builder mounts with NO provider
// (getLocalProvider + remoteProxy both null) — the live resolution path,
// so a missing guard surfaces here exactly as it would in production.
const nullServices: CapRouterServices = {
  getLocalProvider: () => null,
  remoteProxy: () => null,
  noProvider: (name, nodeId) => {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        nodeId !== undefined && nodeId !== 'hub'
          ? `Capability "${name}" not available on node "${nodeId}"`
          : `Capability "${name}" provider not available`,
    })
  },
  noNodeRouting: (name) => {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Node routing not available for "${name}"`,
    })
  },
  badRequest: (message) => {
    throw new TRPCError({ code: 'BAD_REQUEST', message })
  },
}

interface CallableRouter {
  readonly createCaller: (ctx: unknown) => Record<string, (input?: unknown) => unknown>
}

const routerEntries = Object.entries(
  buildCapRouters(createCapRouterPrimitives(), nullServices),
) as Array<[string, CallableRouter]>

describe('null-provider guard — all capabilities (runtime builder)', () => {
  it(`builds ${routerEntries.length} cap routers`, () => {
    expect(routerEntries.length).toBeGreaterThanOrEqual(30)
  })

  for (const [name, router] of routerEntries) {
    it(`${name}: null provider does not return success`, async () => {
      const caller = router.createCaller(makeCtx('admin'))
      const methods = Object.keys(caller).filter(
        (k) => typeof caller[k] === 'function' && !k.startsWith('_'),
      )
      if (methods.length === 0) return // no methods — skip

      const firstMethod = methods[0]!
      const result = await invokeProcedure(router, firstMethod, makeCtx('admin'))

      // The call must NOT succeed — PRECONDITION_FAILED (null provider caught
      // by the builder's resolver), BAD_REQUEST (input validation before the
      // resolver), or INTERNAL_SERVER_ERROR. Any non-success is acceptable.
      expect(result.ok, `${name}.${firstMethod} returned success with null provider!`).toBe(false)
    })
  }
})
