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
