/**
 * EXPLAIN on the statements the engine REALLY prepares (D447): the door's SQL
 * is spied on `prepare`, never re-spelled here. A hand-written statement can
 * use an index the engine's never does — that is how a plan test passes on a
 * query production does not run.
 *
 * Every history read is a PRIMARY KEY search on `(series_id, ts)` or
 * `(series_id, bucket_start)`; there is no `ts` index and none is needed. A
 * `SCAN` or a temp b-tree for the sort here would be the scheduled-aggregate
 * trap of D447 (a synchronous thread held for seconds).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type RealDoor, openRealDoor } from '../../__tests__/support/real-door.js'
import { HistoryStore } from '../history-store.js'

let rd: RealDoor
let store: HistoryStore
beforeEach(async () => {
  rd = await openRealDoor()
  store = new HistoryStore(rd.door)
  await store.declare()
  const series = await store.insertSeries({
    key: 'cap:battery.percentage',
    subject: 'd:1',
    deviceId: 1,
    scope: '',
    ts: 1_000,
  })
  await store.upsertRaw(
    Array.from({ length: 200 }, (_, i) => ({ seriesId: series.id, ts: 1_000 + i, value: i })),
  )
  const row = (bucketStart: number) => ({
    seriesId: series.id,
    bucketStart,
    samples: 1,
    sum: 1,
    min: 1,
    max: 1,
    last: 1,
    lastTs: bucketStart,
    twSum: null,
    twMs: null,
    states: null,
  })
  for (const tier of ['5m', '1h', '1d'] as const) {
    await store.upsertRollups(
      tier,
      Array.from({ length: 50 }, (_, i) => row(i * 1_000)),
    )
  }
})
afterEach(async () => {
  await rd.close()
})

/** The first statement of `kind` over `table` the engine prepared during `run`. */
async function statementOf(
  run: () => Promise<unknown>,
  table: string,
  kind: 'SELECT' | 'DELETE',
): Promise<string> {
  rd.prepared.length = 0
  rd.startSpying()
  await run()
  rd.stopSpying()
  const sql = rd.prepared.find((s) => s.trimStart().startsWith(kind) && s.includes(`"${table}"`))
  if (sql === undefined)
    throw new Error(`no ${kind} over ${table} was prepared: ${rd.prepared.join(' | ')}`)
  return sql
}

function planOf(sql: string): string {
  const db = rd.backend.getDatabase()
  if (db === null) throw new Error('database not open')
  const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 1)
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => (typeof r === 'object' && r !== null && 'detail' in r ? String(r.detail) : ''))
    .join('\n')
}

function expectPrimaryKeyRange(plan: string, ...columns: string[]): void {
  expect(plan).toMatch(/SEARCH .* USING (COVERING )?(INTEGER )?PRIMARY KEY/)
  for (const c of columns) expect(plan).toContain(c)
  expect(plan).not.toMatch(/\bSCAN\b/)
  expect(plan).not.toContain('TEMP B-TREE')
}

describe('every history statement is a primary-key range', () => {
  it('raw range read', async () => {
    const sql = await statementOf(
      () => store.readRaw(1, 1_000, 1_100, 100),
      'device-history:raw',
      'SELECT',
    )
    expectPrimaryKeyRange(planOf(sql), 'series_id=?', 'ts>?')
  })

  it('raw "newest before" read (descending, limit 1) needs no sort', async () => {
    const sql = await statementOf(() => store.rawBefore(1, 1_100), 'device-history:raw', 'SELECT')
    expect(sql).toMatch(/ORDER BY/i)
    expectPrimaryKeyRange(planOf(sql), 'series_id=?')
  })

  for (const tier of ['5m', '1h', '1d'] as const) {
    it(`${tier} rollup range read and "before" read`, async () => {
      const table = `device-history:rollup-${tier}`
      const range = await statementOf(
        () => store.readRollups(tier, 1, 0, 10_000, 100),
        table,
        'SELECT',
      )
      expectPrimaryKeyRange(planOf(range), 'series_id=?', 'bucket_start>?')
      const before = await statementOf(() => store.rollupBefore(tier, 1, 5_000), table, 'SELECT')
      expectPrimaryKeyRange(planOf(before), 'series_id=?')
    })
  }

  it('retention delete on raw and on a rollup', async () => {
    const raw = await statementOf(
      () => store.deleteRange('raw', 1, 0, 500),
      'device-history:raw',
      'DELETE',
    )
    expectPrimaryKeyRange(planOf(raw), 'series_id=?', 'ts>?')
    const five = await statementOf(
      () => store.deleteRange('5m', 1, 0, 500),
      'device-history:rollup-5m',
      'DELETE',
    )
    expectPrimaryKeyRange(planOf(five), 'series_id=?', 'bucket_start>?')
  })

  // The orphan listing (D917) counts one series' rows per tier: a range of the
  // primary key, never a scan of the tier.
  for (const tier of ['raw', '5m', '1h', '1d'] as const) {
    it(`per-series row count on ${tier}`, async () => {
      const table = tier === 'raw' ? 'device-history:raw' : `device-history:rollup-${tier}`
      const sql = await statementOf(() => store.countSeriesRows(tier, 1), table, 'SELECT')
      expect(sql).toMatch(/COUNT/i)
      expectPrimaryKeyRange(planOf(sql), 'series_id=?')
    })
  }

  it('series identity lookup uses the unique identity index', async () => {
    const sql = await statementOf(
      () => store.findSeries('cap:battery.percentage', 'd:1', ''),
      'device-history:series',
      'SELECT',
    )
    const plan = planOf(sql)
    expect(plan).toContain('idx_dh_series_identity')
    expect(plan).toMatch(/key=\? AND subject=\? AND scope=\?/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })

  it('the boot load pages the series table by its rowid key', async () => {
    const sql = await statementOf(
      () => store.loadSeriesPage(0, 100),
      'device-history:series',
      'SELECT',
    )
    const plan = planOf(sql)
    expect(plan).toMatch(/SEARCH .* USING INTEGER PRIMARY KEY/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})
