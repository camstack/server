/**
 * `whereNotIn` — NULL-safe exclusion of a SET, over real SQLite.
 *
 * `whereNot` is a `Record` keyed by field, so one field can name exactly one
 * excluded value. Excluding two members of a small enum was therefore
 * inexpressible, and the case that produced this operator is `Track.source`:
 * the viewer hides the synthetic `audio` projection by default and the
 * operator may hide `sensor` too. Dropping those rows in the caller instead
 * would make paging lie about how much is left.
 *
 * Every fixture holds BOTH null and non-null rows in the filtered column. A
 * table where every row carries a value passes against a compilation that
 * drops NULLs — which is the bug `whereNot` exists to avoid, and the one this
 * operator must not reintroduce.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

/** 3 rows with no `source` (the pipeline population), 2 audio, 2 sensor. */
const TRACK_ROWS = [
  { id: 't1', data: { lastSeen: 1, source: null } },
  { id: 't2', data: { lastSeen: 2, source: 'audio' } },
  { id: 't3', data: { lastSeen: 3, source: null } },
  { id: 't4', data: { lastSeen: 4, source: 'sensor' } },
  { id: 't5', data: { lastSeen: 5, source: 'audio' } },
  { id: 't6', data: { lastSeen: 6, source: 'sensor' } },
  { id: 't7', data: { lastSeen: 7, source: null } },
] as const

describe('whereNotIn over a structured collection', () => {
  let backend: SqliteSettingsBackend

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()
    await backend.declareCollection({
      collection: 'tracks',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'lastSeen', type: 'INTEGER', notNull: true },
        { name: 'source', type: 'TEXT' },
      ],
    })
    await backend.insertMany({ collection: 'tracks', records: [...TRACK_ROWS] })
  })

  afterEach(async () => {
    await backend.shutdown()
  })

  const ids = async (filter: Record<string, unknown>): Promise<string[]> =>
    (await backend.query({ collection: 'tracks', filter })).map((r) => r.id).toSorted()

  it('excludes one value and KEEPS the rows that carry none', async () => {
    expect(await ids({ whereNotIn: { source: ['audio'] } })).toEqual(['t1', 't3', 't4', 't6', 't7'])
  })

  it('excludes several values in one predicate — what whereNot could not do', async () => {
    expect(await ids({ whereNotIn: { source: ['audio', 'sensor'] } })).toEqual(['t1', 't3', 't7'])
  })

  it('finds a row that never WROTE the column, not only one written NULL', async () => {
    // The pre-column row shape: SQLite stores an unwritten column as NULL, and
    // those rows are precisely the ones a "not this kind" filter must keep.
    await backend.insert({ collection: 'tracks', record: { id: 't8', data: { lastSeen: 8 } } })
    expect(await ids({ whereNotIn: { source: ['audio', 'sensor'] } })).toEqual([
      't1',
      't3',
      't7',
      't8',
    ])
  })

  it('an empty list excludes nothing — it is not "matches nothing"', async () => {
    expect(await ids({ whereNotIn: { source: [] } })).toHaveLength(7)
  })

  it('a listed null ALSO drops the rows carrying no value', async () => {
    expect(await ids({ whereNotIn: { source: ['audio', null] } })).toEqual(['t4', 't6'])
  })

  it('a list of only null is "IS NOT NULL"', async () => {
    expect(await ids({ whereNotIn: { source: [null] } })).toEqual(['t2', 't4', 't5', 't6'])
  })

  it('composes with the other predicates instead of replacing them', async () => {
    expect(
      await ids({
        whereNotIn: { source: ['audio'] },
        whereBetween: { lastSeen: [3, 7] },
      }),
    ).toEqual(['t3', 't4', 't6', 't7'])
  })

  it('count agrees with query about which rows it is talking about', async () => {
    const filter = { whereNotIn: { source: ['audio', 'sensor'] } }
    const rows = await backend.query({ collection: 'tracks', filter })
    expect(await backend.count({ collection: 'tracks', filter })).toBe(rows.length)
  })
})
