/**
 * `transact` against a REAL SQLite file.
 *
 * What a fake cannot prove: that the guard and every op share ONE transaction,
 * that a failing op rolls back the ops before it, and that a failed guard
 * writes nothing. These are what make the retrain annotation save atomic.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const FRAMES = 'test:frames'
const ROWS = 'test:rows'

let dir: string
let backend: SqliteSettingsBackend

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'camstack-transact-'))
  backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
  await backend.initialize()
  await backend.declareCollection({
    collection: FRAMES,
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
      { name: 'revision', type: 'INTEGER', notNull: true, defaultValue: 0 },
      { name: 'dismissed', type: 'JSON' },
    ],
  })
  await backend.declareCollection({
    collection: ROWS,
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
      { name: 'frame', type: 'TEXT', notNull: true },
      { name: 'n', type: 'INTEGER', notNull: true },
    ],
  })
  await backend.set({ collection: FRAMES, key: 'f1', value: {} })
  await backend.insertMany({
    collection: ROWS,
    records: [
      { id: 'old1', data: { frame: 'f1', n: 1 } },
      { id: 'old2', data: { frame: 'f1', n: 2 } },
    ],
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function frameRows(): Promise<readonly string[]> {
  const rows = await backend.query({ collection: ROWS, filter: { where: { frame: 'f1' } } })
  return rows.map((r) => r.id).toSorted()
}

describe('transact over real SQLite', () => {
  it('applies every op when the guard holds (a column default reads back as 0)', async () => {
    const result = await backend.transact({
      guard: { collection: FRAMES, key: 'f1', column: 'revision', equals: 0 },
      ops: [
        { op: 'deleteWhere', collection: ROWS, filter: { where: { frame: 'f1' } } },
        {
          op: 'insertMany',
          collection: ROWS,
          records: [{ id: 'new1', data: { frame: 'f1', n: 9 } }],
        },
        {
          op: 'update',
          collection: FRAMES,
          id: 'f1',
          data: { revision: 1, dismissed: [{ ref: 'a' }] },
        },
      ],
    })
    expect(result).toEqual({ applied: true })
    expect(await frameRows()).toEqual(['new1'])
    const frame = await backend.get({ collection: FRAMES, key: 'f1' })
    expect(frame).toMatchObject({ revision: 1, dismissed: [{ ref: 'a' }] })
  })

  it('a stale guard writes NOTHING and reports what it found', async () => {
    await backend.update({ collection: FRAMES, id: 'f1', data: { revision: 4 } })
    const result = await backend.transact({
      guard: { collection: FRAMES, key: 'f1', column: 'revision', equals: 3 },
      ops: [
        { op: 'deleteWhere', collection: ROWS, filter: { where: { frame: 'f1' } } },
        { op: 'update', collection: FRAMES, id: 'f1', data: { revision: 99 } },
      ],
    })
    expect(result).toEqual({ applied: false, current: 4 })
    expect(await frameRows()).toEqual(['old1', 'old2'])
    expect(await backend.get({ collection: FRAMES, key: 'f1' })).toMatchObject({ revision: 4 })
  })

  it('a missing guard row is not applied', async () => {
    const result = await backend.transact({
      guard: { collection: FRAMES, key: 'nope', column: 'revision', equals: 0 },
      ops: [{ op: 'deleteWhere', collection: ROWS, filter: { where: { frame: 'f1' } } }],
    })
    expect(result.applied).toBe(false)
    expect(await frameRows()).toEqual(['old1', 'old2'])
  })

  it('a failing op rolls the earlier ops back — the delete does not survive', async () => {
    await expect(
      backend.transact({
        ops: [
          { op: 'deleteWhere', collection: ROWS, filter: { where: { frame: 'f1' } } },
          // 'old1' is deleted above, so this id is free; the second record
          // collides with the first (duplicate primary key) and aborts the call.
          {
            op: 'insertMany',
            collection: ROWS,
            records: [
              { id: 'dup', data: { frame: 'f1', n: 1 } },
              { id: 'dup', data: { frame: 'f1', n: 2 } },
            ],
          },
        ],
      }),
    ).rejects.toThrow()
    expect(await frameRows()).toEqual(['old1', 'old2'])
  })

  it('refuses a guard column that is not a column of the collection', async () => {
    await expect(
      backend.transact({
        guard: { collection: FRAMES, key: 'f1', column: 'revision" OR 1=1 --', equals: 0 },
        ops: [],
      }),
    ).rejects.toThrow(/not a column/)
  })
})
