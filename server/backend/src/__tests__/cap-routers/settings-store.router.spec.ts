/**
 * Spec for the codegen'd `settings-store` capability router.
 *
 * Exercises:
 *  - All 8 methods (get, set, query, insert, update, delete, count, isEmpty)
 *  - Auth enforcement (every method is admin-only — D634)
 *  - Missing provider → PRECONDITION_FAILED
 *  - Namespace passthrough (optional namespace field)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { ISettingsStoreProvider } from '@camstack/types'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

interface MockRecord {
  readonly id: string
  readonly data: Record<string, unknown>
}

interface MockStore {
  records: Map<string, MockRecord>
}

/** The methods this spec's routes reach; the harness takes any provider object. */
function makeMockProvider(): Partial<ISettingsStoreProvider> & { _store: MockStore } {
  const store: MockStore = { records: new Map() }

  return {
    _store: store,

    async get(input) {
      const record = store.records.get(input.key)
      return record?.data ?? null
    },

    async set(input) {
      store.records.set(input.key, {
        id: input.key,
        data: (input.value as Record<string, unknown>) ?? {},
      })
    },

    async query(input) {
      const results = [...store.records.values()]
      if (input.filter?.limit) return results.slice(0, input.filter.limit)
      return results
    },

    async insert(input) {
      // The real store assigns an id when the caller gives none.
      const id = input.record.id ?? `rec-${store.records.size + 1}`
      store.records.set(id, { ...input.record, id })
      return { id }
    },

    async update(input) {
      const existing = store.records.get(input.id)
      if (existing) {
        store.records.set(input.id, { id: input.id, data: { ...existing.data, ...input.data } })
      }
    },

    async delete(input) {
      store.records.delete(input.key)
    },

    async count() {
      return store.records.size
    },

    async isEmpty() {
      return store.records.size === 0
    },
  }
}

describe('settingsStore router', () => {
  let provider: ReturnType<typeof makeMockProvider>

  beforeEach(() => {
    provider = makeMockProvider()
  })

  // ── Happy path: all 8 methods ──────────────────────────────────────

  describe('get', () => {
    it('returns stored value by key', async () => {
      provider._store.records.set('myKey', { id: 'myKey', data: { foo: 'bar' } })
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'get', makeCtx('admin'), {
        collection: 'test',
        key: 'myKey',
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toMatchObject({ foo: 'bar' })
    })

    it('returns null for missing key', async () => {
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'get', makeCtx('admin'), {
        collection: 'test',
        key: 'nope',
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBeNull()
    })
  })

  describe('set', () => {
    it('upserts a value', async () => {
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'set', makeCtx('admin'), {
        collection: 'test',
        key: 'k1',
        value: { x: 1 },
      })
      expect(result.ok).toBe(true)
      expect(provider._store.records.has('k1')).toBe(true)
    })
  })

  describe('query', () => {
    it('returns all records', async () => {
      provider._store.records.set('a', { id: 'a', data: { v: 1 } })
      provider._store.records.set('b', { id: 'b', data: { v: 2 } })
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'query', makeCtx('admin'), {
        collection: 'test',
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toHaveLength(2)
    })

    it('respects filter.limit', async () => {
      provider._store.records.set('a', { id: 'a', data: {} })
      provider._store.records.set('b', { id: 'b', data: {} })
      provider._store.records.set('c', { id: 'c', data: {} })
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'query', makeCtx('admin'), {
        collection: 'test',
        filter: { limit: 2 },
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toHaveLength(2)
    })
  })

  describe('insert', () => {
    it('adds a record', async () => {
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'insert', makeCtx('admin'), {
        collection: 'test',
        record: { id: 'r1', data: { name: 'test' } },
      })
      expect(result.ok).toBe(true)
      expect(provider._store.records.get('r1')?.data).toMatchObject({ name: 'test' })
    })
  })

  describe('update', () => {
    it('merges data into existing record', async () => {
      provider._store.records.set('r1', { id: 'r1', data: { a: 1, b: 2 } })
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'update', makeCtx('admin'), {
        collection: 'test',
        id: 'r1',
        data: { b: 99 },
      })
      expect(result.ok).toBe(true)
      expect(provider._store.records.get('r1')?.data).toMatchObject({ a: 1, b: 99 })
    })
  })

  describe('delete', () => {
    it('removes a record', async () => {
      provider._store.records.set('r1', { id: 'r1', data: {} })
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'delete', makeCtx('admin'), {
        collection: 'test',
        key: 'r1',
      })
      expect(result.ok).toBe(true)
      expect(provider._store.records.has('r1')).toBe(false)
    })
  })

  describe('count', () => {
    it('returns record count', async () => {
      provider._store.records.set('a', { id: 'a', data: {} })
      provider._store.records.set('b', { id: 'b', data: {} })
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'count', makeCtx('admin'), {
        collection: 'test',
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe(2)
    })
  })

  describe('isEmpty', () => {
    it('returns true when empty', async () => {
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'isEmpty', makeCtx('admin'), {
        collection: 'test',
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe(true)
    })

    it('returns false when records exist', async () => {
      provider._store.records.set('x', { id: 'x', data: {} })
      const router = buildCapRouterForTest('settings-store', () => provider)
      const result = await invokeProcedure(router, 'isEmpty', makeCtx('admin'), {
        collection: 'test',
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe(false)
    })
  })

  // ── Namespace passthrough ──────────────────────────────────────────

  describe('namespace', () => {
    it('passes namespace to provider (optional field)', async () => {
      let capturedNamespace: string | undefined
      const base = makeMockProvider()
      const baseGet = base.get
      if (baseGet === undefined) throw new Error('the mock store implements get')
      const nsProvider: Partial<ISettingsStoreProvider> = {
        ...base,
        get: async (input) => {
          capturedNamespace = input.namespace
          return baseGet(input)
        },
      }

      const router = buildCapRouterForTest('settings-store', () => nsProvider)
      await invokeProcedure(router, 'get', makeCtx('admin'), {
        namespace: 'events',
        collection: 'detections',
        key: 'k1',
      })
      expect(capturedNamespace).toBe('events')
    })
  })

  // ── Auth enforcement ───────────────────────────────────────────────

  describe('auth', () => {
    it('rejects anonymous on all methods', async () => {
      const router = buildCapRouterForTest('settings-store', () => provider)
      for (const method of [
        'get',
        'set',
        'query',
        'insert',
        'update',
        'delete',
        'count',
        'isEmpty',
      ]) {
        const result = await invokeProcedure(router, method, makeCtx('anonymous'), {
          collection: 'c',
          key: 'k',
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe('UNAUTHORIZED')
      }
    })

    it('refuses a non-admin session on the reads too (admin-only, D634)', async () => {
      // This used to assert the opposite — a non-admin reading any collection
      // was pinned as intended, and it was the plaintext notifier-token leak.
      // The full role matrix is `notifier-credentials-admin-only.router.spec.ts`.
      const router = buildCapRouterForTest('settings-store', () => provider)
      for (const method of ['get', 'query', 'count', 'isEmpty']) {
        const result = await invokeProcedure(router, method, makeCtx('user'), {
          collection: 'c',
          key: 'k',
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe('FORBIDDEN')
      }
    })
  })

  // ── Missing provider ──────────────────────────────────────────────

  describe('missing provider', () => {
    it('throws PRECONDITION_FAILED when provider is null', async () => {
      const router = buildCapRouterForTest('settings-store', () => null)
      const result = await invokeProcedure(router, 'get', makeCtx('admin'), {
        collection: 'c',
        key: 'k',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('PRECONDITION_FAILED')
        expect(result.message).toContain('settings-store')
      }
    })
  })
})
