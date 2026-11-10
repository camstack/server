/**
 * The hub's announced identity (#494): random, generated ONCE, persisted, and never
 * overwritten — a corrupt file is reported, not replaced, because paired agents
 * recorded the id they were given.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isHubId } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_IDENTITY_FILE, loadOrCreateHubId } from '../hub-identity.js'

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
    expect(isHubId(first.hubId)).toBe(true)
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

  it('never overwrites a file it cannot read: no id, and the reason', () => {
    const file = path.join(dir, HUB_IDENTITY_FILE)
    fs.writeFileSync(file, '{"hubId":"not-a-hub-id"}')
    const result = loadOrCreateHubId(dir)
    expect(result.hubId).toBeNull()
    expect(result.problem).toMatch(/not a hub id/)
    expect(fs.readFileSync(file, 'utf8')).toBe('{"hubId":"not-a-hub-id"}')
  })
})
