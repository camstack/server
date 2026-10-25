/**
 * An index declared on a KV-shaped collection must actually be USED.
 *
 * ## What this pins
 *
 * A KV collection is `(id TEXT PK, data TEXT)` — every field lives inside the
 * `data` blob, and `compileFilter` reaches one with
 * `json_extract("data", '$.field')`. `ensureTable` used to render every index
 * as a bare `"field"`, which for a blob field names no column at all.
 *
 * `share_view_tokens` is the collection that made this matter: it holds the
 * share-link tokens and EVERY validation of a share-link token queries
 * `where: { tokenHash }`. That predicate was a full-table scan which parsed the
 * JSON of every row to compare one hash — on the authentication path, at
 * whatever size the table happens to reach.
 *
 * ## Why the assertion is EXPLAIN QUERY PLAN and not "the index exists"
 *
 * SQLite uses an expression index only when the query's expression matches the
 * indexed one TEXTUALLY. An index built from a different-but-equivalent
 * expression is created happily, appears in `sqlite_master`, and is then
 * silently ignored by the planner. Asserting the DDL ran would therefore pass
 * for exactly the bug this is meant to prevent — it would read as verification.
 * So the test asks the planner what it will actually do.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CollectionColumn, CollectionIndex } from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function backend(): Promise<{
  b: SqliteSettingsBackend
  dbPath: string
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-kvindex-'))
  tmpDirs.push(dir)
  const dbPath = path.join(dir, 'test.db')
  const b = new SqliteSettingsBackend(dbPath)
  await b.initialize()
  return { b, dbPath }
}

/** The exact shape of `share_view_tokens`. */
const KV_COLUMNS: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
  { name: 'data', type: 'TEXT', notNull: true },
]

const KV_INDEXES: readonly CollectionIndex[] = [
  { name: 'idx_share_view_tokens_hash', columns: ['tokenHash'] },
  { name: 'idx_share_view_tokens_user', columns: ['userId'] },
]

interface PlanRow {
  readonly detail: string
}

/** What the planner will do for `SELECT … WHERE json_extract(data,'$.f') = ?`. */
function planFor(dbPath: string, table: string, field: string): string {
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id, data FROM "${table}" WHERE json_extract("data", '$.${field}') = ?`,
      )
      .all('x') as PlanRow[]
    return rows.map((r) => r.detail).join(' | ')
  } finally {
    db.close()
  }
}

describe('an index on a KV-blob field', () => {
  it('is created as an expression index the planner actually uses', async () => {
    const { b, dbPath } = await backend()
    await b.declareCollection({
      collection: 'share_view_tokens',
      columns: KV_COLUMNS,
      indexes: KV_INDEXES,
    })
    for (let i = 0; i < 200; i += 1) {
      await b.insert({
        collection: 'share_view_tokens',
        record: {
          id: `tok-${i}`,
          data: {
            id: `tok-${i}`,
            tokenHash: `hash-${i}`,
            userId: `user-${i % 7}`,
          },
        },
      })
    }

    // THE ASSERTION. A scan reads `SCAN share_view_tokens`; using the index
    // reads `SEARCH … USING INDEX idx_share_view_tokens_hash`.
    const hashPlan = planFor(dbPath, 'share_view_tokens', 'tokenHash')
    expect(hashPlan).toContain('idx_share_view_tokens_hash')
    expect(hashPlan).not.toContain('SCAN')

    const userPlan = planFor(dbPath, 'share_view_tokens', 'userId')
    expect(userPlan).toContain('idx_share_view_tokens_user')
  })

  it('still answers the query correctly through the index', async () => {
    const { b } = await backend()
    await b.declareCollection({
      collection: 'share_view_tokens',
      columns: KV_COLUMNS,
      indexes: KV_INDEXES,
    })
    for (let i = 0; i < 50; i += 1) {
      await b.insert({
        collection: 'share_view_tokens',
        record: {
          id: `tok-${i}`,
          data: {
            id: `tok-${i}`,
            tokenHash: `hash-${i}`,
            userId: `user-${i % 5}`,
          },
        },
      })
    }

    const one = await b.query({
      collection: 'share_view_tokens',
      filter: { where: { tokenHash: 'hash-42' } },
    })
    expect(one).toHaveLength(1)
    expect(one[0]?.id).toBe('tok-42')

    const mine = await b.query({
      collection: 'share_view_tokens',
      filter: { where: { userId: 'user-3' } },
    })
    expect(mine).toHaveLength(10)

    const none = await b.query({
      collection: 'share_view_tokens',
      filter: { where: { tokenHash: 'nope' } },
    })
    expect(none).toHaveLength(0)
  })

  /**
   * Declaring an index must not disturb the rows. `ensureTable` has a
   * destructive rebuild branch, and the whole point of indexing this table
   * rather than adding real columns to it is that the column list is untouched
   * and so neither the rebuild nor the `ALTER TABLE` branch is reached.
   */
  it('adding the indexes to an EXISTING unindexed collection keeps every row', async () => {
    const { b, dbPath } = await backend()
    // Boot 1: the collection as it exists on the live hub today — no indexes.
    await b.declareCollection({
      collection: 'share_view_tokens',
      columns: KV_COLUMNS,
    })
    for (let i = 0; i < 6; i += 1) {
      await b.insert({
        collection: 'share_view_tokens',
        record: {
          id: `tok-${i}`,
          data: { id: `tok-${i}`, tokenHash: `hash-${i}`, userId: 'operator' },
        },
      })
    }

    // Boot 2: the same shape, now with the indexes.
    await b.declareCollection({
      collection: 'share_view_tokens',
      columns: KV_COLUMNS,
      indexes: KV_INDEXES,
    })

    const all = await b.query({ collection: 'share_view_tokens', filter: {} })
    expect(all).toHaveLength(6)
    const hit = await b.query({
      collection: 'share_view_tokens',
      filter: { where: { tokenHash: 'hash-3' } },
    })
    expect(hit).toHaveLength(1)
    expect(planFor(dbPath, 'share_view_tokens', 'tokenHash')).toContain(
      'idx_share_view_tokens_hash',
    )
  })

  /**
   * A structured collection keeps plain column indexes — the KV branch must not
   * capture tables whose fields are real columns.
   */
  it('leaves a structured collection on a plain column index', async () => {
    const { b, dbPath } = await backend()
    await b.declareCollection({
      collection: 'structured_things',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'deviceId', type: 'INTEGER', notNull: true },
        { name: 'label', type: 'TEXT', notNull: true },
      ],
      indexes: [{ name: 'idx_structured_device', columns: ['deviceId'] }],
    })
    for (let i = 0; i < 100; i += 1) {
      await b.insert({
        collection: 'structured_things',
        record: { id: `r-${i}`, data: { deviceId: i % 10, label: `l-${i}` } },
      })
    }

    const db = new Database(dbPath, { readonly: true })
    try {
      const rows = db
        .prepare('EXPLAIN QUERY PLAN SELECT id FROM "structured_things" WHERE "deviceId" = ?')
        .all(3) as PlanRow[]
      expect(rows.map((r) => r.detail).join(' | ')).toContain('idx_structured_device')
    } finally {
      db.close()
    }

    const found = await b.query({
      collection: 'structured_things',
      filter: { where: { deviceId: 3 } },
    })
    expect(found).toHaveLength(10)
  })
})
