/**
 * `upsertMany` against a REAL SQLite file (D851, D44: a missing capability is
 * fixed on the door). One transaction, one prepared statement; idempotent on
 * its conflict target; a heterogeneous batch is refused whole.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const ROLLUP = 'um:rollup-5m'

let dir: string
let backend: SqliteSettingsBackend

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'camstack-upsert-many-'))
  backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
  await backend.initialize()
  await backend.declareCollection({
    collection: ROLLUP,
    primaryKey: ['seriesId', 'bucketStart'],
    withoutRowid: true,
    columns: [
      { name: 'seriesId', type: 'INTEGER' },
      { name: 'bucketStart', type: 'INTEGER' },
      { name: 'samples', type: 'INTEGER' },
      { name: 'sum', type: 'REAL' },
      { name: 'last', type: 'REAL' },
    ],
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const bucket = (seriesId: number, bucketStart: number, samples: number, sum: number) => ({
  data: { seriesId, bucketStart, samples, sum, last: sum / samples },
})

describe('upsertMany over real SQLite', () => {
  it('writing the same buckets twice leaves one row each, with the later values', async () => {
    const conflict = ['seriesId', 'bucketStart']
    await backend.upsertMany({
      collection: ROLLUP,
      conflict,
      records: [bucket(1, 0, 2, 10), bucket(1, 300_000, 4, 40)],
    })
    const second = await backend.upsertMany({
      collection: ROLLUP,
      conflict,
      records: [bucket(1, 0, 3, 30), bucket(2, 0, 1, 5)],
    })
    expect(second).toEqual({ upserted: 2 })

    const rows = await backend.query({
      collection: ROLLUP,
      filter: { orderBy: { field: 'bucketStart', direction: 'asc' } },
    })
    expect(rows).toHaveLength(3)
    const first = rows.find((r) => r.data['seriesId'] === 1 && r.data['bucketStart'] === 0)
    expect(first?.data['samples']).toBe(3)
    expect(first?.data['sum']).toBe(30)
  })

  it('is all-or-nothing: a bad record takes the whole batch back', async () => {
    await expect(
      backend.upsertMany({
        collection: ROLLUP,
        conflict: ['seriesId', 'bucketStart'],
        records: [
          bucket(1, 0, 1, 1),
          { data: { seriesId: 1, bucketStart: 300_000, samples: null, sum: null } },
        ],
      }),
    ).rejects.toThrow()
    expect(await backend.count({ collection: ROLLUP })).toBe(0)
  })

  it('refuses a batch whose records name different columns — nothing is erased by omission', async () => {
    await backend.upsertMany({
      collection: ROLLUP,
      conflict: ['seriesId', 'bucketStart'],
      records: [bucket(1, 0, 5, 50)],
    })
    await expect(
      backend.upsertMany({
        collection: ROLLUP,
        conflict: ['seriesId', 'bucketStart'],
        records: [bucket(1, 0, 6, 60), { data: { seriesId: 1, bucketStart: 300_000, samples: 1 } }],
      }),
    ).rejects.toThrow(/different columns/)
    const [row] = await backend.query({ collection: ROLLUP })
    expect(row?.data['samples']).toBe(5)
  })

  it('refuses an empty conflict target and an undeclared conflict column', async () => {
    await expect(
      backend.upsertMany({ collection: ROLLUP, conflict: [], records: [bucket(1, 0, 1, 1)] }),
    ).rejects.toThrow(/EMPTY conflict target/)
    await expect(
      backend.upsertMany({
        collection: ROLLUP,
        conflict: ['ghost'],
        records: [bucket(1, 0, 1, 1)],
      }),
    ).rejects.toThrow(/does not declare: ghost/)
  })

  it('works as a transact op, atomically with the other ops', async () => {
    const result = await backend.transact({
      ops: [
        {
          op: 'upsertMany',
          collection: ROLLUP,
          conflict: ['seriesId', 'bucketStart'],
          records: [bucket(1, 0, 2, 20)],
        },
        { op: 'deleteWhere', collection: ROLLUP, filter: { where: { seriesId: 99 } } },
      ],
    })
    expect(result.applied).toBe(true)
    expect(await backend.count({ collection: ROLLUP })).toBe(1)
  })

  it('upserts a keyed (single primary key) collection by its conflict column', async () => {
    await backend.declareCollection({
      collection: 'um:keyed',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true },
        { name: 'slot', type: 'TEXT', unique: true },
        { name: 'n', type: 'INTEGER' },
      ],
    })
    await backend.upsertMany({
      collection: 'um:keyed',
      conflict: ['slot'],
      records: [{ id: 'a', data: { slot: 's1', n: 1 } }],
    })
    await backend.upsertMany({
      collection: 'um:keyed',
      conflict: ['slot'],
      records: [{ id: 'b', data: { slot: 's1', n: 2 } }],
    })
    const rows = await backend.query({ collection: 'um:keyed' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data['n']).toBe(2)
  })
})
