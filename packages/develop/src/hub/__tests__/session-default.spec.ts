import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultSession,
  listSessions,
  loadSession,
  saveSession,
  type SessionFile,
  touchSession,
} from '../session-store.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-sessions-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function session(server: string, createdAt: number, lastUsedAt?: number): SessionFile {
  return {
    server,
    username: 'admin',
    tokenId: `id-${createdAt}`,
    token: `tok_${createdAt}`,
    scopes: [{ type: 'capability', target: 'addons' }],
    createdAt,
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
  }
}

describe('default session rule', () => {
  it('lists most recently used first, createdAt standing in for a missing lastUsedAt', () => {
    saveSession(session('https://a:4443', 100), dir)
    saveSession(session('https://b:4443', 50, 300), dir)
    saveSession(session('https://c:4443', 200), dir)
    expect(listSessions(dir).map((s) => s.server)).toEqual([
      'https://b:4443',
      'https://c:4443',
      'https://a:4443',
    ])
  })

  it('skips a corrupt file', () => {
    saveSession(session('https://a:4443', 100), dir)
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope')
    expect(listSessions(dir)).toHaveLength(1)
  })

  it('$CAMSTACK_SERVER wins, otherwise the most recently used', () => {
    const all = [session('https://a:4443', 100, 900), session('https://b:4443', 100, 10)]
    expect(defaultSession(all, {})?.server).toBe('https://a:4443')
    expect(defaultSession(all, { CAMSTACK_SERVER: 'b' })?.server).toBe('https://b:4443')
    expect(defaultSession(all, { CAMSTACK_SERVER: 'unknown' })?.server).toBe('https://a:4443')
    expect(defaultSession([], {})).toBeNull()
  })

  it('touchSession records lastUsedAt and changes the default', () => {
    saveSession(session('https://a:4443', 100), dir)
    saveSession(session('https://b:4443', 200), dir)
    expect(defaultSession(listSessions(dir), {})?.server).toBe('https://b:4443')
    touchSession('https://a:4443', dir, 5000)
    expect(loadSession('https://a:4443', dir)?.lastUsedAt).toBe(5000)
    expect(defaultSession(listSessions(dir), {})?.server).toBe('https://a:4443')
  })
})
