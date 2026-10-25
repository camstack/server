import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerDeployBundleRoute, getDeployStageRegistry } from '../addon-upload'

async function build() {
  const app = Fastify()
  registerDeployBundleRoute(app)
  await app.ready()
  return app
}

describe('GET /api/addons/deploy-bundle/:id', () => {
  it('streams the staged bytes with a valid token, single-use', async () => {
    const app = await build()
    const staged = getDeployStageRegistry().stage(Buffer.from('TGZBYTES'))
    const ok = await app.inject({
      method: 'GET',
      url: `/api/addons/deploy-bundle/${staged.id}`,
      headers: { authorization: `Bearer ${staged.token}` },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.rawPayload.toString()).toBe('TGZBYTES')
    const again = await app.inject({
      method: 'GET',
      url: `/api/addons/deploy-bundle/${staged.id}`,
      headers: { authorization: `Bearer ${staged.token}` },
    })
    expect(again.statusCode).toBe(404)
    await app.close()
  })
  it('401s a wrong token', async () => {
    const app = await build()
    const staged = getDeployStageRegistry().stage(Buffer.from('X'))
    const res = await app.inject({
      method: 'GET',
      url: `/api/addons/deploy-bundle/${staged.id}`,
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
  it('401s when no authorization header is provided', async () => {
    const app = await build()
    const staged = getDeployStageRegistry().stage(Buffer.from('Y'))
    const res = await app.inject({
      method: 'GET',
      url: `/api/addons/deploy-bundle/${staged.id}`,
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
