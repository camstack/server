/**
 * `censusByLocation` (the `getMediaLocationCensus` read behind the public
 * `media_storage_check` tool) is served from covering indexes, proved on the
 * real engine from the statements the store really prepares (D447), and its
 * counts are right, including rows stamped with a location nobody listed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '@camstack/server/system'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeStorageProvider, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { MEDIA_COLLECTION, MediaStore } from '../media-store.js'

/** Same documented test boundary as `cascade-over-real-sqlite.spec.ts`. */
function clientOver(backend: SqliteSettingsBackend): SettingsStoreClient {
  return {
    declareCollection: { mutate: (i: never) => backend.declareCollection(i) },
    insertMany: { mutate: (i: never) => backend.insertMany(i) },
    aggregate: { query: (i: never) => backend.aggregate(i) },
    histogram: { query: (i: never) => backend.histogram(i) },
    query: { query: (i: never) => backend.query(i) },
    count: { query: (i: never) => backend.count(i) },
  } as unknown as SettingsStoreClient
}

describe('media census by location over the real SQLite settings store', () => {
  let dir: string
  let backend: SqliteSettingsBackend
  let store: SettingsStoreClient
  let mediaStore: MediaStore
  let prepared: string[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'camstack-media-census-plan-'))
    backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
    await backend.initialize()
    store = clientOver(backend)
    await MediaStore.declare(store)
    mediaStore = new MediaStore({
      storage: makeFakeStorageProvider(),
      store,
      logger: makeSilentLogger(),
    })
    await backend.insertMany({
      collection: MEDIA_COLLECTION,
      records: [
        mediaRow('m1', 'loc-a', 100),
        mediaRow('m2', 'loc-a', 250),
        mediaRow('m3', 'loc-b', 1_000),
        mediaRow('m4', null, 7),
        mediaRow('m5', 'loc-gone', 40),
      ],
    })
    prepared = []
    const original = Database.prototype.prepare
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      prepared.push(sql)
      return original.call(this, sql)
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await backend.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  function mediaRow(
    label: string,
    locationId: string | null,
    sizeBytes: number,
  ): { data: Record<string, unknown> } {
    return {
      data: {
        // No `id` field: the collection's primary key is now an
        // `INTEGER PRIMARY KEY` rowid alias (D482) that SQLite assigns —
        // `insertMany` drops any supplied `id` for an auto-key collection, so
        // this row is addressed by whatever rowid it lands on, not `label`.
        deviceId: 104,
        ownerKind: 'track',
        ownerId: `t-${label}`,
        kind: 'thumbnail',
        timestamp: 1_000,
        // `thumbnail` is a SINGLE_INSTANCE_KIND — its write slot is
        // `SINGLE_SLOT_TS` (0), and the column is `NOT NULL`, so it must be
        // supplied explicitly (an `insertMany` INSERT binds NULL, not the
        // column default, for an omitted field).
        slotTs: 0,
        path: `104/${label}.jpg`,
        sizeBytes,
        locationId,
      },
    }
  }

  it('counts rows and bytes per location, unstamped and unlisted', async () => {
    const census = await mediaStore.censusByLocation(['loc-a', 'loc-b', 'loc-empty'])
    expect(census.locations).toEqual([
      { locationId: 'loc-a', rows: 2, bytes: 350 },
      { locationId: 'loc-b', rows: 1, bytes: 1_000 },
      { locationId: 'loc-empty', rows: 0, bytes: 0 },
    ])
    expect(census.unstamped).toEqual({ rows: 1, bytes: 7 })
    // loc-gone is stamped on a row but was not asked about: the difference finds it.
    expect(census.unlisted).toEqual({ rows: 1, bytes: 40 })
    expect(census.total).toEqual({ rows: 5, bytes: 1_397 })
  })

  it('serves every statement from an index, never a table scan', async () => {
    await mediaStore.censusByLocation(['loc-a'])
    const statements = prepared.filter((sql) => sql.includes('COUNT(*)'))
    expect(statements.length).toBe(3)
    for (const sql of statements) {
      const params = sql.includes('"locationId" = ?') ? ['loc-a'] : []
      const plan = backend.explainQueryPlan(sql, params).join(' | ')
      expect(plan).toContain('COVERING INDEX')
      expect(plan).not.toMatch(/SCAN \S+ *(\||$)/)
    }
  })
})
