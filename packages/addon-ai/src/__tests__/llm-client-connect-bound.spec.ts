/**
 * What the CONNECT bound is allowed to measure — against real sockets.
 *
 * ## The live failure this file exists for
 *
 * The operator hit it twice: a COLD model on LM Studio answered
 * `unavailable: the endpoint did not accept the connection within 10s — check
 * that the provider is running and the base URL is right`. Nothing about that
 * sentence was true. LM Studio had accepted the TCP connection, read the
 * request, and was loading qwen3-vl into the GPU — minutes of work — and only
 * sends its response headers afterwards. The old `openStream` put that wait
 * under the 10 s CONNECT bound, so a cold load landed in the bucket labelled
 * "the box is off" and the page told the operator to go check a base URL that
 * was correct.
 *
 * So the bounds are re-cut along the line the taxonomy always claimed:
 *
 *   CONNECT      the TCP handshake, and nothing else. A closed port fails
 *                immediately (ECONNREFUSED); a black-holed address takes the
 *                whole bound. Ten seconds is right for THAT question.
 *   FIRST TOKEN  everything from "the endpoint accepted" to "the model said
 *                something" — response headers INCLUDED, because on this wire
 *                the headers are what the model emits when it has finished
 *                loading.
 *
 * These tests use real listeners on 127.0.0.1 rather than an injected `fetch`:
 * an injected fetch cannot tell a socket that never connects from a socket that
 * connects and stays silent, which is the entire distinction under test. The
 * one exception is the black-hole case — a connect that never completes is not
 * reproducible on loopback, so that single path drives an injected connector.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ProbeSocket, tcpEndpointOf } from '../client/connect-probe.js'
import { createLlmClient } from '../client/llm-client.js'
import type { StreamChunk } from '../test-chat/run-stream.js'
import { makeProfile } from './support/profile.js'

const neverAborts = (): AbortSignal => new AbortController().signal

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
} as const

function sseChunk(text: string): string {
  return `data: ${JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    model: 'test',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`
}

const SSE_STOP = `data: ${JSON.stringify({
  id: 'c1',
  object: 'chat.completion.chunk',
  model: 'test',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
})}\n\ndata: [DONE]\n\n`

interface Fake {
  readonly baseUrl: string
  readonly port: number
  /** Resolves the moment the server has a request in hand. */
  readonly requestSeen: Promise<void>
  close: () => Promise<void>
}

/**
 * A provider that behaves like a cold LM Studio: it ACCEPTS, reads the request,
 * then goes quiet for `headerDelayMs` before writing a single byte of response.
 * `null` means it never answers at all.
 */
function fakeProvider(options: {
  readonly headerDelayMs: number | null
  readonly tokenDelayMs?: number
  /** When set, a SECOND token this long after the first — an answer that keeps
   *  going. `undefined` closes right after the first. */
  readonly tailDelayMs?: number
}): Promise<Fake> {
  let sawRequest: () => void = () => undefined
  const requestSeen = new Promise<void>((resolve) => {
    sawRequest = resolve
  })
  const timers: ReturnType<typeof setTimeout>[] = []

  const server = createServer((req, res) => {
    req.resume()
    sawRequest()
    if (options.headerDelayMs === null) return
    timers.push(
      setTimeout(() => {
        res.writeHead(200, SSE_HEADERS)
        const body = new PassThrough()
        body.pipe(res)
        timers.push(
          setTimeout(() => {
            body.write(sseChunk('ok'))
            if (options.tailDelayMs === undefined) {
              body.end(SSE_STOP)
              return
            }
            timers.push(
              setTimeout(() => {
                body.write(sseChunk('tail'))
                body.end(SSE_STOP)
              }, options.tailDelayMs),
            )
          }, options.tokenDelayMs ?? 0),
        )
      }, options.headerDelayMs),
    )
  })

  return new Promise<Fake>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        port,
        requestSeen,
        close: async () => {
          for (const timer of timers) clearTimeout(timer)
          await new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
        },
      })
    })
  })
}

/** A port nothing listens on: bind, learn the number, give it back. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/**
 * A connector that dials forever: never `connect`, never `error`. Structural,
 * so it satisfies `ProbeSocket` without pretending to be a `net.Socket`.
 */
class BlackHoleSocket implements ProbeSocket {
  destroyed = false
  once(): this {
    return this
  }
  destroy(): void {
    this.destroyed = true
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function client(deps: Parameters<typeof createLlmClient>[0] = {}) {
  return createLlmClient(deps)
}

function streamRequest(baseUrl: string) {
  return {
    profile: makeProfile({ baseUrl, model: 'qwen/qwen3-vl-8b' }),
    prompt: 'ping',
    signal: neverAborts(),
  }
}

describe('openStream — the connect bound measures the SOCKET, not the model', () => {
  it('opens the stream even though the headers arrive long after the connect bound', async () => {
    // The live bug, in miniature: headers at 1 s, connect bound at 250 ms.
    // Under the old shape this returned `connect-timeout` and the page blamed
    // the endpoint. The endpoint was fine; the model was loading. The bound
    // leaves a loaded CI runner room to complete a loopback TCP connect: at
    // 40 ms the connect itself timed out there and the spec went red.
    const fake = await fakeProvider({ headerDelayMs: 1_000 })
    cleanups.push(fake.close)

    const outcome = await client().openStream(streamRequest(fake.baseUrl), {
      connectTimeoutMs: 250,
      firstTokenTimeoutMs: 5_000,
    })

    expect(outcome.kind).toBe('open')
    if (outcome.kind !== 'open') return
    const texts: string[] = []
    for await (const chunk of outcome.chunks) {
      if (chunk.kind === 'token') texts.push(chunk.text)
    }
    expect(texts.join('')).toBe('ok')
  })

  it('opens on the FIRST token, not on the last one', async () => {
    // The second half of the live bug. `stream.response` reads like a header
    // edge and is not one — measured here, it settles only when the generation
    // ENDS. `openStream` therefore pulls the token stream itself, so "open"
    // means "the model started" and a long answer is not a failed one.
    const fake = await fakeProvider({ headerDelayMs: 20, tokenDelayMs: 60, tailDelayMs: 700 })
    cleanups.push(fake.close)

    const startedAt = Date.now()
    const outcome = await client().openStream(streamRequest(fake.baseUrl), {
      connectTimeoutMs: 1_000,
      firstTokenTimeoutMs: 5_000,
    })
    const openedAfterMs = Date.now() - startedAt

    expect(outcome.kind).toBe('open')
    // The tail is still 700 ms away. Under the old shape this call returned
    // only after it, and every token reached the browser in one late burst.
    expect(openedAfterMs).toBeLessThan(500)
  })

  it('a closed port is a network failure NAMING the refusal, well inside the bound', async () => {
    const port = await closedPort()
    const startedAt = Date.now()

    const outcome = await client().openStream(
      streamRequest(`http://127.0.0.1:${String(port)}/v1`),
      { connectTimeoutMs: 10_000, firstTokenTimeoutMs: 5_000 },
    )

    expect(outcome.kind).toBe('network')
    if (outcome.kind !== 'network') return
    expect(outcome.message).toMatch(/ECONNREFUSED/)
    // Immediately — never the whole connect budget. Being told a port is shut
    // in ten seconds is the answer this bound exists to avoid.
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('a socket that never completes its handshake IS a connect timeout', async () => {
    // The one path loopback cannot produce: a black-holed address. The
    // connector is injected so the wait is deterministic rather than a real
    // unroutable IP, which behaves differently on every network.
    const sockets: BlackHoleSocket[] = []
    const outcome = await client({
      connectImpl: () => {
        const socket = new BlackHoleSocket()
        sockets.push(socket)
        return socket
      },
    }).openStream(streamRequest('http://192.0.2.10:1234/v1'), {
      connectTimeoutMs: 60,
      firstTokenTimeoutMs: 5_000,
    })

    expect(outcome).toEqual({ kind: 'connect-timeout', timeoutMs: 60 })
    // And the probe let go of it — a bound that leaves the socket dialling has
    // only moved the leak.
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.destroyed).toBe(true)
  })

  it('an endpoint that accepts and then never answers fails on the FIRST-TOKEN budget', async () => {
    // Same silence as a black hole from the outside — but the socket is up, so
    // the honest sentence is "the model produced nothing", not "the box is off".
    const fake = await fakeProvider({ headerDelayMs: null })
    cleanups.push(fake.close)

    const outcome = await client().openStream(streamRequest(fake.baseUrl), {
      connectTimeoutMs: 10_000,
      firstTokenTimeoutMs: 150,
    })

    expect(outcome).toEqual({ kind: 'first-token-timeout', timeoutMs: 150 })
  })

  it('a refusal keeps its OWN code — a bad key never reads as an endpoint that is down', async () => {
    // `streamText` does not throw here: a 401 ends the token stream with a
    // plain `{done:true}` and hands the real error to `onError`. Without
    // capturing it the run would report a perfectly reachable endpoint as
    // silent — which is how "the model produced nothing" ends up describing a
    // wrong API key.
    const server = createServer((req, res) => {
      req.resume()
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid api key' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    )

    const outcome = await client().openStream(
      streamRequest(`http://127.0.0.1:${String(port)}/v1`),
      { connectTimeoutMs: 1_000, firstTokenTimeoutMs: 5_000 },
    )

    expect(outcome.kind).toBe('provider-error')
    if (outcome.kind !== 'provider-error') return
    expect(outcome.code).toBe('auth')
    expect(outcome.message).toMatch(/invalid api key/)
  })

  it('announces the accepted connection ONCE, before the header wait', async () => {
    const fake = await fakeProvider({ headerDelayMs: 60 })
    cleanups.push(fake.close)
    const onConnected = vi.fn()

    const outcome = await client().openStream(streamRequest(fake.baseUrl), {
      connectTimeoutMs: 1_000,
      firstTokenTimeoutMs: 5_000,
      onConnected,
    })

    expect(outcome.kind).toBe('open')
    expect(onConnected).toHaveBeenCalledTimes(1)
  })

  it('never announces a connection it did not get', async () => {
    const port = await closedPort()
    const onConnected = vi.fn()

    await client().openStream(streamRequest(`http://127.0.0.1:${String(port)}/v1`), {
      connectTimeoutMs: 1_000,
      firstTokenTimeoutMs: 5_000,
      onConnected,
    })

    expect(onConnected).not.toHaveBeenCalled()
  })

  it('drains an answer LONGER than the first-token bound — the bound is about starting', async () => {
    // The timer is armed with the first-token budget and cleared the moment
    // the first chunk lands. Left running it would cut a healthy generation
    // mid-sentence, which is a worse failure than the one being fixed.
    const fake = await fakeProvider({ headerDelayMs: 10, tokenDelayMs: 20, tailDelayMs: 300 })
    cleanups.push(fake.close)

    const outcome = await client().openStream(streamRequest(fake.baseUrl), {
      connectTimeoutMs: 1_000,
      firstTokenTimeoutMs: 120,
    })

    expect(outcome.kind).toBe('open')
    if (outcome.kind !== 'open') return
    const chunks: StreamChunk[] = []
    for await (const chunk of outcome.chunks) chunks.push(chunk)
    expect(chunks.filter((c) => c.kind === 'token').map((c) => c.text)).toEqual(['ok', 'tail'])
    // And the terminating chunk survives — it is what writes the usage row.
    expect(chunks.at(-1)?.kind).toBe('end')
  })
})

describe('generate — the unary path carries the same taxonomy', () => {
  it('a silent endpoint is a TIMEOUT that names the cold load, never `unavailable`', async () => {
    // `testProfile`, the AI confirm gate, the scene checks and the summaries
    // all land here: one total bound, no streaming. A cold load spends it the
    // same way a slow generation does, and the message has to point at the
    // model — `timed out after 60000ms` pointed at the network.
    const fake = await fakeProvider({ headerDelayMs: null })
    cleanups.push(fake.close)

    const result = await client().generate(streamRequest(fake.baseUrl), 150)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('timeout')
    expect(result.code).not.toBe('unavailable')
    expect(result.message).toMatch(/cold model/i)
    expect(result.message).not.toMatch(/did not accept the connection/i)
  })

  it('a closed port on the unary path is `unavailable` — and that one IS the endpoint', async () => {
    const port = await closedPort()
    const result = await client().generate(
      streamRequest(`http://127.0.0.1:${String(port)}/v1`),
      5_000,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('unavailable')
  })
})

describe('tcpEndpointOf', () => {
  it('reads host and port off a base URL, defaulting the port per scheme', () => {
    expect(tcpEndpointOf('http://192.168.10.50:1234/v1')).toEqual({
      host: '192.168.10.50',
      port: 1234,
    })
    expect(tcpEndpointOf('https://api.openai.com/v1')).toEqual({
      host: 'api.openai.com',
      port: 443,
    })
    expect(tcpEndpointOf('http://lm.lan/v1')).toEqual({ host: 'lm.lan', port: 80 })
  })

  it('strips the brackets an IPv6 URL carries — net.connect wants the bare address', () => {
    expect(tcpEndpointOf('http://[::1]:1234/v1')).toEqual({ host: '::1', port: 1234 })
  })

  it('returns null rather than inventing an endpoint it cannot probe', () => {
    expect(tcpEndpointOf('not a url')).toBeNull()
    expect(tcpEndpointOf('file:///models/v1')).toBeNull()
    expect(tcpEndpointOf('')).toBeNull()
  })
})
