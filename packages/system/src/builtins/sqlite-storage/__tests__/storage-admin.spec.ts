/**
 * `storage-admin` and the read-never-creates rule (D870), on real SQLite.
 *
 *  - a READ of a scoped canonical table nobody wrote is "absent", and does NOT
 *    create the table - `count` and `get` on an undeclared scoped name used to;
 *  - `listTables` is read-only and reports rows and owner.
 */
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'
import { StorageAdminProvider } from '../storage-admin-provider.js'

const NO_RECORDS = {
  listKinds: async () => ({ kinds: [] }),
  readRecords: async () => ({ records: [], nextCursor: null }),
}

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  // Documented type boundary: the provider only logs.
  return logger as unknown as IScopedLogger
}

describe('storage-admin and reads that never create a table', () => {
  let dir: string
  let backend: SqliteSettingsBackend
  let admin: StorageAdminProvider

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-admin-'))
    backend = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
    await backend.initialize()
    admin = new StorageAdminProvider(backend, silentLogger(), NO_RECORDS)
  })
  afterEach(async () => {
    await backend.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  })

  const names = async (): Promise<string[]> =>
    (await admin.listTables({})).tables.map((t) => t.name)

  it('get, query, count and isEmpty on an unwritten scoped name answer absent and create NOTHING', async () => {
    const scope = { namespace: 'ghost-addon', collection: 'addon-settings' }
    expect(await backend.get({ ...scope, key: 'root' })).toBeUndefined()
    expect(await backend.query({ ...scope })).toEqual([])
    expect(await backend.count({ ...scope })).toBe(0)
    expect(await backend.isEmpty({ ...scope })).toBe(true)
    expect(await names()).not.toContain('ghost-addon:addon-settings')
  })

  it('a WRITE to the same name still creates it', async () => {
    await backend.set({
      namespace: 'real-addon',
      collection: 'addon-settings',
      key: 'root',
      value: { a: 1 },
    })
    expect(await names()).toContain('real-addon:addon-settings')
  })

  it('listTables merges physical tables from peer database files', async () => {
    const peerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-admin-peer-'))
    const eventsBackend = new SqliteSettingsBackend(path.join(peerDir, 'events.db'), {
      databaseId: 'events',
      canonicalKv: false,
    })
    await eventsBackend.initialize()
    const db = eventsBackend.getDatabase()
    if (db === null) throw new Error('events backend not open')
    db.exec(
      'CREATE TABLE "pipeline-analytics:motion-events" (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    )
    db.prepare('INSERT INTO "pipeline-analytics:motion-events" (id, data) VALUES (?, ?)').run(
      'x',
      '{}',
    )
    const peer = {
      databaseId: 'events' as const,
      livePath: path.join(peerDir, 'events.db'),
      call: async () => {
        throw new Error('not used')
      },
      records: async () => {
        throw new Error('not used')
      },
      vector: async () => {
        throw new Error('not used')
      },
      declaredCollections: () => new Set<string>(),
      hasTable: async (name: string) => eventsBackend.hasTable(name),
      listPhysicalTables: async (ownerPrefix?: string | undefined) =>
        eventsBackend.listTables(ownerPrefix),
      servingThreadId: async () => 1,
      snapshot: async () => {
        throw new Error('not used')
      },
      stop: async () => {},
    }
    const merged = new StorageAdminProvider(backend, silentLogger(), NO_RECORDS, async () => [peer])
    const { tables } = await merged.listTables({})
    expect(tables.find((t) => t.name === 'pipeline-analytics:motion-events')).toMatchObject({
      rows: 1,
      owner: 'pipeline-analytics',
    })
    await eventsBackend.shutdown()
    await fs.rm(peerDir, { recursive: true, force: true })
  })

  it('listTables skips vec0 virtual tables when sqlite-vec is not loaded on this connection', async () => {
    const db = backend.getDatabase()
    if (db === null) throw new Error('backend not open')
    const dbPath = db.name
    await backend.shutdown()

    const seed = new Database(dbPath)
    const req = createRequire(import.meta.url)
    const sv = req('sqlite-vec') as { getLoadablePath: () => string }
    seed.loadExtension(sv.getLoadablePath())
    seed.exec('CREATE VIRTUAL TABLE "legacy:embeddings" USING vec0(embedding float[4])')
    seed.exec('CREATE TABLE "countable:table" (id TEXT PRIMARY KEY)')
    seed.prepare('INSERT INTO "countable:table" (id) VALUES (?)').run('one')
    seed.close()

    backend = new SqliteSettingsBackend(dbPath)
    await backend.initialize()
    admin = new StorageAdminProvider(backend, silentLogger(), NO_RECORDS)

    const { tables } = await admin.listTables({})
    expect(tables.find((t) => t.name === 'countable:table')).toMatchObject({ rows: 1 })
    expect(tables.map((t) => t.name)).not.toContain('legacy:embeddings')
  })

  it('listTables reports rows and owner, and filters by owner', async () => {
    await backend.set({
      namespace: 'a',
      collection: 'addon-settings',
      key: 'root',
      value: { x: 1 },
    })
    await backend.set({ namespace: 'a', collection: 'addon-settings', key: 'two', value: { x: 2 } })
    await backend.set({
      namespace: 'b',
      collection: 'addon-settings',
      key: 'root',
      value: { x: 1 },
    })
    const { tables } = await admin.listTables({ ownerPrefix: 'a' })
    expect(tables.map((t) => [t.name, t.owner, t.rows])).toEqual([['a:addon-settings', 'a', 2]])
  })

  describe('the nine dead tables of the records plan, phase 0 (D881; dropped by hand, D900)', () => {
    const DEAD = [
      'addon-devices',
      'sections',
      'provider-settings',
      'device-settings',
      'ai:budgets',
      'pipeline-analytics:retrain-dataset-versions',
      'training:dataset-versions',
      'benchmark:replay-runs',
      'viewer-settings-snapshots',
    ] as const

    it('a fresh engine creates none of them (the canonical list no longer names three)', async () => {
      const present = await names()
      for (const dead of DEAD) expect(present).not.toContain(dead)
    })
  })
})
