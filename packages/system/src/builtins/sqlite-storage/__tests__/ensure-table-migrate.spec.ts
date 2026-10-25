/**
 * Schema evolution through `declareCollection` — additive columns must
 * MIGRATE IN PLACE (ALTER TABLE ADD COLUMN), never drop the table. The
 * 2026-07-17 train wiped the whole tracks history because new envelope
 * columns triggered the drop/recreate path; historical tables must survive
 * additive changes. The destructive rebuild remains ONLY for shapes SQLite
 * cannot evolve: the legacy `(id, data)` KV form, and new columns that are
 * PRIMARY KEY / UNIQUE / NOT NULL-without-default.
 *
 * Driven through the public collection surface: `ensureTable` and the six
 * `table*` methods are gone (B2), and the evolution logic they carried now
 * runs underneath `declareCollection`.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CollectionColumn } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function backend(): Promise<{ b: SqliteSettingsBackend; dbPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-migrate-'))
  tmpDirs.push(dir)
  const b = new SqliteSettingsBackend(path.join(dir, 'test.db'))
  await b.initialize()
  return { b, dbPath: path.join(dir, 'test.db') }
}

/** A fresh process against the same file — the deploy case. */
async function reopen(dbPath: string): Promise<SqliteSettingsBackend> {
  const b = new SqliteSettingsBackend(dbPath)
  await b.initialize()
  return b
}

const BASE: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT', primaryKey: true },
  { name: 'deviceId', type: 'INTEGER', notNull: true },
  { name: 'className', type: 'TEXT' },
]

describe('declareCollection — additive schema evolution', () => {
  it('adds NEW nullable columns in place and PRESERVES existing rows', async () => {
    const { b, dbPath } = await backend()
    await b.declareCollection({ collection: 't:tracks', columns: BASE })
    await b.insert({
      collection: 't:tracks',
      record: { id: 'a', data: { deviceId: 104, className: 'person' } },
    })

    const b2 = await reopen(dbPath)
    await b2.declareCollection({
      collection: 't:tracks',
      columns: [
        ...BASE,
        { name: 'envMinX', type: 'REAL' },
        { name: 'frameWidth', type: 'INTEGER' },
      ],
    })

    const rows = await b2.query({ collection: 't:tracks' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('a')
    // The new column is writable and queryable (no "no such column").
    await b2.insert({
      collection: 't:tracks',
      record: {
        id: 'b',
        data: { deviceId: 591, className: 'car', envMinX: 0.5, frameWidth: 640 },
      },
    })
    const rows2 = await b2.query({ collection: 't:tracks' })
    expect(rows2).toHaveLength(2)
  })

  it('still rebuilds a legacy (id, data) KV collection when a structured shape arrives', async () => {
    const { b, dbPath } = await backend()
    await b.declareCollection({
      collection: 't:legacy',
      columns: [{ name: 'data', type: 'TEXT', notNull: true }],
    })
    const b2 = await reopen(dbPath)
    await b2.declareCollection({ collection: 't:legacy', columns: BASE })
    await b2.insert({
      collection: 't:legacy',
      record: { id: 'x', data: { deviceId: 1, className: 'c' } },
    })
    const rows = await b2.query({ collection: 't:legacy' })
    expect(rows).toHaveLength(1)
  })

  it('rebuilds when a new column cannot be added additively (NOT NULL without default)', async () => {
    const { b, dbPath } = await backend()
    await b.declareCollection({ collection: 't:strict', columns: BASE })
    await b.insert({
      collection: 't:strict',
      record: { id: 'a', data: { deviceId: 1, className: 'c' } },
    })

    const b2 = await reopen(dbPath)
    await b2.declareCollection({
      collection: 't:strict',
      columns: [...BASE, { name: 'mandatory', type: 'TEXT', notNull: true }],
    })
    // The collection was rebuilt (row gone) but WORKS in its new shape.
    await b2.insert({
      collection: 't:strict',
      record: { id: 'b', data: { deviceId: 2, className: 'c', mandatory: 'y' } },
    })
    const rows = await b2.query({ collection: 't:strict' })
    expect(rows).toHaveLength(1)
  })

  it('a NOT NULL column WITH a default is added additively (rows preserved, default backfilled)', async () => {
    const { b, dbPath } = await backend()
    await b.declareCollection({ collection: 't:dflt', columns: BASE })
    await b.insert({
      collection: 't:dflt',
      record: { id: 'a', data: { deviceId: 1, className: 'c' } },
    })

    const b2 = await reopen(dbPath)
    await b2.declareCollection({
      collection: 't:dflt',
      columns: [...BASE, { name: 'state', type: 'TEXT', notNull: true, defaultValue: 'active' }],
    })
    const rows = await b2.query({ collection: 't:dflt' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.data['state']).toBe('active')
  })
})

/**
 * The case every test above misses, because every test above `reopen()`s.
 *
 * `reopen` is a NEW backend instance — that models a hub-main restart, not a
 * deploy. The real deploy restarts only the ADDON runner; the backend lives
 * in hub-main and keeps running, so the second `declareCollection` arrives on
 * the SAME instance. Memoised by table name, that call was a no-op: no
 * `ALTER TABLE`, and no refresh of the column set `compileFilter` resolves
 * against. `pipeline-analytics:tracks` shipped without `retrainStatus` this
 * way, and because a select-mode filter DROPS a predicate it cannot express,
 * the retention pin silently matched nothing.
 */
describe('declareCollection — redeclaration on a LIVE backend (the deploy case)', () => {
  it('adds a column declared by a redeployed addon without restarting the backend', async () => {
    const { b } = await backend()
    await b.declareCollection({ collection: 't:tracks', columns: BASE })
    await b.insert({
      collection: 't:tracks',
      record: { id: 'a', data: { deviceId: 104, className: 'person' } },
    })

    // Same instance — only the addon "redeployed".
    await b.declareCollection({
      collection: 't:tracks',
      columns: [
        ...BASE,
        { name: 'retrainStatus', type: 'TEXT', notNull: true, defaultValue: 'none' },
      ],
    })

    // Pre-existing row got the default materialised, not NULL.
    const all = await b.query({ collection: 't:tracks' })
    expect(all).toHaveLength(1)
    expect(all[0]!.data['retrainStatus']).toBe('none')

    // And the column is now NAMEABLE in a filter. This is the assertion that
    // actually reproduces the outage: before the fix the predicate was
    // dropped, so this returned the row instead of nothing.
    await b.insert({
      collection: 't:tracks',
      record: { id: 'b', data: { deviceId: 104, className: 'car', retrainStatus: 'staging' } },
    })
    const staging = await b.query({
      collection: 't:tracks',
      filter: { where: { retrainStatus: 'staging' } },
    })
    expect(staging.map((r) => r.id)).toEqual(['b'])
  })
})
