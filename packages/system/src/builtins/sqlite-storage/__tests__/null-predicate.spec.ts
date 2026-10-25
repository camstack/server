/**
 * `IS NULL` — the predicate the filter language could not express, and the
 * number it returned instead.
 *
 * `where: { locationId: null }` compiled to `"locationId" = ?` bound to NULL.
 * SQL three-valued logic makes that expression NULL for every row, so the
 * filter matched NOTHING and `count` answered **0** — on a collection where
 * 1 254 576 rows carried exactly that value. Zero is the one answer the
 * `eventMedia` migration gate treats as "safe to cut over", so the defect did
 * not read as a broken filter: it read as a green light.
 *
 * `whereNot: { locationId: null }` was the same defect mirrored. It compiled to
 * `(expr IS NULL OR expr != ?)`, which with a NULL parameter is TRUE for a NULL
 * row and NULL for every other — it selected **precisely the rows it was asked
 * to exclude**.
 *
 * Every fixture below holds BOTH stamped and unstamped rows. A table where
 * every row is unstamped passes against a query that ignores the filter
 * entirely, which is the bug.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'
import { UnsafeFilterError } from '../filter-compiler.js'

/** 2 unstamped, 3 stamped — neither population may be the whole table. */
const MEDIA_ROWS = [
  { id: 'm1', data: { timestamp: 1, kind: 'snapshot', locationId: null } },
  { id: 'm2', data: { timestamp: 2, kind: 'snapshot', locationId: 'eventMedia:hdd' } },
  { id: 'm3', data: { timestamp: 3, kind: 'keyFrame', locationId: null } },
  { id: 'm4', data: { timestamp: 4, kind: 'keyFrame', locationId: 'eventMedia:ssd' } },
  { id: 'm5', data: { timestamp: 5, kind: 'thumbnail', locationId: 'eventMedia:hdd' } },
] as const

describe('null predicates over a structured collection', () => {
  let backend: SqliteSettingsBackend

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()
    await backend.declareCollection({
      collection: 'media',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'timestamp', type: 'INTEGER', notNull: true },
        { name: 'kind', type: 'TEXT', notNull: true },
        { name: 'locationId', type: 'TEXT' },
      ],
      indexes: [{ name: 'idx_media_location', columns: ['locationId'] }],
    })
    await backend.insertMany({ collection: 'media', records: [...MEDIA_ROWS] })
  })

  afterEach(async () => {
    await backend.shutdown()
  })

  it('counts the unstamped rows, not zero and not the whole table', async () => {
    const total = await backend.count({ collection: 'media' })
    const unstamped = await backend.count({
      collection: 'media',
      filter: { where: { locationId: null } },
    })
    expect(total).toBe(5)
    expect(unstamped).toBe(2)
  })

  it('finds a row that never WROTE the column, not only one written NULL', async () => {
    // The pre-column row shape. SQLite stores an unwritten column as NULL and
    // `IS NULL` must find it — that population is the whole reason the seal
    // exists, and it is older than every explicitly-null row.
    await backend.insert({
      collection: 'media',
      record: { id: 'm6', data: { timestamp: 6, kind: 'firstFrame' } },
    })
    expect(
      await backend.count({ collection: 'media', filter: { where: { locationId: null } } }),
    ).toBe(3)
    expect(
      await backend.count({ collection: 'media', filter: { whereNot: { locationId: null } } }),
    ).toBe(3)
  })

  it('agrees with `query` about which rows those are', async () => {
    const rows = await backend.query({
      collection: 'media',
      filter: { where: { locationId: null } },
    })
    expect(rows.map((row) => row.id).toSorted()).toEqual(['m1', 'm3'])
  })

  it('agrees with `aggregate` about which rows those are', async () => {
    const agg = await backend.aggregate({
      collection: 'media',
      fields: [{ as: 'newest', field: 'timestamp', op: 'max' }],
      filter: { where: { locationId: null } },
    })
    expect(agg.count).toBe(2)
    expect(agg.values['newest']).toBe(3)
  })

  it('combines a null predicate with a non-null one', async () => {
    const unstampedKeyFrames = await backend.count({
      collection: 'media',
      filter: { where: { locationId: null, kind: 'keyFrame' } },
    })
    expect(unstampedKeyFrames).toBe(1)
  })

  it('answers zero only when the population is genuinely empty', async () => {
    await backend.update({
      collection: 'media',
      id: 'm1',
      data: { locationId: 'eventMedia:hdd' },
    })
    await backend.update({
      collection: 'media',
      id: 'm3',
      data: { locationId: 'eventMedia:hdd' },
    })
    expect(
      await backend.count({ collection: 'media', filter: { where: { locationId: null } } }),
    ).toBe(0)
  })

  it('`whereNot: null` EXCLUDES the null rows instead of selecting them', async () => {
    const stamped = await backend.query({
      collection: 'media',
      filter: { whereNot: { locationId: null } },
    })
    expect(stamped.map((row) => row.id).toSorted()).toEqual(['m2', 'm4', 'm5'])
    expect(
      await backend.count({ collection: 'media', filter: { whereNot: { locationId: null } } }),
    ).toBe(3)
  })

  it('leaves the NULL-safe exclusion of a REAL value alone', async () => {
    // The historical `whereNot` contract: rows whose field is NULL are KEPT,
    // because they predate the column. Only the null PARAMETER changes meaning.
    const notHdd = await backend.query({
      collection: 'media',
      filter: { whereNot: { locationId: 'eventMedia:hdd' } },
    })
    expect(notHdd.map((row) => row.id).toSorted()).toEqual(['m1', 'm3', 'm4'])
  })

  it('reads the index for `IS NULL` rather than scanning the table', async () => {
    const plan = backend.explainQueryPlan(
      'SELECT COUNT(*) AS cnt FROM "media" WHERE "locationId" IS NULL',
      [],
    )
    expect(plan.join(' ')).toContain('idx_media_location')
  })
})

describe('null predicates inside a KV blob collection', () => {
  let backend: SqliteSettingsBackend

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()
  })

  afterEach(async () => {
    await backend.shutdown()
  })

  it('resolves through json_extract and still means IS NULL', async () => {
    await backend.set({ collection: 'system-settings', key: 'a', value: { owner: null } })
    await backend.set({ collection: 'system-settings', key: 'b', value: { owner: 'ops' } })
    await backend.set({ collection: 'system-settings', key: 'c', value: { owner: null } })
    expect(
      await backend.count({ collection: 'system-settings', filter: { where: { owner: null } } }),
    ).toBe(2)
    expect(
      await backend.count({ collection: 'system-settings', filter: { whereNot: { owner: null } } }),
    ).toBe(1)
  })
})

describe('a predicate a counting method cannot apply is REFUSED, not dropped', () => {
  let backend: SqliteSettingsBackend

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()
    await backend.declareCollection({
      collection: 'media',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'timestamp', type: 'INTEGER', notNull: true },
        { name: 'locationId', type: 'TEXT' },
      ],
    })
    await backend.insertMany({
      collection: 'media',
      records: [
        { id: 'm1', data: { timestamp: 1, locationId: null } },
        { id: 'm2', data: { timestamp: 2, locationId: 'eventMedia:hdd' } },
      ],
    })
  })

  afterEach(async () => {
    await backend.shutdown()
  })

  /**
   * `query` stays forgiving: the caller receives the ROWS and can see for
   * itself that the predicate did not bite. A count hands back a bare number
   * with no such recourse — the whole collection and the selected subset are
   * the same shape, and only one of them is an answer.
   */
  it('`query` still drops it — the caller can see the rows', async () => {
    const rows = await backend.query({
      collection: 'media',
      filter: { where: { ghostColumn: 'x' } },
    })
    expect(rows).toHaveLength(2)
  })

  it('`count` refuses it', async () => {
    await expect(
      backend.count({ collection: 'media', filter: { where: { ghostColumn: 'x' } } }),
    ).rejects.toThrow(UnsafeFilterError)
  })

  it('`aggregate` refuses it', async () => {
    await expect(
      backend.aggregate({
        collection: 'media',
        fields: [],
        filter: { where: { ghostColumn: 'x' } },
      }),
    ).rejects.toThrow(UnsafeFilterError)
  })

  it('`histogram` refuses it', async () => {
    await expect(
      backend.histogram({
        collection: 'media',
        field: 'timestamp',
        bucketSize: 10,
        origin: 0,
        filter: { where: { ghostColumn: 'x' } },
      }),
    ).rejects.toThrow(UnsafeFilterError)
  })

  it('still answers an unfiltered count — no predicate is a legitimate question here', async () => {
    expect(await backend.count({ collection: 'media' })).toBe(2)
  })
})
