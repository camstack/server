import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerHealthRoutes } from '../health.routes'

describe('GET /api/release-identity', () => {
  it('returns the product release and the server package, and not the cluster', async () => {
    const app = Fastify()
    registerHealthRoutes(app, {
      moleculer: {
        broker: {
          call: async () => {
            throw new Error('release identity must not call the broker')
          },
        },
      },
      agentRegistry: { listNodeLiveness: () => [] },
      hubVersion: '1.2.621',
      productVersion: '0.1.0',
      isReady: () => true,
      verifyToken: () => {
        throw new Error('unauthenticated')
      },
    })
    const res = await app.inject({ method: 'GET', url: '/api/release-identity' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ productVersion: '0.1.0', serverVersion: '1.2.621' })
    await app.close()
  })
})
