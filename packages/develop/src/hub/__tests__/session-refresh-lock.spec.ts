import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HubTransport } from '../hub-client.js'
import { forceRefreshSession, resolveFreshCredentials } from '../session-refresh.js'
import { loadSession, saveSession, sessionFileForServer } from '../session-store.js'

const SERVER = 'https://hub.example.test:4443'
const NOW = 1_800_000_000_000
const CALLERS = 6

function jwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

const NEW_TOKEN = jwt({
  isAdmin: true,
  exp: Math.floor((NOW + 3_600_000) / 1000),
})
const REFUSAL = JSON.stringify({
  error: { json: { message: 'reuse', code: 'UNAUTHORIZED' } },
})

/** A hub that rotates: each refresh token is accepted once; a replay is refused. */
function fakeHub(seen: string[]): HubTransport {
  let current = 'csr_old'
  return async (req) => {
    const body: unknown = JSON.parse(req.body ?? '{}')
    const json: unknown =
      body !== null && typeof body === 'object' ? Reflect.get(body, 'json') : null
    const presented: unknown =
      json !== null && typeof json === 'object' ? Reflect.get(json, 'refreshToken') : null
    seen.push(String(presented))
    await new Promise((r) => setTimeout(r, 25))
    if (presented !== current) return { status: 401, text: REFUSAL }
    current = 'csr_new'
    const data = {
      token: NEW_TOKEN,
      refreshToken: 'csr_new',
      expiresAt: NOW + 3_600_000,
    }
    return {
      status: 200,
      text: JSON.stringify({ result: { data: { json: data } } }),
    }
  }
}

describe('session refresh lock', () => {
  let dir: string
  const lockPath = (): string => `${sessionFileForServer(SERVER, dir)}.lock`

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-refresh-lock-'))
    saveSession(
      {
        server: SERVER,
        username: 'admin',
        tokenId: '',
        token: jwt({ isAdmin: true, exp: Math.floor((NOW - 1000) / 1000) }),
        scopes: [],
        createdAt: 1,
        refreshToken: 'csr_old',
        expiresAt: NOW - 1000,
      },
      dir,
    )
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('N concurrent refreshers cause exactly one hub request and all get the new token', async () => {
    const seen: string[] = []
    const transport = fakeHub(seen)
    const results = await Promise.all(
      Array.from({ length: CALLERS }, () =>
        resolveFreshCredentials({
          env: {},
          loadSession: (s?: string) => loadSession(s, dir),
          dir,
          now: NOW,
          transport,
        }),
      ),
    )
    expect(seen).toEqual(['csr_old'])
    for (const r of results) expect(r.token).toBe(NEW_TOKEN)
    expect(loadSession(SERVER, dir)?.refreshToken).toBe('csr_new')
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it('concurrent forced refreshes (401 path) also rotate once', async () => {
    const seen: string[] = []
    const transport = fakeHub(seen)
    const tokens = await Promise.all(
      Array.from({ length: CALLERS }, () =>
        forceRefreshSession({ server: SERVER, dir, transport }),
      ),
    )
    expect(seen).toEqual(['csr_old'])
    for (const t of tokens) expect(t).toBe(NEW_TOKEN)
  })

  it('takes over a stale lock left by a crashed process', async () => {
    fs.writeFileSync(lockPath(), '')
    const old = new Date(Date.now() - 120_000)
    fs.utimesSync(lockPath(), old, old)
    const seen: string[] = []
    const r = await resolveFreshCredentials({
      env: {},
      loadSession: (s?: string) => loadSession(s, dir),
      dir,
      now: NOW,
      transport: fakeHub(seen),
    })
    expect(r.token).toBe(NEW_TOKEN)
    expect(seen).toEqual(['csr_old'])
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it('releases the lock when the hub refuses', async () => {
    const refuse: HubTransport = async () => ({ status: 401, text: REFUSAL })
    await expect(
      resolveFreshCredentials({
        env: {},
        loadSession: (s?: string) => loadSession(s, dir),
        dir,
        now: NOW,
        transport: refuse,
      }),
    ).rejects.toThrow()
    expect(fs.existsSync(lockPath())).toBe(false)
  })
})
