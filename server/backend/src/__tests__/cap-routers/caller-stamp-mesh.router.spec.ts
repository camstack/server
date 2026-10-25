/**
 * Mesh / $core-caps calls have no HTTP request behind them (`createMeshTrpcContext`).
 * The transport stamps `callerAddonId`; the mount must NOT strip it on that path.
 */
import { describe, expect, it, vi } from 'vitest'
import { createCapRouter_integrations } from '../../api/trpc/generated-cap-routers.js'
import { createMeshTrpcContext } from '../../api/trpc/trpc.context.js'
import {
  buildCapRouterForTest,
  invokeProcedure,
  makeCtx,
  type CreateCallerCapableRouter,
} from './harness.js'

const MESH_CALLER = 'bosch-home-connect'

type IntegrationsProvider = NonNullable<
  ReturnType<Parameters<typeof createCapRouter_integrations>[0]>
>

function generatedIntegrationsRouter(spy: ReturnType<typeof vi.fn>): CreateCallerCapableRouter {
  const provider = new Proxy({} as IntegrationsProvider, { get: () => spy })
  return createCapRouter_integrations(() => provider) as CreateCallerCapableRouter
}

describe('caller stamp survives mesh / core-cap bridge context', () => {
  it('integrations.getSettings (runtime builder): transport stamp reaches the provider', async () => {
    const spy = vi.fn(async (_input: unknown) => ({}))
    const provider = new Proxy({}, { get: () => spy })
    const router = buildCapRouterForTest('integrations', () => provider)
    const meshCtx = createMeshTrpcContext('mesh')
    expect(meshCtx.req).toBeUndefined()

    await invokeProcedure(router, 'getSettings', meshCtx, {
      id: 'int_0001',
      callerAddonId: MESH_CALLER,
    })

    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0]?.[0]).toEqual({
      id: 'int_0001',
      callerAddonId: MESH_CALLER,
    })
  })

  it('integrations.getSettings (generated mount): mesh keeps stamp; HTTP strips spoof', async () => {
    const spy = vi.fn(async (_input: unknown) => ({}))
    const router = generatedIntegrationsRouter(spy)

    const meshCtx = createMeshTrpcContext('mesh')
    await invokeProcedure(router, 'getSettings', meshCtx, {
      id: 'int_0001',
      callerAddonId: MESH_CALLER,
    })
    expect(spy.mock.calls[0]?.[0]).toEqual({
      id: 'int_0001',
      callerAddonId: MESH_CALLER,
    })

    spy.mockClear()
    await invokeProcedure(router, 'getSettings', makeCtx('admin'), {
      id: 'int_0001',
      callerAddonId: MESH_CALLER,
    })
    expect(spy.mock.calls[0]?.[0]).toEqual({ id: 'int_0001' })
  })
})
