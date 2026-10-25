/**
 * PLACEMENT of device-history's tables through the REAL D851 router: the
 * history tables live ONLY in `history.db` (a real worker thread), the opt-out
 * switch lives in `camstack.db`, and the store works end to end across the two.
 *
 * Checked the only way the router's own map cannot fool: stop everything, then
 * open the files with a plain driver and ask `sqlite_master`. Heavy (worker
 * threads through tsx) — run with `CAMSTACK_HEAVY_SPECS=1`.
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
// eslint-disable-next-line no-restricted-imports -- test-only: the REAL placement router and its
// harness, taken from source (the same choice the other addons' over-real-sqlite specs make).
import {
  type Harness,
  makeHarness,
} from '../../../sqlite-storage/__tests__/support/owned-files-harness.js'
import type { HistoryDoor } from '../history-door.js'
import { HISTORY_DECLARATIONS } from '../history-schema.js'
import { HistoryStore } from '../history-store.js'

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

function tablesOf(file: string): readonly string[] {
  const db = new Database(file, { readonly: true })
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (typeof r === 'object' && r !== null && 'name' in r ? String(r.name) : ''))
  } finally {
    db.close()
  }
}

describe('device-history placement over the real router', () => {
  it('puts the history tables in history.db and the opt-out switch in camstack.db', async () => {
    harness = makeHarness()
    const router = await harness.router()
    const door = {
      declareCollection: { mutate: (i: never) => router.declareCollection(i) },
      query: { query: (i: never) => router.query(i) },
      insert: { mutate: (i: never) => router.insert(i) },
      upsertMany: { mutate: (i: never) => router.upsertMany(i) },
      transact: { mutate: (i: never) => router.transact(i) },
      deleteWhere: { mutate: (i: never) => router.deleteWhere(i) },
      update: { mutate: (i: never) => router.update(i) },
      count: { query: (i: never) => router.count(i) },
      delete: { mutate: (i: never) => router.delete(i) },
    } as unknown as HistoryDoor
    const store = new HistoryStore(door)
    await store.declare()

    const series = await store.insertSeries({
      key: 'cap:battery.percentage',
      subject: 'd:1',
      deviceId: 1,
      scope: '',
      ts: 1_000,
    })
    await store.upsertRaw([{ seriesId: series.id, ts: 1_000, value: 80 }])
    await store.setOptOut(7, 5_000)
    expect(await store.readRaw(series.id, 0, 10_000, 10)).toEqual([{ ts: 1_000, value: 80 }])
    expect([...(await store.loadOptOuts())]).toEqual([7])
    for (const d of HISTORY_DECLARATIONS) {
      const table = `${d.namespace}:${d.collection}`
      expect(router.databaseOf(table)).toBe(d.database ?? 'settings')
    }
    await harness.stopAll(router)

    const inHistory = tablesOf(harness.pathOf('history'))
    const inSettings = tablesOf(harness.pathOf('settings'))
    for (const name of ['metrics', 'series', 'raw', 'rollup-5m', 'rollup-1h', 'rollup-1d']) {
      expect(inHistory).toContain(`device-history:${name}`)
      expect(inSettings).not.toContain(`device-history:${name}`)
    }
    expect(inSettings).toContain('device-history:device-opt-outs')
    expect(inHistory).not.toContain('device-history:device-opt-outs')
  })
})
