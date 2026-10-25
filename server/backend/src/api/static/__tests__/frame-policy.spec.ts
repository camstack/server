import * as fs from 'node:fs'
import * as path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FRAME_ANCESTORS_POLICY, isFramePolicyTarget, registerFramePolicy } from '../frame-policy'

/**
 * Every HTML document the hub serves says who may frame it: itself, and
 * nobody else (D425). Cross-origin hosts — Home Assistant — reach the hub
 * through a relay on THEIR origin, so from the browser's side that frame is
 * same-origin too. A direct cross-origin frame never carried the session
 * (`SameSite=Lax`) and is now refused by policy instead of failing halfway.
 *
 * The header is added at the response layer, not per route: a shell-send
 * site added later (the failure `spa-shell-cache-headers.spec.ts` guards
 * against for the cache policy) must not be able to ship unframed.
 */

describe('isFramePolicyTarget', () => {
  it('is every HTML document, whatever its charset suffix', () => {
    expect(isFramePolicyTarget('text/html')).toBe(true)
    expect(isFramePolicyTarget('text/html; charset=utf-8')).toBe(true)
    expect(isFramePolicyTarget('TEXT/HTML')).toBe(true)
  })

  it('is not an asset, a JSON body, a stream or an untyped reply', () => {
    expect(isFramePolicyTarget('application/json; charset=utf-8')).toBe(false)
    expect(isFramePolicyTarget('text/javascript; charset=utf-8')).toBe(false)
    expect(isFramePolicyTarget('image/jpeg')).toBe(false)
    expect(isFramePolicyTarget('text/event-stream')).toBe(false)
    expect(isFramePolicyTarget(undefined)).toBe(false)
    expect(isFramePolicyTarget(42)).toBe(false)
  })
})

describe('registerFramePolicy (fastify inject)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify()
    registerFramePolicy(app)
    app.get('/shell', async (_request, reply) =>
      reply.type('text/html; charset=utf-8').send('<html><head></head></html>'),
    )
    app.get('/asset.js', async (_request, reply) =>
      reply.type('text/javascript; charset=utf-8').send('export {}'),
    )
    app.get('/api/x', async () => ({ ok: true }))
    app.get('/own-policy', async (_request, reply) =>
      reply
        .type('text/html')
        .header('content-security-policy', "frame-ancestors 'none'")
        .send('<html></html>'),
    )
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('an HTML document may be framed only by its own origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/shell' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-security-policy']).toBe(FRAME_ANCESTORS_POLICY)
    expect(FRAME_ANCESTORS_POLICY).toBe("frame-ancestors 'self'")
  })

  it('a script, an API body: no document, no policy', async () => {
    const asset = await app.inject({ method: 'GET', url: '/asset.js' })
    expect(asset.headers['content-security-policy']).toBeUndefined()
    const api = await app.inject({ method: 'GET', url: '/api/x' })
    expect(api.headers['content-security-policy']).toBeUndefined()
  })

  it('a route that states its own policy keeps it — the default never overwrites', async () => {
    const res = await app.inject({ method: 'GET', url: '/own-policy' })
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'")
  })
})

describe('main.ts registers the policy on the ONE Fastify instance', () => {
  it('registerFramePolicy(fastify) is called', () => {
    const main = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'main.ts'), 'utf-8')
    expect(main).toContain('registerFramePolicy(fastify)')
  })
})
