/**
 * `accountingForLocations` is served from a COVERING index — proved on the
 * real engine, from the statement the ledger really prepares.
 *
 * ## What happened
 *
 * Same evening, same thread, the other half of the same stall
 * (`media-footprint-plan-over-real-sqlite.spec.ts` names the first): the
 * profiler's slow-call WARN fired ONCE A MINUTE from 22:50 on 2026-09-10 on
 *
 *     op=aggregate collection=recorder:segment-hours
 *     shape="SELECT … FROM <t> WHERE \"locationId\" IN (?×1)"
 *     durationMs=1001…2902 rows=1
 *     plan=["SEARCH recorder:segment-hours USING INDEX idx_recorder_segment_hours_loc_hour (locationId=?)"]
 *
 * 174 lines in ten hours against the media aggregate's 109. The table is only
 * ~19 k hour rows, but each row carries `paths` — up to 360 segment paths of
 * ~80 characters — so the SUM/MIN/MAX that the eviction index locates has to
 * fetch ~30 KB of table row per hour to read four integers out of it. One
 * pass is hundreds of megabytes of page reads for a 1-row answer, on the thread
 * every configuration read in the cluster waits on. The index the plan names
 * was built for the eviction READ (oldest-first stream, `hourStartMs` supplies
 * the order); the accounting read borrowed it and paid a table lookup per row.
 *
 * ## Why the plan, and why from the real statement
 *
 * A `Map` cannot fail this. `EXPLAIN QUERY PLAN` on the same connection, over
 * the SQL `better-sqlite3` was asked to prepare, is the only assertion that
 * says "no table row was read" and survives a change in how the ledger
 * spells its statement.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '@camstack/system'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECORDING_SEGMENT_HOURS_COLLECTION, SegmentHourLedger } from '../segment-hour-ledger.js'

/** Same documented test boundary as the analytics `*-over-real-sqlite` specs. */
function clientOver(backend: SqliteSettingsBackend): SettingsStoreClient {
  return {
    declareCollection: { mutate: (i: never) => backend.declareCollection(i) },
    insertMany: { mutate: (i: never) => backend.insertMany(i) },
    aggregate: { query: (i: never) => backend.aggregate(i) },
    query: { query: (i: never) => backend.query(i) },
    count: { query: (i: never) => backend.count(i) },
  } as unknown as SettingsStoreClient
}

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const HOUR_MS = 3_600_000

describe('segment-hour accounting over the real SQLite settings store', () => {
  let dir: string
  let backend: SqliteSettingsBackend
  let ledger: SegmentHourLedger
  let prepared: string[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'camstack-segment-hours-plan-'))
    backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
    await backend.initialize()
    ledger = new SegmentHourLedger({ store: clientOver(backend), logger: silentLogger() })
    await ledger.declare()
    await backend.insertMany({
      collection: RECORDING_SEGMENT_HOURS_COLLECTION,
      records: [
        hourRow('loc-a', 0, 1_000, 3),
        hourRow('loc-a', HOUR_MS, 2_000, 5),
        hourRow('loc-b', 0, 10_000, 1),
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

  function hourRow(
    locationId: string,
    hour: number,
    bytes: number,
    segments: number,
  ): { data: Record<string, unknown> } {
    return {
      data: {
        key: `104|low|${locationId}|${hour}`,
        deviceId: 104,
        profile: 'low',
        locationId,
        hourStartMs: hour,
        paths: JSON.stringify(['104/low/x.m4s']),
        bytes,
        segments,
        minStartMs: hour + 1,
        maxStartMs: hour + 2,
        sealed: 0,
      },
    }
  }

  it('answers the domain total from a covering index — no hour row (and its paths) is fetched', async () => {
    const accounting = await ledger.accountingForLocations(new Set(['loc-a']))

    expect(accounting).toEqual({ bytes: 3_000, count: 8, oldestMs: 1, newestMs: HOUR_MS + 2 })

    const statements = prepared.filter(
      (sql) => sql.includes('COUNT(*)') && sql.includes('"locationId" IN ('),
    )
    expect(statements.length).toBe(1)
    const plan = backend.explainQueryPlan(statements[0]!, ['loc-a'])
    expect(plan.join(' | ')).toContain(
      `SEARCH ${RECORDING_SEGMENT_HOURS_COLLECTION} USING COVERING INDEX idx_recorder_segment_hours_loc_accounting`,
    )
  })
})
