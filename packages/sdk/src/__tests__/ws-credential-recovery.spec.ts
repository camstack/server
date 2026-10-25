/**
 * A bearer the hub no longer honours (expired, revoked) must be recovered over
 * HTTP, never over the socket that the hub is about to close with 4401.
 *
 * The incident: the client refreshed ON the same socket the server had just
 * closed, the pending call rejected with a bare "WebSocket closed" (no
 * `data.code`), the keeper took that for a transient failure and reconnected
 * with the same dead token, round and round until the user was signed out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { System } from '../system.js'

function jwtWithExp(exp: number): string {
  const b64 = (v: object): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ exp })}.sig`
}

const EXPIRED_JWT = jwtWithExp(Math.floor(Date.now() / 1000) - 3600)

interface Handshake {
  readonly socket: number
  readonly token: string | undefined
}

class FakeSocket {
  static instances: FakeSocket[] = []
  /** Tokens the "hub" refuses: it closes such a socket with 4401, like the real one. */
  static dead = new Set<string>()
  static handshakes: Handshake[] = []
  static wsMessages: string[] = []
  readyState = 0
  private listeners = new Map<string, Array<(ev: unknown) => void>>()
  readonly index: number
  constructor(readonly url: string) {
    this.index = FakeSocket.instances.length
    FakeSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = 1
      this.emit('open', {})
    }, 0)
  }
  send(raw: string): void {
    FakeSocket.wsMessages.push(raw)
    const msg: unknown = JSON.parse(raw)
    if (typeof msg !== 'object' || msg === null) return
    if (Reflect.get(msg, 'method') !== 'connectionParams') return
    const data: unknown = Reflect.get(msg, 'data')
    const token: unknown =
      data !== null && typeof data === 'object' ? Reflect.get(data, 'token') : undefined
    const tok = typeof token === 'string' ? token : undefined
    FakeSocket.handshakes.push({ socket: this.index, token: tok })
    if (tok !== undefined && FakeSocket.dead.has(tok)) {
      setTimeout(() => {
        this.readyState = 3
        this.emit('close', { code: 4401, reason: 'session ended' })
      }, 0)
    }
  }
  close(): void {
    this.readyState = 3
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  removeEventListener(): void {}
  private emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }
}

function trpcOk(data: unknown): Response {
  return new Response(JSON.stringify({ result: { data: { json: data } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function trpcUnauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: {
        json: { message: 'refused', code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401 } },
      },
    }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  )
}

const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  vi.unstubAllGlobals()
  FakeSocket.instances = []
  FakeSocket.dead = new Set()
  FakeSocket.handshakes = []
  FakeSocket.wsMessages = []
})

function stub(fetchImpl: (url: string) => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => fetchImpl(String(input)))
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function fetchedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]))
}

describe('credential recovery over HTTP', () => {
  it('a socket closed 4401 refreshes over HTTP and reconnects with the NEW token', async () => {
    const fetchMock = stub(() =>
      trpcOk({ token: 'tok-new', refreshToken: 'rt-2', expiresAt: Date.now() + 7_200_000 }),
    )
    FakeSocket.dead.add('tok-old')
    const sys: System = new System({
      serverUrl: 'http://hub.test',
      token: 'tok-old',
      useWebSocket: true,
      retryDelayMs: 1,
      refreshCredential: async () => {
        await sys.refreshSession('rt-1')
      },
    })
    await settle()

    expect(FakeSocket.handshakes[0]?.token).toBe('tok-old')
    expect(FakeSocket.handshakes.at(-1)?.token).toBe('tok-new')
    expect(fetchedUrls(fetchMock).some((u) => u.includes('auth.refreshSession'))).toBe(true)
    expect(FakeSocket.wsMessages.some((m) => m.includes('refreshSession'))).toBe(false)
    sys.close()
  })

  it('never handshakes an access token that has already expired: refreshes first', async () => {
    stub(() =>
      trpcOk({ token: 'tok-new', refreshToken: 'rt-2', expiresAt: Date.now() + 7_200_000 }),
    )
    const sys: System = new System({
      serverUrl: 'http://hub.test',
      token: EXPIRED_JWT,
      useWebSocket: true,
      retryDelayMs: 1,
      refreshCredential: async () => {
        await sys.refreshSession('rt-1')
      },
    })
    await settle()

    expect(FakeSocket.handshakes.map((h) => h.token)).toEqual(['tok-new'])
    sys.close()
  })

  it('a refused refresh never puts the dead token on the wire (anonymous handshake)', async () => {
    stub(() => trpcUnauthorized())
    const sys: System = new System({
      serverUrl: 'http://hub.test',
      token: EXPIRED_JWT,
      useWebSocket: true,
      retryDelayMs: 1,
      refreshCredential: async () => {
        await sys.refreshSession('rt-1')
      },
    })
    await settle()

    expect(FakeSocket.handshakes.length).toBeGreaterThan(0)
    expect(FakeSocket.handshakes.every((h) => h.token === undefined)).toBe(true)
    sys.close()
  })

  it('pre-auth calls (listLoginMethods) go over HTTP even on a socket System', async () => {
    const fetchMock = stub(() => trpcOk([]))
    const sys = new System({ serverUrl: 'http://hub.test', useWebSocket: true, retryDelayMs: 1 })
    await sys.trpcClient.auth.listLoginMethods.query()
    expect(fetchedUrls(fetchMock).some((u) => u.includes('auth.listLoginMethods'))).toBe(true)
    expect(FakeSocket.wsMessages.some((m) => m.includes('listLoginMethods'))).toBe(false)
    sys.close()
  })
})
