import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { proxyToUpstream } from '../reverse-proxy.js'

const servers: Server[] = []

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  return address.port
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((err) => (err === undefined ? resolve() : reject(err))),
          ),
      ),
  )
})

describe('proxyToUpstream', () => {
  it('replays a request body already consumed by the host framework', async () => {
    let received = ''
    const upstreamPort = await listen(
      createServer((req, res) => {
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => {
          received += chunk
        })
        req.on('end', () => res.writeHead(204).end())
      }),
    )
    const proxyPort = await listen(
      createServer((req, res) => {
        req.resume()
        req.on('end', () => {
          proxyToUpstream({
            baseUrl: `http://127.0.0.1:${upstreamPort}`,
            secret: 'test-secret',
            upstreamPath: req.url ?? '/',
            clientReq: req,
            clientRes: res,
            replayBody: Buffer.from('{"data":"q"}'),
          })
        })
      }),
    )

    const response = await fetch(`http://127.0.0.1:${proxyPort}/terminal/in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"ignored":"raw stream was consumed"}',
    })

    expect(response.status).toBe(204)
    expect(received).toBe('{"data":"q"}')
  })

  it('keeps the CORS headers the edge stamped on the hijacked response (D707)', async () => {
    const upstreamPort = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'image/jpeg' }).end('image')
      }),
    )
    const proxyPort = await listen(
      createServer((req, res) => {
        // What the hub's onRequest hook does before `reply.hijack()`.
        res.setHeader('access-control-allow-origin', 'null')
        res.setHeader('vary', 'Origin')
        proxyToUpstream({
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          secret: 'test-secret',
          upstreamPath: req.url ?? '/',
          clientReq: req,
          clientRes: res,
        })
      }),
    )

    const response = await fetch(`http://127.0.0.1:${proxyPort}/event-media/1`, {
      headers: { origin: 'null', authorization: 'Bearer test' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('null')
    expect(await response.text()).toBe('image')
  })

  it('drops an upstream CORS policy — the edge owns it, and a `*` must not reach a refused origin', async () => {
    const upstreamPort = await listen(
      createServer((_req, res) => {
        res
          .writeHead(206, {
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'content-range',
            'content-range': 'bytes 0-1/10',
            vary: 'Accept-Encoding',
          })
          .end('ok')
      }),
    )
    const proxyPort = await listen(
      createServer((req, res) => {
        // The edge refused this origin: it stamped Vary only, no grant.
        res.setHeader('vary', 'Origin')
        proxyToUpstream({
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          secret: 'test-secret',
          upstreamPath: req.url ?? '/',
          clientReq: req,
          clientRes: res,
        })
      }),
    )

    const response = await fetch(`http://127.0.0.1:${proxyPort}/custom-cors`, {
      headers: { origin: 'https://evil.example' },
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-expose-headers')).toBeNull()
    expect(response.headers.get('content-range')).toBe('bytes 0-1/10')
    expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding')
  })
})
