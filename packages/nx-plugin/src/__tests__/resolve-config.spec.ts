import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDeployConfig } from '../lib/resolve-config.js'

/**
 * The deploy credential is the `camstack login` session and nothing else
 * (D1101): no executor token, no $CAMSTACK_TOKEN, no ~/.camstackrc.
 */
const SERVER = 'https://hub.example.test:4443'

const FULL = { username: 'u', tokenId: 't', createdAt: 1, scopes: [] }

describe('resolveDeployConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-deploy-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const save = (token: string, extra: Record<string, unknown> = {}): void => {
    fs.writeFileSync(
      path.join(dir, 'hub.example.test_4443.json'),
      JSON.stringify({ ...FULL, server: SERVER, token, ...extra }),
      { mode: 0o600 },
    )
  }

  it('resolves the saved login session', () => {
    save('session-token')
    expect(resolveDeployConfig({ server: 'hub.example.test', sessionDir: dir })).toEqual({
      server: SERVER,
      token: 'session-token',
    })
  })

  it('ignores $CAMSTACK_TOKEN and an executor token: with no session it names camstack login', () => {
    expect(() =>
      resolveDeployConfig({
        server: SERVER,
        env: { CAMSTACK_TOKEN: 'from-env' },
        sessionDir: dir,
      }),
    ).toThrow(/camstack login/)
  })

  it('takes the address from $CAMSTACK_SERVER, else the most recent session', () => {
    save('session-token')
    expect(resolveDeployConfig({ env: { CAMSTACK_SERVER: SERVER }, sessionDir: dir }).server).toBe(
      SERVER,
    )
    expect(resolveDeployConfig({ env: {}, sessionDir: dir }).server).toBe(SERVER)
  })

  it('refuses an expired session and says how to renew it', () => {
    save('old', { expiresAt: 5 })
    expect(() => resolveDeployConfig({ server: SERVER, sessionDir: dir, now: 10 })).toThrow(
      /expired/,
    )
  })

  const saveAs = (file: string, body: Record<string, unknown>): void => {
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ ...FULL, ...body }), { mode: 0o600 })
  }

  it('finds the session of an IPv6 hub (slug folds every colon)', () => {
    saveAs('[_1]_4443.json', { server: 'https://[::1]:4443', token: 'v6' })
    expect(resolveDeployConfig({ server: '[::1]', sessionDir: dir }).token).toBe('v6')
  })

  it('treats an explicit :443 as 443, not the default port', () => {
    saveAs('hub.example.test_443.json', { server: 'https://hub.example.test:443', token: 't443' })
    const r = resolveDeployConfig({ server: 'hub.example.test:443', sessionDir: dir })
    expect(r).toEqual({ server: 'https://hub.example.test:443', token: 't443' })
  })

  it('refuses http:// the way develop does', () => {
    expect(() =>
      resolveDeployConfig({ server: 'http://hub.example.test', sessionDir: dir }),
    ).toThrow(/https/)
  })

  it('falls back to the JWT exp when expiresAt is missing', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 5 })).toString('base64url')
    save(`h.${payload}.s`)
    expect(() => resolveDeployConfig({ server: SERVER, sessionDir: dir, now: 6000 })).toThrow(
      /expired/,
    )
    expect(resolveDeployConfig({ server: SERVER, sessionDir: dir, now: 4000 }).token).toContain('.')
  })

  it('ignores a file that is not a session shape, and breaks a recency tie by mtime', () => {
    saveAs('a_1.json', { server: 'https://a:1', token: 'older' })
    saveAs('b_1.json', { server: 'https://b:1', token: 'newer' })
    fs.writeFileSync(path.join(dir, 'junk_1.json'), JSON.stringify({ server: 'x', token: 'y' }))
    fs.utimesSync(path.join(dir, 'a_1.json'), 1000, 1000)
    fs.utimesSync(path.join(dir, 'b_1.json'), 2000, 2000)
    fs.utimesSync(path.join(dir, 'junk_1.json'), 3000, 3000)
    expect(resolveDeployConfig({ env: {}, sessionDir: dir }).token).toBe('newer')
  })
})
