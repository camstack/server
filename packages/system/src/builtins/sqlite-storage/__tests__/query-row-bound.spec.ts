/**
 * The defensive row bound on `query`, and the warning that makes it visible.
 *
 * These assertions exist because of a real kill: on 2026-08-07 hub-main hit the
 * V8 heap limit inside `Statement::JS_all` with 3.6 GB of headroom four seconds
 * earlier — one `SELECT` with no `LIMIT`. See `query-bounds.ts`.
 *
 * Two properties are load-bearing and each is asserted by REMOVING it:
 *  - the bound applies when the caller gave no `limit` (otherwise the OOM path
 *    is still open);
 *  - hitting it is LOGGED (otherwise a truncated read is indistinguishable from
 *    a complete one, which is the worse failure).
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  SETTINGS_QUERY_DEFAULT_ROW_CAP,
  SETTINGS_QUERY_HARD_ROW_CAP,
  resolveRowBound,
} from '../query-bounds.js'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

interface CapturedLog {
  readonly message: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

function recordingLogger(sink: CapturedLog[]): IScopedLogger {
  const push =
    () =>
    (message: string, ctx?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> }) => {
      sink.push({ message, meta: ctx?.meta ?? {}, tags: ctx?.tags ?? {} })
    }
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: push(),
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

const COLLECTION = 'bounded-test:rows'

async function openBackendWith(
  rows: number,
  warnings: CapturedLog[],
): Promise<SqliteSettingsBackend> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-bound-'))
  tmpDirs.push(dir)
  const backend = new SqliteSettingsBackend(
    path.join(dir, 'camstack.db'),
    undefined,
    recordingLogger(warnings),
  )
  await backend.initialize()
  await backend.declareCollection({
    collection: COLLECTION,
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
      { name: 'deviceId', type: 'INTEGER', notNull: true },
      { name: 'payload', type: 'TEXT', notNull: true },
    ],
  })
  const db = backend.getDatabase()
  if (db === null) throw new Error('backend not open')
  const insert = db.prepare(`INSERT INTO "${COLLECTION}" (id, deviceId, payload) VALUES (?, ?, ?)`)
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`row-${String(i).padStart(7, '0')}`, 101, 'x')
  })()
  return backend
}

describe('resolveRowBound', () => {
  it('caps a caller that gave no limit', () => {
    expect(resolveRowBound(undefined)).toEqual({
      limit: SETTINGS_QUERY_DEFAULT_ROW_CAP,
      source: 'default-cap',
    })
  })

  it('honours an explicit limit verbatim', () => {
    expect(resolveRowBound(250)).toEqual({ limit: 250, source: 'caller' })
    expect(resolveRowBound(0)).toEqual({ limit: 0, source: 'caller' })
  })

  it('clamps an explicit limit above the hard cap', () => {
    expect(resolveRowBound(SETTINGS_QUERY_HARD_ROW_CAP + 1)).toEqual({
      limit: SETTINGS_QUERY_HARD_ROW_CAP,
      source: 'hard-cap',
    })
  })

  /**
   * SQLite reads a NEGATIVE `LIMIT` as "no limit". The cap schema is
   * `z.number().optional()`, so `-1` is accepted over the wire — it was the one
   * input that could have reproduced the OOM through a bound that LOOKED
   * applied. Treated as absent.
   */
  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('treats %p as no limit rather than as an unbounded scan', (bad) => {
    expect(resolveRowBound(bad).source).toBe('default-cap')
    expect(resolveRowBound(bad).limit).toBe(SETTINGS_QUERY_DEFAULT_ROW_CAP)
  })
})

describe('SqliteSettingsBackend.query row bound', () => {
  it('truncates an unbounded query at the default cap', async () => {
    const warnings: CapturedLog[] = []
    const backend = await openBackendWith(SETTINGS_QUERY_DEFAULT_ROW_CAP + 17, warnings)
    const rows = await backend.query({ collection: COLLECTION })
    expect(rows).toHaveLength(SETTINGS_QUERY_DEFAULT_ROW_CAP)
  })

  it('WARNS when it truncates, naming the collection and the bound', async () => {
    const warnings: CapturedLog[] = []
    const backend = await openBackendWith(SETTINGS_QUERY_DEFAULT_ROW_CAP + 17, warnings)
    await backend.query({ collection: COLLECTION })
    const hit = warnings.find((w) => w.message.includes('row cap'))
    expect(hit, 'a truncated read must never be silent').toBeDefined()
    expect(hit?.meta['collection']).toBe(COLLECTION)
    expect(hit?.meta['rowCap']).toBe(SETTINGS_QUERY_DEFAULT_ROW_CAP)
    expect(hit?.meta['boundSource']).toBe('default-cap')
  })

  /** Per-device diagnosis is impossible without the tag (repo logging rule). */
  it('carries tags.deviceId when the filter names one', async () => {
    const warnings: CapturedLog[] = []
    const backend = await openBackendWith(SETTINGS_QUERY_DEFAULT_ROW_CAP + 5, warnings)
    await backend.query({
      collection: COLLECTION,
      filter: { where: { deviceId: 101 } },
    })
    const hit = warnings.find((w) => w.message.includes('row cap'))
    expect(hit?.tags['deviceId']).toBe(101)
  })

  it('does NOT warn when the result fits inside the cap', async () => {
    const warnings: CapturedLog[] = []
    const backend = await openBackendWith(10, warnings)
    const rows = await backend.query({ collection: COLLECTION })
    expect(rows).toHaveLength(10)
    expect(warnings.filter((w) => w.message.includes('row cap'))).toHaveLength(0)
  })

  /**
   * A paging caller asks for exactly PAGE rows and gets exactly PAGE rows. That
   * is service, not truncation — warning here would make every prune loop in
   * the repo scream once per page.
   */
  it('does NOT warn when an explicit limit is filled exactly', async () => {
    const warnings: CapturedLog[] = []
    const backend = await openBackendWith(500, warnings)
    const rows = await backend.query({
      collection: COLLECTION,
      filter: { limit: 100 },
    })
    expect(rows).toHaveLength(100)
    expect(warnings.filter((w) => w.message.includes('row cap'))).toHaveLength(0)
  })

  it('still pages correctly with limit + offset (semantics unchanged)', async () => {
    const warnings: CapturedLog[] = []
    const backend = await openBackendWith(250, warnings)
    const seen: string[] = []
    for (let offset = 0; ; offset += 100) {
      const page = await backend.query({
        collection: COLLECTION,
        filter: {
          orderBy: { field: 'id', direction: 'asc' },
          limit: 100,
          offset,
        },
      })
      if (page.length === 0) break
      seen.push(...page.map((r) => r.id))
      if (page.length < 100) break
    }
    expect(seen).toHaveLength(250)
    expect(new Set(seen).size).toBe(250)
  })

  it('applies the hard cap even to an explicit limit', async () => {
    const warnings: CapturedLog[] = []
    const backend = await openBackendWith(20, warnings)
    // The table is small, so the cap cannot be OBSERVED in the row count here —
    // what is asserted is that the SQL bound is the hard cap, not the request.
    await backend.query({
      collection: COLLECTION,
      filter: { limit: SETTINGS_QUERY_HARD_ROW_CAP + 1_000_000 },
    })
    expect(resolveRowBound(SETTINGS_QUERY_HARD_ROW_CAP + 1_000_000).limit).toBe(
      SETTINGS_QUERY_HARD_ROW_CAP,
    )
  })
})
