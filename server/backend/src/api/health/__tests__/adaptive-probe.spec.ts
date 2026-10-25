/**
 * `/adaptive-probe`: a 1 MiB body that must cross the wire whole (it is the
 * measurement), and that must not be an open amplifier (D635 round 3, I6).
 *
 * `@fastify/compress` is registered globally in `main.ts` and its default
 * compressible types include `octet-stream`, so a blob of one repeated byte
 * left the hub as a few hundred gzipped bytes: the client "measured" a round
 * trip, not a transfer.
 */
import { gzipSync } from 'node:zlib'
import Fastify from 'fastify'
import fastifyCompress from '@fastify/compress'
import { describe, it, expect } from 'vitest'
import { createRateLimiter } from '../../../auth/auth-rate-limit.js'
import {
  ADAPTIVE_PROBE_BYTES,
  registerAdaptiveProbeRoute,
  type AdaptiveProbeRouteDeps,
} from '../adaptive-probe.routes.js'

/** Session-grade for "Bearer good"; anything else is rejected, as `AuthService` would. */
const verifyToken = (token: string): unknown => {
  if (token === 'good') return { userId: 'u1', isAdmin: false }
  throw new Error('invalid token')
}

async function app(deps: Partial<AdaptiveProbeRouteDeps> = {}) {
  const f = Fastify()
  // The production registration (main.ts).
  await f.register(fastifyCompress, { global: true, threshold: 1024 })
  registerAdaptiveProbeRoute(f, {
    verifyToken,
    limiter: createRateLimiter({ windowMs: 60_000, max: 1_000 }),
    ...deps,
  })
  return f
}

describe('/adaptive-probe', () => {
  it('is never compressed, even when the client accepts gzip and br', async () => {
    const f = await app()
    const res = await f.inject({
      method: 'GET',
      url: '/adaptive-probe',
      headers: { 'accept-encoding': 'gzip, deflate, br', authorization: 'Bearer good' },
    })
    await f.close()
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.rawPayload.byteLength).toBe(ADAPTIVE_PROBE_BYTES)
  })

  it('is incompressible, so a compressing proxy on the way cannot shrink it either', async () => {
    const f = await app()
    const res = await f.inject({
      method: 'GET',
      url: '/adaptive-probe',
      headers: { authorization: 'Bearer good' },
    })
    await f.close()
    expect(gzipSync(res.rawPayload).byteLength).toBeGreaterThan(ADAPTIVE_PROBE_BYTES * 0.99)
  })

  it('requires a session: no credential, or a bad one, is 401 with no body to amplify', async () => {
    const f = await app()
    const anon = await f.inject({ method: 'GET', url: '/adaptive-probe' })
    const bad = await f.inject({
      method: 'GET',
      url: '/adaptive-probe',
      headers: { authorization: 'Bearer nope' },
    })
    const cookie = await f.inject({
      method: 'GET',
      url: '/adaptive-probe',
      headers: { cookie: 'camstack_session=good' },
    })
    await f.close()
    expect(anon.statusCode).toBe(401)
    expect(anon.rawPayload.byteLength).toBeLessThan(200)
    expect(bad.statusCode).toBe(401)
    // The session cookie a hub-served page carries is a session too.
    expect(cookie.statusCode).toBe(200)
  })

  it('is rate-limited per client: past the window budget it answers 429, not 1 MiB', async () => {
    const f = await app({ limiter: createRateLimiter({ windowMs: 60_000, max: 2 }) })
    const codes: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const res = await f.inject({
        method: 'GET',
        url: '/adaptive-probe',
        headers: { authorization: 'Bearer good' },
      })
      codes.push(res.statusCode)
    }
    await f.close()
    expect(codes).toEqual([200, 200, 429])
  })

  it('is 1 MiB — enough transfer at 8 Mbps (~1 s) to dwarf timer jitter', () => {
    expect(ADAPTIVE_PROBE_BYTES).toBe(1024 * 1024)
  })
})
