import { createRecordsAccess } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { OauthSessionManager } from '../oauth-session-manager.js'
import { localAuthRecordKinds, localAuthRecordStoresOf } from '../record-kinds.js'

/**
 * OauthSessionManager — the full session lifecycle on the REAL records engine
 * (in-memory SQLite), through local-auth's `oauth-sessions` kind.
 */

// ---------------------------------------------------------------------------
// Shared input fixture
// ---------------------------------------------------------------------------

const baseInput = {
  userId: 'u-1',
  username: 'alice',
  integrationId: 'export-alexa',
  scopes: [
    {
      type: 'category' as const,
      target: 'device' as const,
      access: ['view'] as ('view' | 'create' | 'delete')[],
    },
  ],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OauthSessionManager', () => {
  let mgr: OauthSessionManager

  beforeEach(async () => {
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'local-auth',
      transport: world.transportFor('local-auth'),
      secrets: null,
    })
    await records.declare(localAuthRecordKinds)
    mgr = new OauthSessionManager({
      oauthSessionsKind: localAuthRecordStoresOf(records).oauthSessions,
    })
  })

  // ── create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('returns a populated record with a non-empty id and revokedAt null', async () => {
      const session = await mgr.create(baseInput)
      expect(session.id).toBeTruthy()
      expect(typeof session.id).toBe('string')
      expect(session.userId).toBe('u-1')
      expect(session.username).toBe('alice')
      expect(session.integrationId).toBe('export-alexa')
      expect(session.scopes).toEqual(baseInput.scopes)
      expect(typeof session.createdAt).toBe('number')
      expect(typeof session.lastUsedAt).toBe('number')
      expect(session.revokedAt).toBeNull()
    })

    it('assigns distinct ids to two sessions for the same user', async () => {
      const a = await mgr.create(baseInput)
      const b = await mgr.create(baseInput)
      expect(a.id).not.toBe(b.id)
    })

    it('persists the session so it is retrievable by id', async () => {
      const session = await mgr.create(baseInput)
      const found = await mgr.getById(session.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(session.id)
    })
  })

  // ── list ──────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns an empty array when no sessions have been created', async () => {
      const all = await mgr.list()
      expect(all).toEqual([])
    })

    it('returns all created sessions', async () => {
      const a = await mgr.create(baseInput)
      const b = await mgr.create({ ...baseInput, userId: 'u-2', username: 'bob' })
      const all = await mgr.list()
      const ids = all.map((s) => s.id).toSorted()
      expect(ids).toEqual([a.id, b.id].toSorted())
    })

    it('includes revoked sessions (callers filter)', async () => {
      const session = await mgr.create(baseInput)
      await mgr.markRevoked(session.id)
      const all = await mgr.list()
      expect(all).toHaveLength(1)
      expect(all[0]!.revokedAt).not.toBeNull()
    })
  })

  // ── getById ───────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns the session for a known id', async () => {
      const session = await mgr.create(baseInput)
      const found = await mgr.getById(session.id)
      expect(found).not.toBeNull()
      expect(found!.userId).toBe('u-1')
    })

    it('returns null for an unknown id', async () => {
      const found = await mgr.getById('nonexistent-id')
      expect(found).toBeNull()
    })
  })

  // ── markRevoked ───────────────────────────────────────────────────────────

  describe('markRevoked', () => {
    it('sets revokedAt to a number and returns true', async () => {
      const session = await mgr.create(baseInput)
      const result = await mgr.markRevoked(session.id)
      expect(result).toBe(true)
      const found = await mgr.getById(session.id)
      expect(typeof found!.revokedAt).toBe('number')
    })

    it('is idempotent — re-revoking returns true and does not change revokedAt again', async () => {
      const session = await mgr.create(baseInput)
      await mgr.markRevoked(session.id)
      const first = (await mgr.getById(session.id))!.revokedAt

      // Small delay to ensure Date.now() would differ
      await new Promise((r) => setTimeout(r, 5))

      const result = await mgr.markRevoked(session.id)
      expect(result).toBe(true)
      const second = (await mgr.getById(session.id))!.revokedAt
      expect(second).toBe(first) // unchanged
    })

    it('returns false for a missing id', async () => {
      const result = await mgr.markRevoked('no-such-session')
      expect(result).toBe(false)
    })
  })

  // ── touch ─────────────────────────────────────────────────────────────────

  describe('touch', () => {
    it('updates lastUsedAt to a more recent timestamp', async () => {
      const session = await mgr.create(baseInput)
      const before = session.lastUsedAt

      // Ensure time advances
      await new Promise((r) => setTimeout(r, 5))

      await mgr.touch(session.id)
      const found = await mgr.getById(session.id)
      expect(found!.lastUsedAt).toBeGreaterThan(before)
    })

    it('is a no-op for a missing id (does not throw)', async () => {
      await expect(mgr.touch('no-such-session')).resolves.toBeUndefined()
    })
  })

  // ── multi-user isolation ──────────────────────────────────────────────────

  describe('multi-user isolation', () => {
    it('revoking one session does not affect another', async () => {
      const a = await mgr.create(baseInput)
      const b = await mgr.create({ ...baseInput, userId: 'u-2', username: 'bob' })
      await mgr.markRevoked(a.id)

      const foundA = await mgr.getById(a.id)
      const foundB = await mgr.getById(b.id)
      expect(foundA!.revokedAt).not.toBeNull()
      expect(foundB!.revokedAt).toBeNull()
    })
  })
})
