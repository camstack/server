import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseApiIndex } from '@camstack/develop'
import { opsStatus, topology } from '../ops/curated.js'
import { connectOpsHub } from '../ops/hub.js'

const HUB = 'https://hub.example.test:4443'
const CMD = 'camstack login'
const INDEX = parseApiIndex(
  [
    '| tRPC path | kind | auth | capability |',
    '|---|---|---|---|',
    '| `nodes.topology` | query | admin | nodes |',
    '| `system.info` | query | protected | system |',
  ].join('\n'),
)

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

describe('the admin-tier hint (camstack login)', () => {
  let dir: string
  let status = 200
  beforeEach(() => {
    status = 200
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-admin-hint-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function writeSession(token: string, isAdmin?: boolean): void {
    fs.writeFileSync(
      path.join(dir, 'hub.example.test_4443.json'),
      JSON.stringify({
        server: HUB,
        username: 'admin',
        tokenId: '',
        token,
        scopes: [],
        createdAt: 1,
        ...(isAdmin === true ? { isAdmin: true } : {}),
      }),
      { mode: 0o600 },
    )
  }

  function connect(loginCommand = CMD) {
    return connectOpsHub({
      workspaceRoot: dir,
      index: INDEX,
      sessionDir: dir,
      server: HUB,
      env: {},
      loginCommand,
      transport: async () => ({
        status,
        text:
          status === 200
            ? JSON.stringify({ result: { data: { json: [] } } })
            : JSON.stringify({
                error: { message: 'nope', data: { code: 'UNAUTHORIZED' } },
              }),
      }),
    })
  }

  it('missing admin: a refused admin-tier query and ops_status carry the login command', async () => {
    writeSession('tok_session_token')
    const hub = await connect()
    expect(hub.tier).toBe('protected')
    expect(opsStatus(hub).adminHint).toContain(`\`${CMD}\``)
    await expect(hub.query('nodes.topology')).rejects.toThrow(/admin-tier[\s\S]*`camstack login`/)
    expect(JSON.stringify(await topology(hub))).toContain('camstack login')
  })

  it('names the checkout-local form when the binary is not on PATH', async () => {
    writeSession('tok_session_token')
    const local = 'npx nx run camstack:build && node packages/cli/dist/cli.js login'
    expect(opsStatus(await connect(local)).adminHint).toContain(local)
  })

  it('admin JWT session: admin tier, no hint', async () => {
    writeSession(fakeJwt({ isAdmin: true }), true)
    const hub = await connect()
    expect(hub).toMatchObject({ tier: 'admin', adminHint: null })
    expect(opsStatus(hub).adminHint).toBeNull()
  })

  it('a legacy admin-token file on disk is not used for authentication', async () => {
    writeSession('tok_session_token')
    fs.writeFileSync(path.join(dir, 'hub.example.test_4443.admin-token'), 'opaque_live\n', {
      mode: 0o600,
    })
    const hub = await connect()
    expect(hub).toMatchObject({ tier: 'protected', source: 'session' })
  })

  it('a 401 on an admin credential carries the hint, keeping the hub message', async () => {
    writeSession(fakeJwt({ isAdmin: true }), true)
    const hub = await connect()
    status = 401
    await expect(hub.query('nodes.topology')).rejects.toThrow(
      /rejected this credential[\s\S]*`camstack login`/,
    )
  })

  it('the hint never sends the operator to an admin-token file', async () => {
    writeSession('tok_session_token')
    const hub = await connect()
    expect(hub.adminHint).not.toMatch(/admin-token|token file/)
    expect(JSON.stringify(await topology(hub))).not.toMatch(/D816/)
  })

  it('an expired session is renewed on connect, and the new token is the one sent', async () => {
    const fresh = fakeJwt({ isAdmin: true, exp: Math.floor(Date.now() / 1000) + 3600 })
    fs.writeFileSync(
      path.join(dir, 'hub.example.test_4443.json'),
      JSON.stringify({
        server: HUB,
        username: 'admin',
        tokenId: '',
        token: fakeJwt({ isAdmin: true, exp: 1 }),
        scopes: [],
        createdAt: 1,
        isAdmin: true,
        refreshToken: 'csr_old',
        expiresAt: 1000,
      }),
      { mode: 0o600 },
    )
    const urls: string[] = []
    const auth: (string | undefined)[] = []
    const hub = await connectOpsHub({
      workspaceRoot: dir,
      index: INDEX,
      sessionDir: dir,
      server: HUB,
      env: {},
      loginCommand: CMD,
      transport: async (req) => {
        urls.push(req.url)
        auth.push(req.headers['authorization'])
        const json = req.url.includes('auth.refreshSession')
          ? {
              token: fresh,
              refreshToken: 'csr_new',
              expiresAt: Date.now() + 3_600_000,
              sessionId: 's',
              sessionExpiresAt: Date.now() + 86_400_000,
              user: { id: '1', username: 'admin', isAdmin: true },
            }
          : []
        return { status: 200, text: JSON.stringify({ result: { data: { json } } }) }
      },
    })
    expect(hub.tier).toBe('admin')
    await hub.query('nodes.topology')
    expect(urls[0]).toContain('auth.refreshSession')
    expect(auth[auth.length - 1]).toBe(`Bearer ${fresh}`)
  })

  it('a legacy opaque token is classified by asking the hub, not by its prefix', async () => {
    const tokenFile = path.join(dir, 'explicit')
    fs.writeFileSync(tokenFile, 'opaque_opaque\n', { mode: 0o600 })
    const classify = (isAdmin: boolean) =>
      connectOpsHub({
        workspaceRoot: dir,
        index: INDEX,
        sessionDir: dir,
        server: HUB,
        env: {},
        tokenFile,
        loginCommand: CMD,
        transport: async () => ({ status: 200, text: JSON.stringify({ ok: true, isAdmin }) }),
      })
    expect((await classify(true)).tier).toBe('admin')
    expect((await classify(false)).tier).toBe('protected')
  })
})
