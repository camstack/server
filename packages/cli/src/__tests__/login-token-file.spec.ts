import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const seen: { url: string; auth: string | undefined }[] = []
let status = 200
vi.mock('../http/hub-http.js', () => ({
  hubRequest: async (url: string, opts: { headers?: Record<string, string> }) => {
    seen.push({ url, auth: opts.headers?.['Authorization'] })
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Unauthorized',
      headers: {},
      text: async () => '{}',
      json: async () => ({ kind: 'user', username: 'robot' }),
    }
  },
}))

import { assertPrivateTokenFile, loginWithTokenFile } from '../commands/login-token-file.js'

let dir: string
const TOKEN = 'secret-token-value'

function tokenFile(mode: number): string {
  const p = path.join(dir, 'tok')
  fs.writeFileSync(p, `${TOKEN}\n`, { mode })
  fs.chmodSync(p, mode)
  return p
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-tf-'))
  seen.length = 0
  status = 200
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('camstack login --token-file', () => {
  it('refuses a file readable by group or others, with the fix', () => {
    expect(() => assertPrivateTokenFile(tokenFile(0o644), 'linux')).toThrow(/chmod 600/)
    expect(() => assertPrivateTokenFile(tokenFile(0o640), 'linux')).toThrow(/group\/others/)
  })

  it('accepts a 0600 file, and the refusal never echoes the token', () => {
    expect(() => assertPrivateTokenFile(tokenFile(0o600), 'linux')).not.toThrow()
    try {
      assertPrivateTokenFile(tokenFile(0o644), 'linux')
    } catch (err) {
      expect(String(err)).not.toContain(TOKEN)
    }
  })

  it('validates against the hub and caches a 0600 session', async () => {
    const result = await loginWithTokenFile({
      tokenFile: tokenFile(0o600),
      server: 'hub.example.test',
      sessionDir: path.join(dir, 'sessions'),
    })
    expect(seen).toEqual([
      { url: 'https://hub.example.test:4443/api/auth/whoami', auth: `Bearer ${TOKEN}` },
    ])
    expect(result.username).toBe('robot')
    const cached = JSON.parse(fs.readFileSync(result.sessionFile, 'utf8'))
    expect(cached.token).toBe(TOKEN)
    expect(fs.statSync(result.sessionFile).mode & 0o777).toBe(0o600)
  })

  it('does not cache a token the hub rejects', async () => {
    status = 401
    const sessions = path.join(dir, 'sessions')
    await expect(
      loginWithTokenFile({
        tokenFile: tokenFile(0o600),
        server: 'hub.example.test',
        sessionDir: sessions,
      }),
    ).rejects.toThrow(/rejected the token/)
    expect(fs.existsSync(sessions)).toBe(false)
  })

  it('refuses a loose file before any network call', async () => {
    await expect(
      loginWithTokenFile({
        tokenFile: tokenFile(0o644),
        server: 'hub.example.test',
        sessionDir: path.join(dir, 'sessions'),
        platform: 'linux',
      }),
    ).rejects.toThrow(/Refusing token file/)
    expect(seen).toEqual([])
  })
})
