/**
 * `camstack login` keeps what the other tools need to renew the session, and
 * ending a session is decided from the file and the token's claims, never from
 * a token prefix.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SessionFile } from '@camstack/develop'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const requests: { url: string; headers: Record<string, string>; body: string }[] = []

vi.mock('../http/hub-http.js', () => ({
  hubRequest: async (
    url: string,
    init: { headers?: Record<string, string>; body?: string },
  ): Promise<unknown> => {
    requests.push({ url, headers: init.headers ?? {}, body: String(init.body ?? '') })
    const procedure = url.split('/trpc/')[1]?.split('?')[0]
    const json =
      procedure === 'auth.login'
        ? {
            token: 'aaa.bbb.ccc',
            refreshToken: 'csr_login',
            expiresAt: 1_900_000_000_000,
            user: { id: '1', username: 'admin', isAdmin: true },
          }
        : { success: true, revoked: 1 }
    const text = JSON.stringify([{ result: { data: { json } } }])
    return { ok: true, status: 200, statusText: 'OK', text: async () => text }
  },
}))

vi.mock('@clack/prompts', () => ({
  intro: () => undefined,
  outro: () => undefined,
  log: { info: () => undefined, warn: () => undefined },
  spinner: () => ({ start: () => undefined, stop: () => undefined }),
  isCancel: () => false,
  cancel: () => undefined,
  text: async () => 'admin',
  password: async () => 'pw',
  select: async () => '',
}))

import { loginCommand, revocationFor } from '../commands/auth.js'

function jwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

const BASE: SessionFile = {
  server: 'https://hub.example.test:4443',
  username: 'admin',
  tokenId: '',
  token: 'opaque',
  scopes: [],
  createdAt: 1,
}

describe('revocationFor — by claims and record, not by prefix', () => {
  it('a JWT session logs itself out, whatever it is called', () => {
    expect(revocationFor({ ...BASE, token: jwt({ isAdmin: true }) })).toMatchObject({
      procedure: 'auth.logout',
      bearer: 'self',
    })
  })

  it('a record with an id is revoked by id, whatever the token looks like', () => {
    expect(revocationFor({ ...BASE, token: 'tok_x', tokenId: 'rec-1' })).toMatchObject({
      procedure: 'auth.revokeToken',
      input: { id: 'rec-1' },
    })
  })

  it('an opaque token with no id has nothing to end, whatever it looks like', () => {
    expect(revocationFor({ ...BASE, token: 'opaque_x' })).toBeNull()
    expect(revocationFor({ ...BASE, token: 'tok_x' })).toBeNull()
  })
})

describe('camstack login persists the refresh token', () => {
  let home: string
  const realHome = process.env['HOME']
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-login-'))
    process.env['HOME'] = home
    requests.length = 0
  })
  afterEach(() => {
    if (realHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = realHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('asks for a refreshable session and stores refreshToken + expiresAt (0600)', async () => {
    await loginCommand({
      server: 'https://hub.example.test:4443',
      username: 'admin',
      password: 'pw',
    })
    const login = requests.find((r) => r.url.includes('auth.login'))
    expect(JSON.parse(login?.body ?? '{}')['0'].json.refreshable).toBe(true)
    const file = path.join(home, '.camstack', 'hub.example.test_4443.json')
    const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved).toMatchObject({
      token: 'aaa.bbb.ccc',
      refreshToken: 'csr_login',
      expiresAt: 1_900_000_000_000,
      isAdmin: true,
    })
    expect(fs.statSync(file).mode & 0o077).toBe(0)
  })
})
