import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveSession, sessionFileForServer, type SessionFile } from '../session-store.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-session-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const SESSION: SessionFile = {
  server: 'https://hub.example:4443',
  username: 'admin',
  tokenId: '',
  token: 'tok',
  scopes: [],
  createdAt: 1,
}

describe('saveSession', () => {
  it('tightens a pre-existing loose file to 0600 and leaves no temp file', () => {
    const target = sessionFileForServer(SESSION.server, dir)
    fs.writeFileSync(target, 'old', { mode: 0o644 })
    fs.chmodSync(target, 0o644)
    saveSession(SESSION, dir)
    expect(fs.statSync(target).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).token).toBe('tok')
    expect(fs.readdirSync(dir)).toEqual([path.basename(target)])
  })
})
