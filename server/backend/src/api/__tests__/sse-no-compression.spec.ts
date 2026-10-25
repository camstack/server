/**
 * SSE must never enter the compressor — see `../sse-no-compression.ts`.
 *
 * The repro models the tRPC subscription transport faithfully: the route
 * replies with a STREAM and never sets a Fastify-level Content-Type, which is
 * the condition that makes `@fastify/compress` fall back to
 * `'application/json'` and gzip the body. The two cases differ ONLY in the
 * request's Accept header, so together they pin both halves: the compressor
 * is live (json case) and the SSE request escapes it (event-stream case).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fastifyCompress from '@fastify/compress'
import Fastify, { type FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
import { markSseRequestNoCompression } from '../sse-no-compression.js'

const BODY = 'data: x\n\n'.repeat(500) // comfortably past the 1024B threshold

describe('SSE compression opt-out', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify()
    app.addHook('onRequest', async (request) => {
      markSseRequestNoCompression(request)
    })
    await app.register(fastifyCompress, { global: true, threshold: 1024 })
    // No content-type set at the Fastify layer — the tRPC-transport condition.
    app.get('/stream', (_req, reply) => reply.send(Readable.from([BODY])))
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('leaves an SSE request uncompressed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/stream',
      headers: { accept: 'text/event-stream', 'accept-encoding': 'gzip' },
    })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body).toContain('data: x')
  })

  it('still compresses the same reply for a JSON consumer — the compressor is live', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/stream',
      headers: { accept: 'application/json', 'accept-encoding': 'gzip' },
    })
    expect(res.headers['content-encoding']).toBe('gzip')
  })

  it('marks only event-stream requests', () => {
    const sse = { headers: { accept: 'text/event-stream' } }
    const json = { headers: { accept: 'application/json' } }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- minimal request stand-ins
    expect(markSseRequestNoCompression(sse as never)).toBe(true)
    expect(markSseRequestNoCompression(json as never)).toBe(false)
    expect(sse.headers).toHaveProperty('x-no-compression')
    expect(json.headers).not.toHaveProperty('x-no-compression')
  })
})
