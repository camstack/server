/**
 * `aggregate` — COUNT/SUM/MIN/MAX in one statement.
 *
 * The reason it exists is a caller that was answering "how much is on this
 * disk" by materialising "what is on this disk" — 7.1 M rows visited twice a
 * minute for four numbers. So the properties under test are the ones that make
 * it safe to REPLACE a scan with a sum: the same rows as `query` (one filter
 * compiler), a refusal rather than a silent omission for a column that cannot
 * be served, and `null` rather than 0 for an empty set.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

describe('SqliteSettingsBackend.aggregate', () => {
  let backend: SqliteSettingsBackend

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()
    await backend.declareCollection({
      collection: 'hours',
      columns: [
        { name: 'key', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'locationId', type: 'TEXT', notNull: true },
        { name: 'bytes', type: 'INTEGER', notNull: true },
        { name: 'startMs', type: 'INTEGER', notNull: true },
      ],
    })
    const rows = [
      { key: 'a', locationId: 'recordings', bytes: 100, startMs: 1_000 },
      { key: 'b', locationId: 'recordings', bytes: 250, startMs: 5_000 },
      { key: 'c', locationId: 'recordingsLow', bytes: 40, startMs: 3_000 },
      { key: 'd', locationId: 'elsewhere', bytes: 9_999, startMs: 9_999 },
    ]
    for (const r of rows) {
      await backend.insert({ collection: 'hours', record: { id: r.key, data: r } })
    }
  })

  afterEach(async () => {
    await backend.shutdown()
  })

  it('sums, mins and maxes the rows a whereIn selects — the same rows query would return', async () => {
    const out = await backend.aggregate({
      collection: 'hours',
      fields: [
        { as: 'bytes', field: 'bytes', op: 'sum' },
        { as: 'oldestMs', field: 'startMs', op: 'min' },
        { as: 'newestMs', field: 'startMs', op: 'max' },
      ],
      filter: { whereIn: { locationId: ['recordings', 'recordingsLow'] } },
    })
    expect(out).toEqual({
      count: 3,
      values: { bytes: 390, oldestMs: 1_000, newestMs: 5_000 },
    })

    const rows = await backend.query({
      collection: 'hours',
      filter: { whereIn: { locationId: ['recordings', 'recordingsLow'] } },
    })
    expect(rows).toHaveLength(out.count)
  })

  it('asks the same column twice with two operations in one round trip', async () => {
    const out = await backend.aggregate({
      collection: 'hours',
      fields: [
        { as: 'lo', field: 'startMs', op: 'min' },
        { as: 'hi', field: 'startMs', op: 'max' },
      ],
    })
    expect(out.values).toEqual({ lo: 1_000, hi: 9_999 })
  })

  it('an empty match is null per field, never 0 — "nothing here" is not "zero bytes"', async () => {
    const out = await backend.aggregate({
      collection: 'hours',
      fields: [{ as: 'bytes', field: 'bytes', op: 'sum' }],
      filter: { where: { locationId: 'nowhere' } },
    })
    expect(out).toEqual({ count: 0, values: { bytes: null } })
  })

  it('REFUSES a column the collection cannot express, rather than omitting it', async () => {
    // A dropped predicate over-matches and the caller sees extra rows. A
    // dropped aggregate hands back a number that looks exactly like a real one.
    await expect(
      backend.aggregate({
        collection: 'hours',
        fields: [{ as: 'x', field: 'notAColumn', op: 'sum' }],
      }),
    ).rejects.toThrow(/notAColumn/)
  })

  it('the result key is the caller’s `as`, and never reaches SQL as an identifier', async () => {
    const out = await backend.aggregate({
      collection: 'hours',
      fields: [{ as: 'total"; DROP TABLE hours; --', field: 'bytes', op: 'sum' }],
    })
    expect(out.values['total"; DROP TABLE hours; --']).toBe(10_389)
    // The table is still there.
    expect(await backend.count({ collection: 'hours' })).toBe(4)
  })
})
