/**
 * `insertMany` against a REAL SQLite file.
 *
 * The fake-store tests upstairs prove the STORE asks for one batch. They
 * cannot prove the engine turns that batch into one transaction, that an
 * `INTEGER` primary key stays a rowid alias, or that a failed row takes the
 * whole batch with it — those are properties of SQL, and a fake that returns
 * plausible values is precisely how this repo has had defects survive a green
 * suite.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const COLLECTION = 'metrics:node-load-samples'

const COLUMNS = [
  { name: 'id', type: 'INTEGER' as const, primaryKey: true, notNull: true },
  { name: 'nodeId', type: 'TEXT' as const, notNull: true },
  { name: 'atMs', type: 'INTEGER' as const, notNull: true },
  { name: 'pid', type: 'INTEGER' as const, notNull: true },
  { name: 'addonId', type: 'TEXT' as const },
  { name: 'cpuDeci', type: 'INTEGER' as const, notNull: true },
]

let dir: string
let dbPath: string
let backend: SqliteSettingsBackend

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'camstack-insert-many-'))
  dbPath = join(dir, 'camstack.db')
  backend = new SqliteSettingsBackend(dbPath)
  await backend.initialize()
  await backend.declareCollection({ collection: COLLECTION, columns: COLUMNS })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function row(pid: number, atMs = 1_000): { data: Record<string, unknown> } {
  return { data: { nodeId: 'hub', atMs, pid, addonId: 'recorder', cpuDeci: pid } }
}

describe('insertMany over real SQLite', () => {
  it('writes the whole batch', async () => {
    const result = await backend.insertMany({
      collection: COLLECTION,
      records: [row(1), row(2), row(3)],
    })
    expect(result).toEqual({ inserted: 3 })
    expect(await backend.count({ collection: COLLECTION })).toBe(3)
  })

  it('lets SQLite assign the INTEGER key — the row keeps a real rowid', async () => {
    await backend.insertMany({ collection: COLLECTION, records: [row(1), row(2)] })
    const db = new Database(dbPath, { readonly: true })
    try {
      // `id` IS the rowid when the column is `INTEGER PRIMARY KEY`. If the
      // engine had invented a `randomUUID()` for it — as `insert` does for a
      // TEXT key — the column would hold a string and this equality breaks.
      const rows = db
        .prepare(`SELECT rowid AS rid, id, typeof(id) AS t FROM "${COLLECTION}"`)
        .all() as { rid: number; id: number; t: string }[]
      expect(rows).toHaveLength(2)
      for (const r of rows) {
        expect(r.t).toBe('integer')
        expect(r.id).toBe(r.rid)
      }
    } finally {
      db.close()
    }
  })

  it('is ALL OR NOTHING — a batch that fails leaves no partial sample', async () => {
    // `nodeId` is NOT NULL; the third record omits it. A half-written sample
    // reads as "these were the only processes running", which is a lie a
    // missing sample never tells.
    await expect(
      backend.insertMany({
        collection: COLLECTION,
        records: [row(1), row(2), { data: { atMs: 1_000, pid: 3, cpuDeci: 3 } }],
      }),
    ).rejects.toThrow()
    expect(await backend.count({ collection: COLLECTION })).toBe(0)
  })

  it('reads back through the ordinary query surface, filtered and ordered', async () => {
    await backend.insertMany({
      collection: COLLECTION,
      records: [row(1, 3_000), row(2, 1_000), row(3, 2_000)],
    })
    const records = await backend.query({
      collection: COLLECTION,
      filter: {
        where: { nodeId: 'hub' },
        whereBetween: { atMs: [1_000, 2_500] },
        orderBy: { field: 'atMs', direction: 'asc' },
      },
    })
    expect(records.map((r) => r.data['atMs'])).toEqual([1_000, 2_000])
  })

  it('accepts an empty batch without touching the database', async () => {
    expect(await backend.insertMany({ collection: COLLECTION, records: [] })).toEqual({
      inserted: 0,
    })
  })

  it('still mints an id for a TEXT-keyed collection that supplies none', async () => {
    await backend.declareCollection({
      collection: 'test:text-keyed',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'value', type: 'TEXT', notNull: true },
      ],
    })
    await backend.insertMany({
      collection: 'test:text-keyed',
      records: [{ data: { value: 'a' } }, { id: 'chosen', data: { value: 'b' } }],
    })
    const records = await backend.query({ collection: 'test:text-keyed' })
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.id)).toContain('chosen')
    expect(records.every((r) => r.id.length > 0)).toBe(true)
  })
})
