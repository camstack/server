/**
 * A form posted through an addon data plane reaches the addon as the exact
 * bytes the client sent, under the original content-type (a vendor sign-in page
 * proxied through the hub used to receive JSON under a urlencoded header).
 */
import { createServer, IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import type { IScopedLogger } from '@camstack/types'
import { proxyToUpstream } from '../../../../../../packages/system/src/http/reverse-proxy.js'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dataPlaneReplayBody, registerFormBodyParser } from '../form-body.js'

interface Received {
  readonly contentType: string | undefined
  readonly body: string
}

function logger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

async function readAll(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
})

async function startUpstream(received: Received[]): Promise<string> {
  const server = createServer((req, res) => {
    void readAll(req).then((body) => {
      received.push({ contentType: req.headers['content-type'], body })
      res.writeHead(200).end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no upstream port')
  return `http://127.0.0.1:${address.port}`
}

async function startHub(upstream: string, log: IScopedLogger): Promise<FastifyInstance> {
  const fastify = Fastify()
  registerFormBodyParser(fastify)
  // The data-plane branch of main.ts: parsed body in, replay bytes out.
  fastify.post('/ax/*', async (request, reply) => {
    const replayBody = dataPlaneReplayBody(request.raw, request.body, log)
    if (replayBody === null) return reply.status(500).send({ error: 'unforwardable' })
    reply.hijack()
    proxyToUpstream({
      baseUrl: upstream,
      secret: 's',
      upstreamPath: request.url,
      clientReq: request.raw,
      clientRes: reply.raw,
      ...(replayBody !== undefined ? { replayBody } : {}),
    })
    return reply
  })
  await fastify.ready()
  closers.push(() => fastify.close())
  return fastify
}

describe('data-plane form body', () => {
  it('replays a urlencoded POST byte-identical, with its content-type', async () => {
    const received: Received[] = []
    const hub = await startHub(await startUpstream(received), logger())
    const form = 'a=1&a=2&email=gianluca%2Btest%40example.com&q=%E2%9C%93+caf%C3%A9'
    const res = await hub.inject({
      method: 'POST',
      url: '/ax/claim',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form,
    })
    expect(res.statusCode).toBe(200)
    expect(received).toEqual([{ contentType: 'application/x-www-form-urlencoded', body: form }])
  })

  it('refuses and logs a parsed form object that has no recorded raw bytes', () => {
    const log = logger()
    const raw = new IncomingMessage(new Socket())
    raw.headers['content-type'] = 'application/x-www-form-urlencoded'
    expect(dataPlaneReplayBody(raw, { a: '1' }, log)).toBeNull()
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it('still hands the parsed object to hub routes (oauth2 consent / token)', async () => {
    const fastify = Fastify()
    registerFormBodyParser(fastify)
    fastify.post('/echo', async (request) => request.body)
    const res = await fastify.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1&a=2&b=%20x',
    })
    expect(res.json()).toEqual({ a: '2', b: ' x' })
  })
})
