/**
 * Driven against a REAL in-memory SQLite with the real `sqlite-vec` extension.
 *
 * A fake would be worthless here: everything this backend does that could go
 * wrong is the extension's contract — the TEXT primary key, the BigInt binding
 * for integer metadata, the distance-to-score conversion, and whether a
 * metadata filter actually narrows the KNN. A hand-written double would agree
 * with whatever the implementation assumed.
 */

import { createRequire } from 'node:module'
import {
  encodeVectorBase64,
  type IScopedLogger,
  isVectorIndexDimConflict,
  VECTOR_INDEX_DIM_CONFLICT,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { type RawSqliteDatabase, SqliteVecVectorIndex, VEC_KNN_MAX_K } from '../vector-index-vec.js'

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

function axis(i: number, dim = 4): string {
  const v = new Float32Array(dim)
  v[i] = 1
  return encodeVectorBase64(v)
}

/**
 * Load the extension by RESOLVING its path, not via `sqliteVec.load()`.
 *
 * `load()` calls `import.meta.resolve`, which vitest's SSR transform does not
 * provide — the suite fails with "__vite_ssr_import_meta__.resolve is not a
 * function" and nothing about the backend gets exercised. `getLoadablePath()`
 * is the same lookup without that dependency, and it is what the production
 * addon uses too.
 */
function loadVec(db: Database.Database): void {
  const req = createRequire(import.meta.url)
  const sv = req('sqlite-vec') as { getLoadablePath: () => string }
  db.loadExtension(sv.getLoadablePath())
}

function makeIndex(): { index: SqliteVecVectorIndex; db: Database.Database } {
  const db = new Database(':memory:')
  loadVec(db)
  const index = new SqliteVecVectorIndex({ db: db as unknown as RawSqliteDatabase, logger })
  return { index, db }
}

describe('SqliteVecVectorIndex', () => {
  let index: SqliteVecVectorIndex
  let db: Database.Database

  beforeEach(async () => {
    const made = makeIndex()
    index = made.index
    db = made.db
    await index.loadIndexRegistry()
    await index.declareIndex('t', 4, 'cosine')
    await index.upsert('t', [
      {
        id: 'track-a',
        vector: axis(0),
        metadata: { deviceId: 101, timestamp: 100, className: 'person', trackId: 'track-a' },
      },
      {
        id: 'track-b',
        vector: axis(1),
        metadata: { deviceId: 102, timestamp: 200, className: 'car', trackId: 'track-b' },
      },
      {
        id: 'track-c',
        vector: axis(2),
        metadata: { deviceId: 101, timestamp: 300, className: 'person', trackId: 'track-c' },
      },
    ])
  })

  it('accepts a TEXT primary key — our ids are track UUIDs, not integers', async () => {
    const stats = await index.stats('t')
    expect(stats.count).toBe(3)
    expect(stats.backend).toBe('sqlite-vec')
  })

  it('returns a SCORE where higher is nearer, not a raw distance', async () => {
    // vec0 cosine gives 0 for identical and 2 for opposite; the capability
    // contract is the other way round. Getting this backwards would rank every
    // result in reverse and look like a model problem.
    const res = await index.query({ index: 't', vector: axis(0), topK: 3 })
    expect(res.matches[0]?.id).toBe('track-a')
    expect(res.matches[0]?.score).toBeCloseTo(1, 5)
    expect(res.matches[1]?.score).toBeLessThan(res.matches[0]?.score ?? 0)
  })

  it('binds integer metadata so vec0 accepts it', async () => {
    // A plain JS number arrives as FLOAT and vec0 refuses an INTEGER metadata
    // column outright — an upsert that "succeeded" with 0 rows written.
    const hit = (await index.query({ index: 't', vector: axis(0), topK: 1 })).matches[0]
    expect(hit?.metadata['deviceId']).toBe(101)
    expect(hit?.metadata['timestamp']).toBe(100)
  })

  it('PUSHES an equals filter into the KNN statement', async () => {
    const res = await index.query({
      index: 't',
      vector: axis(0),
      topK: 5,
      filter: { equals: { deviceId: 102 } },
    })
    expect(res.matches.map((m) => m.id)).toEqual(['track-b'])
    expect(res.scanned).toBe(1)
  })

  it('pushes a between filter', async () => {
    const res = await index.query({
      index: 't',
      vector: axis(0),
      topK: 5,
      filter: { between: { timestamp: [150, 350] } },
    })
    expect(res.matches.map((m) => m.id).sort()).toEqual(['track-b', 'track-c'])
  })

  it('APPLIES a non-promoted clause in JS rather than ignoring it', async () => {
    // trackId lives in the JSON remainder; SQL cannot evaluate it, and a
    // filter that is silently dropped returns rows the caller treats as hits.
    const res = await index.query({
      index: 't',
      vector: axis(0),
      topK: 5,
      filter: { equals: { trackId: 'track-c' } },
    })
    expect(res.matches.map((m) => m.id)).toEqual(['track-c'])
  })

  it('honours minScore', async () => {
    const res = await index.query({ index: 't', vector: axis(0), topK: 5, minScore: 0.5 })
    expect(res.matches.map((m) => m.id)).toEqual(['track-a'])
  })

  it('upserts by id instead of duplicating', async () => {
    await index.upsert('t', [
      { id: 'track-a', vector: axis(3), metadata: { deviceId: 101, timestamp: 999 } },
    ])
    expect((await index.stats('t')).count).toBe(3)
    const got = await index.getByIds('t', ['track-a'])
    expect(got[0]?.metadata['timestamp']).toBe(999)
  })

  it('rejects a vector of the wrong dimension and counts it', async () => {
    const res = await index.upsert('t', [
      { id: 'bad', vector: axis(0, 8), metadata: { deviceId: 1 } },
    ])
    expect(res).toEqual({ upserted: 0, rejected: 1 })
  })

  it('deletes by id', async () => {
    expect(await index.deleteByIds('t', ['track-a', 'track-b'])).toBe(2)
    expect((await index.stats('t')).count).toBe(1)
  })

  it('deletes by a pushable filter in ONE statement', async () => {
    expect(await index.deleteByFilter('t', { equals: { deviceId: 101 } })).toBe(2)
    expect((await index.stats('t')).count).toBe(1)
  })

  it('deletes by a NON-pushable filter without taking the neighbours', async () => {
    expect(await index.deleteByFilter('t', { equals: { trackId: 'track-b' } })).toBe(1)
    const left = (await index.query({ index: 't', vector: axis(0), topK: 5 })).matches
    expect(left.map((m) => m.id).sort()).toEqual(['track-a', 'track-c'])
  })

  it('refuses to redeclare with a different dim rather than wiping — with THE shared code', async () => {
    // Consumers classify on the code (D649): an outage and a refusal mean
    // opposite things to a delete.
    const err: unknown = await index.declareIndex('t', 8, 'cosine').then(
      () => null,
      (e: unknown) => e,
    )
    expect(isVectorIndexDimConflict(err)).toBe(true)
    expect(String(err)).toContain(VECTOR_INDEX_DIM_CONFLICT)
  })

  it('recovers its declarations after a restart', async () => {
    // Same database, fresh instance — the vec0 table survives, and the spec
    // has to as well or every method throws "never declared".
    const fresh = new SqliteVecVectorIndex({ db: db as unknown as RawSqliteDatabase, logger })
    await fresh.loadIndexRegistry()
    const stats = await fresh.stats('t')
    expect(stats.count).toBe(3)
    expect(stats.dim).toBe(4)
  })

  it('rejects an index that was never declared', async () => {
    await expect(index.stats('ghost')).rejects.toThrow(/never declared/)
  })
})

/**
 * The row cap had a sibling door with no lock.
 *
 * `resolveRowBound` guards `data-store-provider.query` — the door 24 analytics
 * call sites use. `vector-store.query` reaches the SAME database file, on the
 * same connection, in the SAME process (hub-main: `sqlite-settings` is a
 * `@camstack/system` builtin and is never handed to `$process.spawnRunner`),
 * and its `topK` was `z.number().int().positive()` with no `.max()`, bound
 * straight into `k = ?` and `.all()`ed.
 *
 * `object-embedding-store.ts:340` passes `topK: input.limit` — literally the
 * same caller-supplied number that `resolveRowBound` clamps on the other door.
 *
 * MEASURED, not assumed: sqlite-vec refuses `k > 4096` outright
 * (`k value in knn query too large, provided 20000 and the limit is 4096`), so
 * this door was never an OOM vector the way the settings door was — the
 * extension was holding the line. What it did instead was throw a raw
 * `SqliteError` at any caller who asked for more, which is why a clamp and not
 * a bigger number is the fix.
 */
describe('the KNN door obeys the SAME bound as the query door', () => {
  let index: SqliteVecVectorIndex
  let warnings: Array<{ message: string; meta: unknown }>

  beforeEach(async () => {
    warnings = []
    const spy: IScopedLogger = {
      ...logger,
      warn: (message: string, extra?: { meta?: unknown }) => {
        warnings.push({ message, meta: extra?.meta })
      },
      child: () => spy,
      withTags: () => spy,
    }
    const db = new Database(':memory:')
    loadVec(db)
    index = new SqliteVecVectorIndex({ db: db as unknown as RawSqliteDatabase, logger: spy })
    await index.loadIndexRegistry()
    await index.declareIndex('t', 4, 'cosine')
    await index.upsert('t', [
      {
        id: 'track-a',
        vector: axis(0),
        metadata: { deviceId: 101, timestamp: 100, className: 'person', trackId: 'track-a' },
      },
    ])
  })

  it('clamps an absurd topK instead of binding it into the KNN', async () => {
    const res = await index.query({ index: 't', vector: axis(0), topK: 1_000_000_000 })
    // Still correct — a bound is not a failure.
    expect(res.matches.map((m) => m.id)).toEqual(['track-a'])
    // ...and never silent. A truncated read that looks complete is worse than
    // the OOM it prevents.
    const imposed = warnings.filter((w) => /clamp|bound|cap/i.test(w.message))
    expect(imposed.length).toBe(1)
    expect(JSON.stringify(imposed[0])).toContain(String(VEC_KNN_MAX_K))
  })

  /**
   * The number, in the ANSWER.
   *
   * The clamp has always logged. What it did not do is TELL THE CALLER, and the
   * caller was an orphan audit that asked for 20,000, received 4,096 and
   * reported `examined: 4096` as though it had read a 22,128-row index — for
   * weeks, because a warn in the provider's own log is not something a caller
   * can branch on.
   */
  it('reports the topK it actually ran with, not the one it was asked for', async () => {
    const res = await index.query({ index: 't', vector: axis(0), topK: 20_000 })
    expect(res.effectiveTopK).toBe(VEC_KNN_MAX_K)
    expect(res.effectiveTopK).toBeLessThan(20_000)
  })

  it('leaves an ordinary topK completely alone — no clamp, no line', async () => {
    const res = await index.query({ index: 't', vector: axis(0), topK: 10 })
    expect(res.matches.map((m) => m.id)).toEqual(['track-a'])
    expect(res.truncated).toBe(false)
    expect(warnings.filter((w) => /clamp|bound|cap/i.test(w.message))).toEqual([])
  })

  it('honours a large-but-legal topK verbatim', async () => {
    const res = await index.query({ index: 't', vector: axis(0), topK: VEC_KNN_MAX_K })
    expect(res.matches.map((m) => m.id)).toEqual(['track-a'])
    expect(res.effectiveTopK).toBe(VEC_KNN_MAX_K)
    expect(warnings.filter((w) => /clamp|bound|cap/i.test(w.message))).toEqual([])
  })
})

describe('SqliteVecVectorIndex — enumerate and read back', () => {
  let index: SqliteVecVectorIndex

  beforeEach(async () => {
    const made = makeIndex()
    index = made.index
    await index.loadIndexRegistry()
    await index.declareIndex('walk', 4, 'cosine')
    await index.upsert(
      'walk',
      Array.from({ length: 7 }, (_, i) => ({
        id: `row-${i}`,
        vector: axis(i % 4),
        metadata: { deviceId: 101, timestamp: 1_000 + i, trackId: `t-${i}` },
      })),
    )
  })

  /**
   * The reason `scan` exists: a KNN cannot enumerate. It has a `k` ceiling, and
   * enumerating with a zero probe vector — which is what the audit did — asks
   * for the nearest rows to a direction that does not exist.
   */
  it('walks every row across pages and ends with a null cursor', async () => {
    const seen: string[] = []
    let cursor: number | null = 0
    let pages = 0
    while (cursor !== null && pages < 20) {
      const page: Awaited<ReturnType<SqliteVecVectorIndex['scan']>> = await index.scan(
        'walk',
        cursor,
        3,
      )
      for (const item of page.items) seen.push(item.id)
      cursor = page.nextCursor
      pages += 1
    }
    expect(cursor).toBeNull()
    expect(seen.sort()).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6'])
    // More than one page, or the walk proved nothing about paging.
    expect(pages).toBeGreaterThan(1)
  })

  it('carries the promoted columns and the extra JSON onto a scanned row', async () => {
    const page = await index.scan('walk', 0, 1)
    const first = page.items[0]
    expect(first?.metadata['deviceId']).toBe(101)
    expect(first?.metadata['trackId']).toBe('t-0')
  })

  it('fetchByIds returns the SAME bytes the upsert was given', async () => {
    const rows = await index.fetchByIds('walk', ['row-0', 'row-5'])
    expect(rows.map((r) => r.id).sort()).toEqual(['row-0', 'row-5'])
    const byId = new Map(rows.map((r) => [r.id, r.vector]))
    expect(byId.get('row-0')).toBe(axis(0))
    expect(byId.get('row-5')).toBe(axis(1))
  })

  it('fetchByIds omits an unknown id rather than returning an empty vector', async () => {
    const rows = await index.fetchByIds('walk', ['row-0', 'nope'])
    expect(rows.map((r) => r.id)).toEqual(['row-0'])
  })

  it('getByIds still returns NO vectors — the two methods stay different', async () => {
    const rows = await index.getByIds('walk', ['row-0'])
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0] ?? {})).toEqual(['id', 'metadata'])
  })
})
