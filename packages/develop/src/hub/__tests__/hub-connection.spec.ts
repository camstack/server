import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeSavedSession, tryConnectHub } from '../../mcp/hub-connection.js'

describe('tryConnectHub — no session is a result, not a throw', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-hubconn-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('no hub address and no session: names the login command', async () => {
    const outcome = await tryConnectHub({
      workspaceRoot: dir,
      env: {},
      sessionDir: dir,
      loginCommand: 'camstack login',
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('no-session')
      expect(outcome.action).toBe('run `camstack login <host>` in a terminal')
    }
  })

  it('a named hub with no login: still the same structured answer', async () => {
    const outcome = await tryConnectHub({
      workspaceRoot: dir,
      server: 'https://hub.example.test',
      env: {},
      sessionDir: dir,
      loginCommand: 'camstack login',
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('hub.example.test')
  })
})

describe('describeSavedSession — a reused saved login is stated, never silent', () => {
  const session = {
    username: 'admin',
    isAdmin: false,
    scopes: [{ type: 'capability', target: 'addons' }],
  }
  it('names the account, hub and scope of a saved session', () => {
    expect(describeSavedSession('session', session, 'https://hub.example.test:4443')).toBe(
      'using saved session admin@hub.example.test:4443, scope capability:addons',
    )
    expect(describeSavedSession('session', { ...session, isAdmin: true }, 'https://h.test')).toBe(
      'using saved session admin@h.test, scope admin',
    )
  })
  it('says nothing when there is no session', () => {
    expect(describeSavedSession('session', null, 'https://h.test')).toBeNull()
  })
})
