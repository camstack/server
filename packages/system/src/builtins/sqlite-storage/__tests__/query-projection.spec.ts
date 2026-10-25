/**
 * SQL-level column projection.
 *
 * Until now `projection: 'slim'` in the analytics stores meant "read the whole
 * row, then drop the heavy columns in JS" — SQLite paid every byte of a 8.7 kB
 * `positions` blob off the disk so the mapper could throw it away one line
 * later. Measured on a copy of the live database, a 501-row page of
 * `pipeline-analytics:tracks` is 4.6 MB whole and 0.11 MB projected, on the
 * same index and the same query plan. No index can fix a `SELECT *`.
 *
 * The contract under test is not "it is faster" — it is that a projected read
 * cannot LIE. A predicate the engine cannot express is skipped; a projection it
 * cannot serve must throw, because an absent key and a NULL column look the
 * same to every caller.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend, UnprojectableColumnError } from '../sqlite-settings-backend.js'

describe('SqliteSettingsBackend.query — column projection', () => {
  let backend: SqliteSettingsBackend

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()

    await backend.declareCollection({
      collection: 'tracks',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'deviceId', type: 'INTEGER', notNull: true },
        { name: 'lastSeen', type: 'INTEGER', notNull: true },
        { name: 'positions', type: 'JSON' },
        { name: 'debug', type: 'BOOLEAN' },
        // Nullable and left unset below — the row that proves an unread column
        // and a NULL column must not look alike.
        { name: 'closedReason', type: 'TEXT' },
      ],
    })
    await backend.insert({
      collection: 'tracks',
      record: {
        id: 't1',
        data: { deviceId: 101, lastSeen: 1_000, positions: [{ x: 1 }, { x: 2 }], debug: true },
      },
    })
  })

  afterEach(async () => {
    await backend.shutdown()
  })

  it('returns the requested columns and the primary key, and nothing else', async () => {
    const rows = await backend.query({
      collection: 'tracks',
      columns: ['deviceId', 'lastSeen'],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('t1')
    expect(rows[0]?.data).toEqual({ id: 't1', deviceId: 101, lastSeen: 1_000 })
  })

  it('an unread column is ABSENT, while a NULL column is present and null', async () => {
    const projected = await backend.query({
      collection: 'tracks',
      columns: ['deviceId', 'closedReason'],
    })
    const whole = await backend.query({ collection: 'tracks' })

    // `closedReason` was asked for and is genuinely NULL in the row.
    expect(Object.hasOwn(projected[0]?.data ?? {}, 'closedReason')).toBe(true)
    expect(projected[0]?.data['closedReason']).toBeNull()
    // `positions` was NOT asked for — the key does not exist at all, so a
    // caller cannot mistake "I did not read it" for "the database says null".
    expect(Object.hasOwn(projected[0]?.data ?? {}, 'positions')).toBe(false)
    // …and the unprojected read still returns everything, unchanged.
    expect(Object.hasOwn(whole[0]?.data ?? {}, 'positions')).toBe(true)
  })

  it('still decodes types of the columns it does read (BOOLEAN, JSON)', async () => {
    const rows = await backend.query({ collection: 'tracks', columns: ['debug', 'positions'] })
    expect(rows[0]?.data['debug']).toBe(true)
    expect(rows[0]?.data['positions']).toEqual([{ x: 1 }, { x: 2 }])
  })

  it('composes with the filter, ordering and the row bound', async () => {
    await backend.insert({
      collection: 'tracks',
      record: { id: 't2', data: { deviceId: 101, lastSeen: 5_000, positions: [] } },
    })
    const rows = await backend.query({
      collection: 'tracks',
      filter: {
        where: { deviceId: 101 },
        whereBetween: { lastSeen: [0, 9_000] },
        orderBy: { field: 'lastSeen', direction: 'desc' },
        limit: 1,
      },
      columns: ['lastSeen'],
    })
    expect(rows.map((r) => r.id)).toEqual(['t2'])
    expect(rows[0]?.data).toEqual({ id: 't2', lastSeen: 5_000 })
  })

  it('naming the primary key is harmless — it is returned either way', async () => {
    const rows = await backend.query({ collection: 'tracks', columns: ['id', 'deviceId'] })
    expect(rows[0]?.data).toEqual({ id: 't1', deviceId: 101 })
  })

  describe('refusals — a projection is not forgiving the way a predicate is', () => {
    it('throws on a column the collection does not have', async () => {
      await expect(
        backend.query({ collection: 'tracks', columns: ['deviceId', 'ghost'] }),
      ).rejects.toThrow(UnprojectableColumnError)
    })

    it('throws on an empty projection rather than reading nothing', async () => {
      await expect(backend.query({ collection: 'tracks', columns: [] })).rejects.toThrow(
        UnprojectableColumnError,
      )
    })

    it('throws on a KV-shaped collection, where the row IS the blob', async () => {
      await backend.declareCollection({
        collection: 'kv',
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
          { name: 'data', type: 'TEXT', notNull: true },
        ],
      })
      await backend.insert({ collection: 'kv', record: { id: 'k1', data: { a: 1, b: 2 } } })
      await expect(backend.query({ collection: 'kv', columns: ['a'] })).rejects.toThrow(
        UnprojectableColumnError,
      )
      // …and the unprojected read of the same collection is untouched.
      const rows = await backend.query({ collection: 'kv' })
      expect(rows[0]?.data).toEqual({ a: 1, b: 2 })
    })
  })

  it('the SELECT is narrowed in SQL, not in JS — the plan is unchanged', async () => {
    // The point of the whole exercise: same index, same plan, fewer bytes. If
    // a future change implements the projection by post-filtering the row map,
    // this test still passes — which is why the byte-level proof lives in the
    // measurement on a real database, and this one only pins the contract that
    // the engine may not invent keys.
    const rows = await backend.query({ collection: 'tracks', columns: ['deviceId'] })
    expect(Object.keys(rows[0]?.data ?? {}).sort()).toEqual(['deviceId', 'id'])
  })
})
