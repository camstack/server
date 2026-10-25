/**
 * `footprintByLocation` is served from a COVERING index — proved on the real
 * engine, from the statement the store really prepares.
 *
 * ## What happened
 *
 * `hub/sqlite-settings` is one synchronous thread. On 2026-09-10/11 the
 * profiler's slow-call WARN fired every five minutes, all evening, on
 *
 *     op=aggregate collection=pipeline-analytics:media
 *     shape="SELECT … FROM <t> WHERE \"locationId\" = ?"
 *     durationMs=4128…6962 rows=1
 *     plan=["SEARCH pipeline-analytics:media USING INDEX idx_media_location (locationId=?)"]
 *
 * `idx_media_location` finds the range but does not carry `sizeBytes`, so the
 * SUM fetches the table row behind every index entry — ~1.25 M scattered reads
 * of a table whose `path` alone is ~80 bytes a row. Every configuration read
 * in the cluster queued behind it: the orchestrator logged `configMs=6640` at
 * 23:26:11 while this statement ran 6 002 ms at 23:26:10. The same lesson was
 * already written on `idx_media_device_size` for `footprintByDevice`; the
 * per-location read was added later (D388) over the seal-gate index and paid
 * the cost that comment describes.
 *
 * ## Why the plan, and why from the real statement
 *
 * A fake store proves nothing about an index. `EXPLAIN QUERY PLAN` on the
 * SAME connection is the only thing that separates "covering" from "range plus
 * a table lookup per row" — and the statement must be the one the store
 * actually prepared, not one this spec spells out itself, or a change in the
 * store's SQL would leave the spec asserting a plan nobody runs. So
 * `better-sqlite3`'s `prepare` is observed and the captured SQL is explained.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '@camstack/system'
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

/** `MEDIA_COLLECTION` is already namespaced — it is the table name the plan prints. */
const SCOPED = MEDIA_COLLECTION

interface PreparedStatement {
  readonly sql: string
}

describe('media footprint by location over the real SQLite settings store', () => {
  let dir: string
  let backend: SqliteSettingsBackend
  let store: SettingsStoreClient
  let mediaStore: MediaStore
  let prepared: string[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'camstack-media-footprint-plan-'))
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

  function statementsFor(needle: string): readonly PreparedStatement[] {
    return prepared
      .filter((sql) => sql.includes('COUNT(*)') && sql.includes(needle))
      .map((sql) => ({ sql }))
  }

  it('answers the per-location aggregate from a covering index — no table row is fetched', async () => {
    const { byLocation, legacyNullBytes } = await mediaStore.footprintByLocation(['loc-a', 'loc-b'])

    // The numbers are right — that was never the defect.
    expect(byLocation.get('loc-a')).toBe(350)
    expect(byLocation.get('loc-b')).toBe(1_000)
    expect(legacyNullBytes).toBe(7)

    const perLocation = statementsFor('"locationId" = ?')
    expect(perLocation.length).toBeGreaterThan(0)
    for (const { sql } of perLocation) {
      const plan = backend.explainQueryPlan(sql, ['loc-a'])
      expect(plan.join(' | ')).toContain(
        `SEARCH ${SCOPED} USING COVERING INDEX idx_media_location_size`,
      )
    }
  })

  it('answers the legacy NULL-stamped aggregate from the same covering index', async () => {
    await mediaStore.footprintByLocation(['loc-a'])

    const legacy = statementsFor('"locationId" IS NULL')
    expect(legacy.length).toBe(1)
    const plan = backend.explainQueryPlan(legacy[0]!.sql, [])
    expect(plan.join(' | ')).toContain(
      `SEARCH ${SCOPED} USING COVERING INDEX idx_media_location_size`,
    )
  })
})
