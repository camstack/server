import { describe, expect, it } from 'vitest'
import { buildAddonRouteProvider } from '../addon/build-addon-route-provider.js'
import type { IAddonHttpRoute } from '../interfaces/addon-routes.js'

function providerEchoingParams() {
  const routes: IAddonHttpRoute[] = [
    {
      method: 'GET',
      path: '/:providerId/start',
      access: 'public',
      handler: async (req, reply) => {
        reply.send(req.params)
      },
    },
  ]
  return buildAddonRouteProvider('test', routes)
}

describe('buildAddonRouteProvider.invoke params', () => {
  it('extracts params from a concrete path', async () => {
    const env = await providerEchoingParams().invoke({
      method: 'GET',
      path: '/authentik/start',
      params: {},
      query: {},
      body: undefined,
      headers: {},
    })
    expect(env.body).toEqual({ providerId: 'authentik' })
  })

  it('keeps the params the hub matched when it is sent the route pattern', async () => {
    const env = await providerEchoingParams().invoke({
      method: 'GET',
      path: '/:providerId/start',
      params: { providerId: 'authentik' },
      query: {},
      body: undefined,
      headers: {},
    })
    expect(env.body).toEqual({ providerId: 'authentik' })
  })
})

describe('buildAddonRouteProvider.invoke instance (planning#415)', () => {
  function providerEchoingInstance() {
    const echo: IAddonHttpRoute['handler'] = async (req, reply) => {
      reply.send({ instanceId: req.instanceId ?? null })
    }
    return buildAddonRouteProvider('test', [
      { method: 'POST', path: '/directive', access: 'public', perInstance: true, handler: echo },
      { method: 'GET', path: '/health', access: 'public', handler: echo },
    ])
  }
  const call = { params: {}, query: {}, body: undefined, headers: {} }

  it('tells a per-instance handler the instance the hub resolved', async () => {
    const env = await providerEchoingInstance().invoke({
      ...call,
      method: 'POST',
      path: '/directive',
      instanceId: 'second',
    })
    expect(env.body).toEqual({ instanceId: 'second' })
  })

  it('tells a handler that is not per-instance no instance, whatever the wire carries', async () => {
    const env = await providerEchoingInstance().invoke({
      ...call,
      method: 'GET',
      path: '/health',
      instanceId: 'second',
    })
    expect(env.body).toEqual({ instanceId: null })
  })
})
