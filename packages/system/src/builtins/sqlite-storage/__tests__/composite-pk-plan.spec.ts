/**
 * Composite primary keys (D851) — the DDL the engine emits, the refusal of
 * id-addressed calls, and the plan of the statement the engine REALLY prepares
 * (D447: spy on `prepare`, never a hand-spelled SQL).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompositeKeyError } from '../placement-errors.js'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const RAW = 'cpk:raw'

let dir: string
let backend: SqliteSettingsBackend

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'camstack-composite-pk-'))
  backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
  await backend.initialize()
  await backend.declareCollection({
    collection: RAW,
    primaryKey: ['seriesId', 'ts'],
    withoutRowid: true,
    columns: [
      { name: 'seriesId', type: 'INTEGER' },
      { name: 'ts', type: 'INTEGER' },
      { name: 'value', type: 'REAL' },
    ],
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tableSql(name: string): string {
  const db = backend.getDatabase()
  const row = db
    ?.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)
  return typeof row === 'object' && row !== null && 'sql' in row ? String(row.sql) : ''
}

describe('composite primary keys', () => {
  it('emits a table constraint and WITHOUT ROWID, with the key columns NOT NULL', () => {
    const sql = tableSql(RAW)
    expect(sql).toContain('PRIMARY KEY ("seriesId", "ts")')
    expect(sql).toContain('WITHOUT ROWID')
    expect(sql).toMatch(/"seriesId" INTEGER NOT NULL/)
    expect(sql).toMatch(/"ts" INTEGER NOT NULL/)
    // No synthetic id column sneaks in beside a declared key.
    expect(sql).not.toMatch(/"id"/)
  })

  it('a range over (seriesId, ts) is a PRIMARY KEY search in the statement the engine prepares', async () => {
    await backend.insertMany({
      collection: RAW,
      records: Array.from({ length: 50 }, (_, i) => ({
        data: { seriesId: i % 5, ts: 1_000 + i, value: i },
      })),
    })
    const db = backend.getDatabase()
    if (db === null) throw new Error('database not open')
    const prepared: string[] = []
    const real = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      prepared.push(sql)
      return real(sql)
    })
    const rows = await backend.query({
      collection: RAW,
      filter: { where: { seriesId: 3 }, whereBetween: { ts: [1_000, 1_049] } },
    })
    spy.mockRestore()
    expect(rows.length).toBe(10)

    const select = prepared.find((sql) => sql.startsWith('SELECT') && sql.includes(RAW))
    expect(select).toBeDefined()
    if (select === undefined) return
    const plan = backend.explainQueryPlan(select, [3, 1_000, 1_049, 10_001]).join(' | ')
    expect(plan).toMatch(/SEARCH .*USING PRIMARY KEY \(seriesId=\? AND ts>\? AND ts<\?\)/)
    expect(plan).not.toMatch(/SCAN/)
  })

  it('refuses the calls that address one row by id, naming the key', async () => {
    await expect(backend.get({ collection: RAW, key: '1' })).rejects.toBeInstanceOf(
      CompositeKeyError,
    )
    await expect(backend.set({ collection: RAW, key: '1', value: {} })).rejects.toBeInstanceOf(
      CompositeKeyError,
    )
    await expect(backend.delete({ collection: RAW, key: '1' })).rejects.toThrow(
      /composite key \(seriesId, ts\)/,
    )
    await expect(
      backend.insert({ collection: RAW, record: { data: { seriesId: 1, ts: 1, value: 1 } } }),
    ).rejects.toBeInstanceOf(CompositeKeyError)
    await expect(
      backend.update({ collection: RAW, id: '1', data: { value: 2 } }),
    ).rejects.toBeInstanceOf(CompositeKeyError)
  })

  it('a duplicate key is a constraint error, not a silent overwrite', async () => {
    await backend.insertMany({
      collection: RAW,
      records: [{ data: { seriesId: 1, ts: 1, value: 1 } }],
    })
    await expect(
      backend.insertMany({
        collection: RAW,
        records: [{ data: { seriesId: 1, ts: 1, value: 2 } }],
      }),
    ).rejects.toThrow(/UNIQUE|constraint/i)
  })

  it('reads a composite row back with every column and a key-shaped id', async () => {
    await backend.insertMany({
      collection: RAW,
      records: [{ data: { seriesId: 7, ts: 42, value: 0.5 } }],
    })
    const [row] = await backend.query({ collection: RAW })
    expect(row?.data).toEqual({ seriesId: 7, ts: 42, value: 0.5 })
    expect(row?.id).toBe('[7,42]')
  })

  it('survives a respawn: the declaration is persisted with its key', async () => {
    await backend.insertMany({
      collection: RAW,
      records: [{ data: { seriesId: 1, ts: 1, value: 1 } }],
    })
    await backend.shutdown()
    backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
    await backend.initialize()
    // No re-declare: the restored declaration still refuses an id-addressed call.
    await expect(backend.get({ collection: RAW, key: '1' })).rejects.toBeInstanceOf(
      CompositeKeyError,
    )
    expect(await backend.count({ collection: RAW })).toBe(1)
  })

  it('primaryKey with ONE name is the single-column key it always was', async () => {
    await backend.declareCollection({
      collection: 'cpk:single',
      primaryKey: ['code'],
      columns: [
        { name: 'code', type: 'TEXT' },
        { name: 'n', type: 'INTEGER' },
      ],
    })
    await backend.set({ collection: 'cpk:single', key: 'a', value: { n: 1 } })
    expect(await backend.get({ collection: 'cpk:single', key: 'a' })).toEqual({ n: 1 })
    const [row] = await backend.query({ collection: 'cpk:single' })
    expect(row?.id).toBe('a')
    expect(tableSql('cpk:single')).toContain('"code" TEXT PRIMARY KEY')
  })

  it('refuses withoutRowid with no key, and a key naming a missing column', async () => {
    await expect(
      backend.declareCollection({
        collection: 'cpk:nokey',
        withoutRowid: true,
        columns: [{ name: 'a', type: 'INTEGER' }],
      }),
    ).rejects.toThrow(/withoutRowid needs a primary key/)
    await expect(
      backend.declareCollection({
        collection: 'cpk:ghost',
        primaryKey: ['a', 'ghost'],
        columns: [{ name: 'a', type: 'INTEGER' }],
      }),
    ).rejects.toThrow(/does not declare: ghost/)
  })
})
