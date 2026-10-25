/**
 * `count` must answer about the SAME rows `query` returns.
 *
 * It was the fourth hand-rolled copy of the filter logic and it honoured only
 * `where` — `whereBetween`, `whereIn` and `whereNot` were dropped on the floor,
 * silently. That is not a slow count, it is a WRONG one, and two live callers
 * decided on it: `countStaging({ deviceId, olderThanMs })` counted a device's
 * whole staging history instead of the part older than the cutoff, and the
 * notification-centre artefact gallery paged against a `total` that ignored
 * visibility, expiry, kind and time window alike.
 *
 * Every case below is expressed as "count agrees with query" rather than
 * against a hardcoded number: agreement is the actual contract, and a future
 * fourth copy breaks it in exactly the way a literal would not catch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

describe('SqliteSettingsBackend.count — the whole filter, not a quarter of it', () => {
  let backend: SqliteSettingsBackend

  const countAndQuery = async (
    collection: string,
    filter: Parameters<SqliteSettingsBackend['count']>[0]['filter'],
  ): Promise<{ counted: number; queried: number }> => {
    const counted = await backend.count({ collection, filter })
    const rows = await backend.query({ collection, filter })
    return { counted, queried: rows.length }
  }

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()

    await backend.declareCollection({
      collection: 'tracks',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'deviceId', type: 'INTEGER', notNull: true },
        { name: 'lastSeen', type: 'INTEGER', notNull: true },
        { name: 'retrainStatus', type: 'TEXT' },
        // Nullable with no default, like the real `closedReason`: rows that
        // predate the column carry NULL and a "not this reason" filter must
        // KEEP them.
        { name: 'closedReason', type: 'TEXT' },
      ],
    })

    const rows: ReadonlyArray<{
      id: string
      deviceId: number
      lastSeen: number
      retrainStatus: string | null
      closedReason: string | null
    }> = [
      { id: 't1', deviceId: 101, lastSeen: 1_000, retrainStatus: 'staging', closedReason: null },
      { id: 't2', deviceId: 101, lastSeen: 2_000, retrainStatus: 'staging', closedReason: null },
      {
        id: 't3',
        deviceId: 101,
        lastSeen: 9_000,
        retrainStatus: 'staging',
        closedReason: 'stationary-promotion',
      },
      { id: 't4', deviceId: 101, lastSeen: 9_500, retrainStatus: 'trained', closedReason: null },
      { id: 't5', deviceId: 102, lastSeen: 1_500, retrainStatus: 'staging', closedReason: null },
    ]
    for (const r of rows) {
      const { id, ...data } = r
      await backend.insert({ collection: 'tracks', record: { id, data } })
    }
  })

  afterEach(async () => {
    await backend.shutdown()
  })

  it('honours whereBetween — the countStaging({ deviceId, olderThanMs }) shape', async () => {
    // Device 101 has three staging tracks; only t1 and t2 are older than 5 000.
    const { counted, queried } = await countAndQuery('tracks', {
      where: { deviceId: 101, retrainStatus: 'staging' },
      whereBetween: { lastSeen: [0, 4_999] },
    })
    expect(counted).toBe(2)
    expect(counted).toBe(queried)
  })

  it('honours whereIn', async () => {
    const { counted, queried } = await countAndQuery('tracks', {
      where: { deviceId: 101 },
      whereIn: { retrainStatus: ['staging'] },
    })
    expect(counted).toBe(3)
    expect(counted).toBe(queried)
  })

  it('honours whereNot, NULL-safe — rows predating the column are KEPT', async () => {
    const { counted, queried } = await countAndQuery('tracks', {
      where: { deviceId: 101 },
      whereNot: { closedReason: 'stationary-promotion' },
    })
    // t1, t2, t4 — the three NULL rows; t3 is excluded by name.
    expect(counted).toBe(3)
    expect(counted).toBe(queried)
  })

  it('honours the three clauses together', async () => {
    const { counted, queried } = await countAndQuery('tracks', {
      where: { deviceId: 101 },
      whereIn: { retrainStatus: ['staging', 'trained'] },
      whereBetween: { lastSeen: [0, 9_400] },
      whereNot: { closedReason: 'stationary-promotion' },
    })
    expect(counted).toBe(2)
    expect(counted).toBe(queried)
  })

  it('a filter that matches nothing counts 0, not the table', async () => {
    const { counted, queried } = await countAndQuery('tracks', {
      where: { deviceId: 101, retrainStatus: 'staging' },
      whereBetween: { lastSeen: [0, 0] },
    })
    expect(counted).toBe(0)
    expect(counted).toBe(queried)
  })

  it('an absent filter still counts the whole collection', async () => {
    expect(await backend.count({ collection: 'tracks' })).toBe(5)
  })

  describe('KV-shape collection (single `data` JSON blob)', () => {
    beforeEach(async () => {
      await backend.declareCollection({
        collection: 'artefacts',
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
          { name: 'data', type: 'TEXT', notNull: true },
        ],
      })
      const blobs: ReadonlyArray<{ id: string; kind: string; capturedAt: number }> = [
        { id: 'a1', kind: 'clip', capturedAt: 100 },
        { id: 'a2', kind: 'clip', capturedAt: 900 },
        { id: 'a3', kind: 'poster', capturedAt: 200 },
      ]
      for (const b of blobs) {
        const { id, ...rest } = b
        await backend.insert({ collection: 'artefacts', record: { id, data: rest } })
      }
    })

    it('reaches blob fields through json_extract for whereIn and whereBetween', async () => {
      const { counted, queried } = await countAndQuery('artefacts', {
        whereIn: { kind: ['clip'] },
        whereBetween: { capturedAt: [0, 500] },
      })
      expect(counted).toBe(1)
      expect(counted).toBe(queried)
    })
  })
})
