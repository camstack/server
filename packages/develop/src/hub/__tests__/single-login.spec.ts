import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as develop from '../../index.js'
import { MissingCredentialsError, resolveCredentials } from '../credentials.js'
import { saveSession } from '../session-store.js'
import { tryConnectHub } from '../../mcp/hub-connection.js'

// D1101: the `dominevo login` session is the ONLY way a client reaches a hub.
const SESSION = { server: 'https://hub.lan:4443', token: 'tok_session' }
const ENV_THEN_SESSION = {
  CAMSTACK_TOKEN: 'tok_env',
  CAMSTACK_HUB_TOKEN: 'tok_hub_env',
  CAMSTACK_HUB_TOKEN_FILE: '/nonexistent/token',
  CAMSTACK_SERVER: SESSION.server,
}

describe('resolveCredentials: the session is the only source', () => {
  it('a session-only resolve works', () => {
    expect(resolveCredentials({ env: {}, loadSession: () => SESSION })).toMatchObject({
      server: SESSION.server,
      token: 'tok_session',
      source: 'session',
    })
  })

  it('ignores CAMSTACK_TOKEN and CAMSTACK_HUB_TOKEN* in the environment', () => {
    const r = resolveCredentials({ env: ENV_THEN_SESSION, loadSession: () => SESSION })
    expect(r.token).toBe('tok_session')
    expect(r.source).toBe('session')
  })

  it('an env token without a session is NOT a login: it asks for `dominevo login`', () => {
    expect(() => resolveCredentials({ env: ENV_THEN_SESSION, loadSession: () => null })).toThrow(
      MissingCredentialsError,
    )
    expect(() => resolveCredentials({ env: ENV_THEN_SESSION, loadSession: () => null })).toThrow(
      /dominevo login/,
    )
  })

  it('the token-file reader is gone from the public API', () => {
    expect('readTokenFile' in develop).toBe(false)
  })
})

describe('connectHub: environment tokens are ignored', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-single-login-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('with only an env token the outcome is "no session"', async () => {
    const outcome = await tryConnectHub({
      workspaceRoot: dir,
      server: 'https://hub.example.test:4443',
      env: { CAMSTACK_TOKEN: 'tok_env', CAMSTACK_HUB_TOKEN: 'tok_env2' },
      sessionDir: dir,
      loginCommand: 'dominevo login',
    })
    expect(outcome.ok).toBe(false)
  })

  it('with a saved session the session token is used, whatever the env says', async () => {
    saveSession(
      {
        server: 'https://hub.example.test:4443',
        token: 'tok_saved',
        username: 'admin',
        isAdmin: true,
        scopes: [],
        tokenId: 't1',
        createdAt: Date.now(),
      },
      dir,
    )
    const outcome = await tryConnectHub({
      workspaceRoot: dir,
      server: 'https://hub.example.test:4443',
      env: { CAMSTACK_TOKEN: 'tok_env' },
      sessionDir: dir,
      loginCommand: 'dominevo login',
    })
    expect(outcome).toMatchObject({ ok: true })
    if (outcome.ok) expect(outcome.connection.token).toBe('tok_saved')
  })
})
