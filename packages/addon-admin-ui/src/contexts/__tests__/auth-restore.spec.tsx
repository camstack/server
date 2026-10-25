/**
 * Cold restore of a stored session whose ACCESS token has expired but whose
 * refresh token is still good (the iPhone PWA reopened hours later).
 *
 * Runs the real AuthProvider, admin session keeper and SDK `System` against a
 * fake hub that behaves like the real one: it closes a socket whose bearer is
 * expired with code 4401, and answers `auth.refreshSession` over HTTP. The
 * session must survive; it used to be signed out because the refresh ran on
 * the very socket the hub was closing.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function jwt(exp: number): string {
  const b64 = (v: object): string => btoa(JSON.stringify(v)).replace(/=+$/, '')
  return `${b64({ alg: 'none' })}.${b64({ sub: 'u1', username: 'admin', isAdmin: true, exp, scopes: [] })}.sig`
}

const NOW_S = Math.floor(Date.now() / 1000)
const EXPIRED = jwt(NOW_S - 3600)
const FRESH = jwt(NOW_S + 7200)

const hub = vi.hoisted(() => ({
  refreshOutcome: 'ok' as 'ok' | 'refused',
  handshakes: [] as Array<string | undefined>,
  refreshUrls: [] as string[],
  wsRefresh: false,
  expiredToken: '',
}))

class FakeSocket {
  readyState = 0
  private listeners = new Map<string, Array<(ev: unknown) => void>>()
  constructor(readonly url: string) {
    setTimeout(() => {
      this.readyState = 1
      this.emit('open', {})
    }, 0)
  }
  send(raw: string): void {
    if (raw === 'PONG' || raw === 'PING') return
    const msg: unknown = JSON.parse(raw)
    if (typeof msg !== 'object' || msg === null) return
    const method: unknown = Reflect.get(msg, 'method')
    if (method === 'connectionParams') {
      const data: unknown = Reflect.get(msg, 'data')
      const token: unknown =
        data !== null && typeof data === 'object' ? Reflect.get(data, 'token') : undefined
      const tok = typeof token === 'string' ? token : undefined
      hub.handshakes.push(tok)
      if (tok === hub.expiredToken) {
        setTimeout(() => {
          this.readyState = 3
          this.emit('close', { code: 4401 })
        }, 0)
      }
      return
    }
    const id: unknown = Reflect.get(msg, 'id')
    const params: unknown = Reflect.get(msg, 'params')
    const path: unknown =
      params !== null && typeof params === 'object' ? Reflect.get(params, 'path') : undefined
    if (path === 'auth.refreshSession') hub.wsRefresh = true
    setTimeout(() => {
      this.emit('message', {
        data: JSON.stringify({ id, result: { type: 'data', data: { json: {} } } }),
      })
    }, 0)
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

vi.mock('../../lib/connection-health', () => ({ reportSdkConnectionState: vi.fn() }))

import { AuthProvider, useAuth } from '../auth-context'

function WhoAmI() {
  const { user, loading } = useAuth()
  return <div data-testid="who">{loading ? 'loading' : (user?.username ?? 'anonymous')}</div>
}

beforeEach(() => {
  hub.refreshOutcome = 'ok'
  hub.handshakes = []
  hub.refreshUrls = []
  hub.wsRefresh = false
  hub.expiredToken = EXPIRED
  localStorage.clear()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('auth.refreshSession')) {
        hub.refreshUrls.push(url)
        if (hub.refreshOutcome === 'refused') {
          return new Response(
            JSON.stringify({
              error: {
                json: {
                  message: 'no',
                  code: -32001,
                  data: { code: 'UNAUTHORIZED', httpStatus: 401 },
                },
              },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            result: {
              data: {
                json: { token: FRESH, refreshToken: 'csr_2', expiresAt: (NOW_S + 7200) * 1000 },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 200 })
    }),
  )
})

afterEach(async () => {
  const { resetSystem } = await import('../../lib/backend')
  const { sessionKeeper } = await import('../../lib/admin-session')
  sessionKeeper().stop()
  resetSystem()
  vi.unstubAllGlobals()
})

function storeExpiredSession(): void {
  localStorage.setItem('camstack_admin_token', EXPIRED)
  localStorage.setItem('camstack_admin_refresh', 'csr_1')
  localStorage.setItem('camstack_admin_token_expires', String((NOW_S - 3600) * 1000))
}

describe('cold restore with an expired access token', () => {
  it('a valid refresh token keeps the user signed in, refreshed over HTTP', async () => {
    storeExpiredSession()
    render(
      <AuthProvider>
        <WhoAmI />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('admin'))
    expect(hub.refreshUrls.length).toBeGreaterThan(0)
    expect(hub.wsRefresh).toBe(false)
    expect(localStorage.getItem('camstack_admin_refresh')).toBe('csr_2')
    expect(hub.handshakes).not.toContain(EXPIRED)
  })

  it('a REFUSED refresh signs out onto an anonymous System and clears the session', async () => {
    hub.refreshOutcome = 'refused'
    storeExpiredSession()
    render(
      <AuthProvider>
        <WhoAmI />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('anonymous'))
    expect(localStorage.getItem('camstack_admin_token')).toBeNull()
    expect(hub.handshakes).not.toContain(EXPIRED)
  })
})
