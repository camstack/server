/**
 * The hub's announced identity (#494): random, generated ONCE, persisted, and never
 * overwritten — a corrupt file is reported, not replaced, because paired agents
 * recorded the id they were given.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_IDENTITY_FILE, isAnnouncedHubId, loadOrCreateHubId } from '../hub-identity.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-identity-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('loadOrCreateHubId', () => {
  it('generates a random hub id once and returns the same one on every later boot', () => {
    const first = loadOrCreateHubId(dir)
    expect(first.hubId).not.toBeNull()
    expect(isAnnouncedHubId(first.hubId)).toBe(true)
    expect(first.created).toBe(true)
    const again = loadOrCreateHubId(dir)
    expect(again).toEqual({ hubId: first.hubId, created: false, problem: null })
  })

  it('is random per hub, never the fixed mesh node id', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-identity-'))
    try {
      const a = loadOrCreateHubId(dir).hubId
      const b = loadOrCreateHubId(other).hubId
      expect(a).not.toBe(b)
      expect(a).not.toBe('hub')
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('keeps an id written at the data root by reading it once and copying it under tls/', () => {
    const legacy = path.join(dir, HUB_IDENTITY_FILE)
    fs.writeFileSync(legacy, `${JSON.stringify({ hubId: 'hub-0123456789abcdef' })}\n`)
    const result = loadOrCreateHubId(dir)
    expect(result).toEqual({ hubId: 'hub-0123456789abcdef', created: false, problem: null })
    const moved = path.join(dir, 'tls', HUB_IDENTITY_FILE)
    expect(JSON.parse(fs.readFileSync(moved, 'utf8'))).toEqual({ hubId: 'hub-0123456789abcdef' })
    expect(loadOrCreateHubId(dir).hubId).toBe('hub-0123456789abcdef')
  })

  it('writes a new id under tls/, beside the mesh CA a backup already keeps', () => {
    const result = loadOrCreateHubId(dir)
    expect(fs.existsSync(path.join(dir, HUB_IDENTITY_FILE))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'tls', HUB_IDENTITY_FILE))).toBe(true)
    expect(result.created).toBe(true)
  })

  it('never overwrites a file it cannot read: no id, and the reason', () => {
    const file = path.join(dir, HUB_IDENTITY_FILE)
    fs.writeFileSync(file, '{"hubId":"not-a-hub-id"}')
    const result = loadOrCreateHubId(dir)
    expect(result.hubId).toBeNull()
    expect(result.problem).toMatch(/not a hub id/)
    expect(fs.readFileSync(file, 'utf8')).toBe('{"hubId":"not-a-hub-id"}')
  })
})
