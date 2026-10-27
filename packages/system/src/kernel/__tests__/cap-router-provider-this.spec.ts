/**
 * Regression: an in-process provider that is a CLASS INSTANCE keeps its
 * `this` when the hub router invokes a method.
 *
 * WHY: `invokeCapMethod` read `provider[name]` and called it detached, so a
 * class method that touched `this.store` threw "Cannot read properties of
 * undefined (reading 'store')" — `actions.create` on a live hub (2026-10-27).
 * Providers written as object literals of arrow functions never noticed.
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

class ClassProvider {
  private readonly answer = { fromThis: true }

  async getSchema(): Promise<{ fromThis: boolean }> {
    return this.answer
  }
}

describe('cap-router-builder — class-instance provider', () => {
  it('invokes a method with the provider as `this`', async () => {
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
    const provider = new ClassProvider()
    const services: CapRouterServices = {
      // A class instance has no index signature; the router reads it by method name.
      getLocalProvider: () =>
        provider as unknown as ReturnType<CapRouterServices['getLocalProvider']>,
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
    if (!pipelineExecutor) throw new Error('buildCapRouters returned no pipelineExecutor router')

    const result = await pipelineExecutor.createCaller({})['getSchema']?.({})
    expect(result).toEqual({ fromThis: true })
  })
})
