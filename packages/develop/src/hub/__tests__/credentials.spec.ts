import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  authRejectedHint,
  MissingCredentialsError,
  readTokenFile,
  resolveCredentials,
  withAuthHint,
} from '../credentials.js'

const SESSION = { server: 'https://hub.lan:4443', token: 'tok_session' }

describe('resolveCredentials', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-cred-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function tokenFile(content: string, mode = 0o600): string {
    const p = path.join(dir, 'token')
    fs.writeFileSync(p, content, { mode })
    fs.chmodSync(p, mode)
    return p
  }

  it('uses the cached session automatically when nothing else is given', () => {
    const r = resolveCredentials({ env: {}, loadSession: () => SESSION })
    expect(r).toMatchObject({
      server: SESSION.server,
      token: 'tok_session',
      source: 'session',
    })
  })

  it('looks the session up by the explicit --server', () => {
    let asked: string | undefined = 'unset'
    resolveCredentials({
      server: 'https://other:4443',
      env: {},
      loadSession: (s) => {
        asked = s
        return { server: 'https://other:4443', token: 'tok_other' }
      },
    })
    expect(asked).toBe('https://other:4443')
  })

  it('looks the session up by $CAMSTACK_SERVER when --server is absent (not the newest file)', () => {
    let asked: string | undefined = 'unset'
    resolveCredentials({
      env: { CAMSTACK_SERVER: 'https://from-env:4443' },
      loadSession: (s) => {
        asked = s
        return null
      },
      token: 'tok_flag',
    })
    expect(asked).toBe('https://from-env:4443')
  })

  it('--token beats --token-file, the environment and the session', () => {
    const r = resolveCredentials({
      token: 'tok_flag',
      tokenFile: tokenFile('tok_file\n'),
      env: { CAMSTACK_TOKEN: 'tok_env' },
      loadSession: () => SESSION,
    })
    expect(r).toMatchObject({
      token: 'tok_flag',
      source: 'flag',
      server: SESSION.server,
    })
  })

  it('--token-file beats the environment and the session', () => {
    const r = resolveCredentials({
      tokenFile: tokenFile('tok_file\n'),
      env: { CAMSTACK_TOKEN: 'tok_env' },
      loadSession: () => SESSION,
    })
    expect(r).toMatchObject({ token: 'tok_file', source: 'token-file' })
  })

  it('CAMSTACK_TOKEN still beats the cached session (kept until the operator decides)', () => {
    const r = resolveCredentials({
      env: { CAMSTACK_TOKEN: 'tok_env' },
      loadSession: () => SESSION,
    })
    expect(r).toMatchObject({ token: 'tok_env', source: 'env' })
  })

  it('takes the server from a session-format token file when --server is absent', () => {
    const file = tokenFile(JSON.stringify({ server: 'https://from-file:4443', token: 'tok_json' }))
    const r = resolveCredentials({
      tokenFile: file,
      env: {},
      loadSession: () => null,
    })
    expect(r).toMatchObject({
      server: 'https://from-file:4443',
      token: 'tok_json',
    })
  })

  it('server precedence: --server, then $CAMSTACK_SERVER, then the token file, then the session', () => {
    const file = tokenFile(JSON.stringify({ server: 'https://from-file:4443', token: 'tok_json' }))
    const env = { CAMSTACK_SERVER: 'https://from-env:4443' }
    expect(
      resolveCredentials({
        server: 'https://flag:4443',
        tokenFile: file,
        env,
        loadSession: () => SESSION,
      }).server,
    ).toBe('https://flag:4443')
    expect(resolveCredentials({ tokenFile: file, env, loadSession: () => SESSION }).server).toBe(
      'https://from-env:4443',
    )
  })

  it('throws a MissingCredentialsError that names `camstack login` and --token-file', () => {
    let caught: unknown
    try {
      resolveCredentials({
        server: 'https://hub.lan:4443',
        env: {},
        loadSession: () => null,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(MissingCredentialsError)
    const msg = (caught as Error).message
    expect(msg).toContain('https://hub.lan:4443')
    expect(msg).toContain('camstack login')
    expect(msg).toContain('--token-file')
  })

  it('says "any hub" when no server is known', () => {
    expect(() => resolveCredentials({ env: {}, loadSession: () => null })).toThrow(/any hub/)
  })
})

describe('readTokenFile', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-tokfile-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function write(name: string, content: string, mode = 0o600): string {
    const p = path.join(dir, name)
    fs.writeFileSync(p, content)
    fs.chmodSync(p, mode)
    return p
  }

  it('reads a bare token and trims surrounding whitespace', () => {
    expect(readTokenFile(write('t', '  tok_abc\n'))).toMatchObject({
      token: 'tok_abc',
    })
  })

  it('reads a ~/.camstack session file as-is', () => {
    const p = write(
      's.json',
      JSON.stringify({
        server: 'https://h:4443',
        username: 'admin',
        token: 'tok_x',
        tokenId: 'id',
      }),
    )
    expect(readTokenFile(p)).toMatchObject({
      token: 'tok_x',
      server: 'https://h:4443',
    })
  })

  it('refuses a missing file with its path in the message', () => {
    expect(() => readTokenFile(path.join(dir, 'nope'))).toThrow(/nope/)
  })

  it('refuses an empty file', () => {
    expect(() => readTokenFile(write('e', '\n'))).toThrow(/empty/)
  })

  it('refuses a file holding more than one token', () => {
    expect(() => readTokenFile(write('m', 'tok_a\ncst_b\n'))).toThrow(/one token/)
  })

  it('refuses JSON without a string token', () => {
    expect(() => readTokenFile(write('j', '{"server":"x"}'))).toThrow(/token/)
  })

  it.skipIf(process.platform === 'win32')(
    'warns when the file is readable by group or others',
    () => {
      expect(readTokenFile(write('open', 'tok_a', 0o644)).warning).toMatch(/chmod 600/)
      expect(readTokenFile(write('closed', 'tok_a', 0o600)).warning).toBeUndefined()
    },
  )
})

describe('authRejectedHint', () => {
  it('explains a 401/403 against a cached session as revoked or expired', () => {
    const hint = authRejectedHint(401, 'session')
    expect(hint).toMatch(/revoked or expired/)
    expect(hint).toContain('camstack login')
    expect(authRejectedHint(403, 'session')).not.toBeNull()
  })

  it('points a rejected token file at the operator who issued it', () => {
    expect(authRejectedHint(401, 'token-file')).toMatch(/token file/)
  })

  it('stays silent for non-auth statuses', () => {
    expect(authRejectedHint(500, 'session')).toBeNull()
    expect(authRejectedHint(200, 'session')).toBeNull()
  })
})

describe('withAuthHint', () => {
  it('appends the hint on an auth rejection', () => {
    expect(withAuthHint('Forbidden: token not recognised', 403, 'session')).toBe(
      `Forbidden: token not recognised\n  ${authRejectedHint(403, 'session')}`,
    )
  })

  it('leaves the message alone for other statuses or an unknown source', () => {
    expect(withAuthHint('boom', 500, 'session')).toBe('boom')
    expect(withAuthHint('nope', 401, undefined)).toBe('nope')
  })
})
