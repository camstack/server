import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tryConnectHub } from '../../mcp/hub-connection.js'

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
