/**
 * The DDL the real engine produces for the device-history declarations equals
 * the data model of plan §4 — compared as normalised SQL from `sqlite_master`,
 * not as a list of column names, so a changed type, a lost NOT NULL, a missing
 * WITHOUT ROWID or a different key order is red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type RealDoor, openRealDoor } from '../../__tests__/support/real-door.js'
import { HistoryStore } from '../history-store.js'
import { HISTORY_DECLARATIONS, HISTORY_NAMESPACE } from '../history-schema.js'

let rd: RealDoor
describe('a history.db written before the enum columns existed', () => {
  it('gains them IN PLACE: every metric and rollup row survives the new declaration', async () => {
    const old = await openRealDoor()
    try {
      const NEW_COLUMNS = new Set(['enum_values', 'state_ms'])
      for (const d of HISTORY_DECLARATIONS) {
        await old.door.declareCollection.mutate({
          ...d,
          columns: d.columns.filter((c) => !NEW_COLUMNS.has(c.name)),
        })
      }
      await old.door.upsertMany.mutate({
        namespace: HISTORY_NAMESPACE,
        collection: 'metrics',
        conflict: ['key'],
        records: [
          {
            data: {
              key: 'cap:battery.percentage',
              source: 'cap',
              owner_addon: 'device-history',
              subject_kind: 'device',
              kind: 'gauge',
              unit: '%',
              display_name: 'MARKED',
              ingest: 'points',
              declared_at: 1,
            },
          },
        ],
      })
      await old.door.upsertMany.mutate({
        namespace: HISTORY_NAMESPACE,
        collection: 'rollup-1h',
        conflict: ['series_id', 'bucket_start'],
        records: [
          {
            data: {
              series_id: 7,
              bucket_start: 3_600_000,
              samples: 3,
              sum: 42,
              min: 1,
              max: 20,
              last: 20,
              last_ts: 3_600_001,
              tw_sum: null,
              tw_ms: null,
            },
          },
        ],
      })
      const store = new HistoryStore(old.door)
      await store.declare()
      const [metric] = await store.loadMetrics()
      expect(metric).toMatchObject({ displayName: 'MARKED', values: null })
      const rows = await store.readRollups('1h', 7, 0, Number.MAX_SAFE_INTEGER, 10)
      expect(rows).toEqual([expect.objectContaining({ sum: 42, last: 20, states: null })])
    } finally {
      await old.close()
    }
  })
})

beforeEach(async () => {
  rd = await openRealDoor()
  await new HistoryStore(rd.door).declare()
})
afterEach(async () => {
  await rd.close()
})

/** Plan §4, verbatim apart from the comments. */
const PLAN_DDL: Record<string, string> = {
  'device-history:metrics': `CREATE TABLE "device-history:metrics" (
    key           TEXT PRIMARY KEY NOT NULL,
    source        TEXT NOT NULL,
    owner_addon   TEXT NOT NULL,
    subject_kind  TEXT NOT NULL,
    kind          TEXT NOT NULL,
    unit          TEXT,
    display_name  TEXT NOT NULL,
    ingest        TEXT NOT NULL,
    declared_at   INTEGER NOT NULL,
    enum_values   TEXT
  )`,
  'device-history:series': `CREATE TABLE "device-history:series" (
    id            INTEGER PRIMARY KEY,
    key           TEXT NOT NULL,
    subject       TEXT NOT NULL,
    device_id     INTEGER,
    scope         TEXT NOT NULL DEFAULT '',
    first_ts      INTEGER NOT NULL,
    last_ts       INTEGER NOT NULL
  )`,
  idx_dh_series_identity: `CREATE UNIQUE INDEX idx_dh_series_identity ON "device-history:series"(key, subject, scope)`,
  idx_dh_series_device: `CREATE INDEX idx_dh_series_device ON "device-history:series"(device_id)`,
  'device-history:raw': `CREATE TABLE "device-history:raw" (
    series_id INTEGER NOT NULL,
    ts        INTEGER NOT NULL,
    value     REAL NOT NULL,
    PRIMARY KEY (series_id, ts)
  ) WITHOUT ROWID`,
  // Plan §4 has `device_id INTEGER PRIMARY KEY`; the engine assigns an INTEGER key itself
  // (D473), so the device id is a unique column beside an engine-assigned id. Recorded in D850.
  'device-history:device-opt-outs': `CREATE TABLE "device-history:device-opt-outs" (
    id            INTEGER PRIMARY KEY,
    device_id     INTEGER NOT NULL,
    opted_out_at  INTEGER NOT NULL
  )`,
  idx_dh_opt_outs_device: `CREATE UNIQUE INDEX idx_dh_opt_outs_device ON "device-history:device-opt-outs"(device_id)`,
  // Since when a device has been absent from every successful listing (retention purge clock).
  'device-history:device-departures': `CREATE TABLE "device-history:device-departures" (
    id             INTEGER PRIMARY KEY,
    device_id      INTEGER NOT NULL,
    missing_since  INTEGER NOT NULL
  )`,
  idx_dh_departures_device: `CREATE UNIQUE INDEX idx_dh_departures_device ON "device-history:device-departures"(device_id)`,
}
for (const tier of ['5m', '1h', '1d']) {
  PLAN_DDL[`device-history:rollup-${tier}`] = `CREATE TABLE "device-history:rollup-${tier}" (
    series_id    INTEGER NOT NULL,
    bucket_start INTEGER NOT NULL,
    samples      INTEGER NOT NULL,
    sum          REAL NOT NULL,
    min          REAL NOT NULL,
    max          REAL NOT NULL,
    last         REAL,
    last_ts      INTEGER,
    tw_sum       REAL,
    tw_ms        INTEGER,
    state_ms     TEXT,
    PRIMARY KEY (series_id, bucket_start)
  ) WITHOUT ROWID`
}

function normalise(sql: string): string {
  return sql
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
    .toUpperCase()
}

describe('history.db DDL', () => {
  it('equals the data model of plan §4 for every table and index', () => {
    const db = rd.backend.getDatabase()
    const rows = db
      ?.prepare(
        "SELECT name, sql FROM sqlite_master WHERE (name LIKE 'device-history:%' OR name LIKE 'idx_dh_%') AND sql IS NOT NULL",
      )
      .all()
    const actual = new Map<string, string>()
    for (const r of rows ?? []) {
      if (typeof r === 'object' && r !== null && 'name' in r && 'sql' in r) {
        actual.set(String(r.name), String(r.sql))
      }
    }
    expect([...actual.keys()].sort()).toEqual(Object.keys(PLAN_DDL).sort())
    for (const [name, expected] of Object.entries(PLAN_DDL)) {
      expect(normalise(actual.get(name) ?? ''), name).toBe(normalise(expected))
    }
  })

  it('declaring twice changes nothing (idempotent boot)', async () => {
    const db = rd.backend.getDatabase()
    const before = db?.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()
    await new HistoryStore(rd.door).declare()
    expect(db?.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(before)
  })
})
