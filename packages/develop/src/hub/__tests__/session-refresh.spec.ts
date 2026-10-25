import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as develop from '../../index.js'
import { credentialTier, MissingCredentialsError } from '../credentials.js'
import { createHubClient, type HubTransport, type HubTransportRequest } from '../hub-client.js'
import {
  forceRefreshSession,
  refreshOnUnauthorized,
  resolveFreshCredentials,
} from '../session-refresh.js'
import { loadSession, saveSession, type SessionFile } from '../session-store.js'

const SERVER = 'https://hub.example.test:4443'
const NOW = 1_800_000_000_000

function jwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

function ok(json: unknown): { status: number; text: string } {
  return { status: 200, text: JSON.stringify({ result: { data: { json } } }) }
}

function refused(): { status: number; text: string } {
  return {
    status: 401,
    text: JSON.stringify({
      error: { json: { message: 'Session expired — sign in again', code: 'UNAUTHORIZED' } },
    }),
  }
}

const NEW_TOKEN = jwt({ isAdmin: true, exp: Math.floor((NOW + 3_600_000) / 1000) })

function rotating(seen: HubTransportRequest[]): HubTransport {
  return async (req) => {
    seen.push(req)
    return ok({
      token: NEW_TOKEN,
      refreshToken: 'csr_new',
      expiresAt: NOW + 3_600_000,
      sessionId: 's',
      sessionExpiresAt: NOW + 86_400_000,
      user: { id: '1', username: 'admin', isAdmin: true },
    })
  }
}

describe('session refresh', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-refresh-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function session(exp: number, over: Partial<SessionFile> = {}): SessionFile {
    const s: SessionFile = {
      server: SERVER,
      username: 'admin',
      tokenId: '',
      token: jwt({ isAdmin: true, exp: Math.floor(exp / 1000) }),
      scopes: [],
      createdAt: 1,
      refreshToken: 'csr_old',
      expiresAt: exp,
      ...over,
    }
    saveSession(s, dir)
    return s
  }

  const inputs = (transport: HubTransport) => ({
    env: {},
    dir,
    now: NOW,
    transport,
    loadSession: (s?: string) => loadSession(s, dir),
  })

  it('refreshes an expired session transparently and persists the rotation', async () => {
    session(NOW - 1000)
    const seen: HubTransportRequest[] = []
    const r = await resolveFreshCredentials(inputs(rotating(seen)))
    expect(r.token).toBe(NEW_TOKEN)
    expect(r.source).toBe('session')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toContain('/trpc/auth.refreshSession')
    expect(JSON.parse(seen[0]!.body ?? '{}').json).toEqual({ refreshToken: 'csr_old' })
    const saved = loadSession(SERVER, dir)
    expect(saved?.token).toBe(NEW_TOKEN)
    expect(saved?.refreshToken).toBe('csr_new')
    expect(saved?.expiresAt).toBe(NOW + 3_600_000)
    expect(fs.statSync(path.join(dir, 'hub.example.test_4443.json')).mode & 0o077).toBe(0)
  })

  it('refreshes when less than 60 s are left, and not when more', async () => {
    session(NOW + 59_000)
    const seen: HubTransportRequest[] = []
    await resolveFreshCredentials(inputs(rotating(seen)))
    expect(seen).toHaveLength(1)

    session(NOW + 120_000)
    const seen2: HubTransportRequest[] = []
    const r = await resolveFreshCredentials(inputs(rotating(seen2)))
    expect(seen2).toHaveLength(0)
    expect(r.token).not.toBe(NEW_TOKEN)
  })

  it('reads the expiry from the JWT exp when the file has no expiresAt', async () => {
    const { expiresAt: _drop, ...rest } = session(NOW - 5_000)
    saveSession(rest, dir)
    const seen: HubTransportRequest[] = []
    await resolveFreshCredentials(inputs(rotating(seen)))
    expect(seen).toHaveLength(1)
  })

  it('a refusal says to run camstack login', async () => {
    session(NOW - 1000)
    const err = await resolveFreshCredentials(inputs(async () => refused())).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(MissingCredentialsError)
    expect(err instanceof Error ? err.message : '').toContain('camstack login')
  })

  it('an expired session without a refresh token asks for a login, with no network call', async () => {
    const { refreshToken: _drop, ...rest } = session(NOW - 1000)
    saveSession(rest, dir)
    const seen: HubTransportRequest[] = []
    await expect(resolveFreshCredentials(inputs(rotating(seen)))).rejects.toBeInstanceOf(
      MissingCredentialsError,
    )
    expect(seen).toHaveLength(0)
  })

  it('never refreshes an explicit token', async () => {
    session(NOW - 1000)
    const seen: HubTransportRequest[] = []
    const expired = jwt({ exp: 1 })
    const r = await resolveFreshCredentials({ ...inputs(rotating(seen)), token: expired })
    expect(r).toMatchObject({ source: 'flag', token: expired })
    expect(seen).toHaveLength(0)
  })

  it('a 401 refreshes once and retries once', async () => {
    session(NOW + 3_000_000)
    const old = loadSession(SERVER, dir)!.token
    const calls: { url: string; auth: string | undefined }[] = []
    const transport: HubTransport = async (req) => {
      calls.push({ url: req.url, auth: req.headers['authorization'] })
      if (req.url.includes('auth.refreshSession')) return rotating([])(req)
      return req.headers['authorization'] === `Bearer ${old}` ? refused() : ok({ pong: true })
    }
    const client = createHubClient({
      baseUrl: SERVER,
      token: old,
      transport,
      onUnauthorized: refreshOnUnauthorized({ server: SERVER, dir, transport, now: NOW }),
    })
    await expect(client.call('GET', 'system.info')).resolves.toEqual({ pong: true })
    expect(calls.map((c) => c.url.split('/trpc/')[1]?.split('?')[0])).toEqual([
      'system.info',
      'auth.refreshSession',
      'system.info',
    ])
    expect(calls[2]!.auth).toBe(`Bearer ${NEW_TOKEN}`)
  })

  it('a 401 after the retry is surfaced, not looped', async () => {
    session(NOW + 3_000_000)
    const calls: string[] = []
    const transport: HubTransport = async (req) => {
      calls.push(req.url)
      return req.url.includes('auth.refreshSession') ? rotating([])(req) : refused()
    }
    const client = createHubClient({
      baseUrl: SERVER,
      token: 'x',
      transport,
      onUnauthorized: refreshOnUnauthorized({ server: SERVER, dir, transport, now: NOW }),
    })
    await expect(client.call('GET', 'system.info')).rejects.toThrow()
    expect(calls).toHaveLength(3)
  })

  it('forceRefreshSession refuses with a login hint when the session is gone', async () => {
    await expect(
      forceRefreshSession({ server: SERVER, dir, transport: async () => refused(), now: NOW }),
    ).rejects.toBeInstanceOf(MissingCredentialsError)
  })
})

describe('the permission tier comes from claims, never from a prefix', () => {
  it('an opaque token’s shape buys nothing locally', () => {
    expect(credentialTier('opaque_legacy')).toBe('protected')
    expect(credentialTier('tok_legacy')).toBe('protected')
  })

  it('an admin JWT is admin; a non-admin JWT is not', () => {
    expect(credentialTier(jwt({ isAdmin: true }))).toBe('admin')
    expect(credentialTier(jwt({ isAdmin: false }))).toBe('protected')
  })

  const whoami =
    (isAdmin: boolean, seen: HubTransportRequest[] = []): HubTransport =>
    async (req) => {
      seen.push(req)
      return { status: 200, text: JSON.stringify({ ok: true, isAdmin }) }
    }
  const base = { env: {}, now: NOW, loadSession: () => null }

  it('an opaque legacy token is classified by asking the hub (whoami)', async () => {
    const seen: HubTransportRequest[] = []
    const admin = await resolveFreshCredentials({
      ...base,
      server: SERVER,
      token: 'opaque_opaque',
      transport: whoami(true, seen),
    })
    expect(admin.tier).toBe('admin')
    expect(seen[0]!.url).toBe(`${SERVER}/api/auth/whoami`)
    const user = await resolveFreshCredentials({
      ...base,
      server: SERVER,
      token: 'opaque_opaque',
      transport: whoami(false),
    })
    expect(user.tier).toBe('protected')
  })

  it('a JWT is never sent to whoami; an unreachable hub means protected', async () => {
    const seen: HubTransportRequest[] = []
    await resolveFreshCredentials({
      ...base,
      server: SERVER,
      token: jwt({ isAdmin: true }),
      transport: whoami(false, seen),
    })
    expect(seen).toHaveLength(0)
    const down = await resolveFreshCredentials({
      ...base,
      server: SERVER,
      token: 'opaque_opaque',
      transport: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(down.tier).toBe('protected')
  })

  it('a stale <host>.admin-token file is ignored, and its lookup helpers are gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-stale-'))
    try {
      const stale = path.join(dir, 'hub.example.test_4443.admin-token')
      fs.writeFileSync(stale, 'opaque_stale', { mode: 0o600 })
      const r = await resolveFreshCredentials({
        env: { CAMSTACK_ADMIN_TOKEN_FILE: stale },
        now: NOW,
        loadSession: () => ({ server: SERVER, token: jwt({ isAdmin: false }) }),
      })
      expect(r.source).toBe('session')
      expect(r.token).not.toBe('opaque_stale')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect('findAdminTokenFile' in develop).toBe(false)
    expect('saveAdminToken' in develop).toBe(false)
  })
})
