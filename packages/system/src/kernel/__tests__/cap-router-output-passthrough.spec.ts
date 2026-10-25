/**
 * Regression: the runtime cap-router builder forwards provider output
 * VERBATIM — it must NOT re-validate/strip against the cap def's output
 * schema (Lever 1, 2026-07-11).
 *
 * WHY: the hub loads a framework-versioned `@camstack/types` that can lag a
 * freshly-deployed self-contained addon. Applying `.output(schema).parse()`
 * at the hub silently stripped fields the newer addon added — that is how
 * `models[].group.resolution` vanished from `pipelineExecutor.getSchema`.
 * Cap dispatch is structural; the owning provider is the sole authority for
 * the payload shape.
 *
 * This spec uses REAL tRPC primitives (unlike `cap-router-builder.spec.ts`,
 * whose fake `output()` is a no-op and cannot detect stripping).
 */
import { describe, it, expect } from 'vitest'
import { initTRPC } from '@trpc/server'
import {
  buildCapRouters,
  type CapRouterPrimitives,
  type CapRouterServices,
  type ProcedureBuilder,
} from '../cap-router-builder.js'

interface CallableRouter {
  readonly createCaller: (ctx: unknown) => Record<string, (input?: unknown) => Promise<unknown>>
}

describe('cap-router-builder — output pass-through (Lever 1)', () => {
  it('forwards a field absent from the cap output schema instead of stripping it', async () => {
    const t = initTRPC.create()

    const primitives: CapRouterPrimitives = {
      router: (procs) => t.router(procs as Parameters<typeof t.router>[0]),
      procedures: {
        public: t.procedure as unknown as ProcedureBuilder,
        protected: t.procedure as unknown as ProcedureBuilder,
        admin: t.procedure as unknown as ProcedureBuilder,
      },
      iterableSubscription: async function* () {
        /* subscriptions not exercised here */
      } as unknown as CapRouterPrimitives['iterableSubscription'],
    }

    // Every method returns an object carrying a nested key no cap output
    // schema declares. Pre-Lever-1 the builder's `.output(schema).parse()`
    // would strip `__probe` (or throw on the missing required fields);
    // post-Lever-1 it is forwarded verbatim.
    const PROBE = { __probe: { nested: 'survives', resolution: 320 } }
    const provider = new Proxy({}, { get: () => async () => PROBE }) as Readonly<
      Record<string, () => Promise<unknown>>
    >

    const services: CapRouterServices = {
      getLocalProvider: () => provider,
      remoteProxy: () => null,
      noProvider: (capName) => {
        throw new Error(`no provider ${capName}`)
      },
      noNodeRouting: (capName) => {
        throw new Error(`no node routing ${capName}`)
      },
      badRequest: (message) => {
        throw new Error(message)
      },
    }

    const routers = buildCapRouters(primitives, services) as Record<string, CallableRouter>
    const pipelineExecutor = routers['pipelineExecutor']
    expect(pipelineExecutor).toBeDefined()
    // `expect` does not narrow — fail loudly rather than dereference undefined.
    if (!pipelineExecutor) throw new Error('buildCapRouters returned no pipelineExecutor router')

    const caller = pipelineExecutor.createCaller({})
    const result = await caller['getSchema']?.({})

    // The whole probe object survives untouched — no field stripping, no
    // parse rejection.
    expect(result).toEqual(PROBE)
  })
})
