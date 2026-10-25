import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

describe('SqliteSettingsBackend.histogram', () => {
  let backend: SqliteSettingsBackend

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()

    await backend.declareCollection({
      collection: 'evt',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'deviceId', type: 'INTEGER', notNull: true },
        { name: 'timestamp', type: 'INTEGER', notNull: true },
      ],
    })

    // deviceId 1: timestamps 0, 1000, 2000, 7000
    await backend.insert({
      collection: 'evt',
      record: { id: 'e1', data: { deviceId: 1, timestamp: 0 } },
    })
    await backend.insert({
      collection: 'evt',
      record: { id: 'e2', data: { deviceId: 1, timestamp: 1000 } },
    })
    await backend.insert({
      collection: 'evt',
      record: { id: 'e3', data: { deviceId: 1, timestamp: 2000 } },
    })
    await backend.insert({
      collection: 'evt',
      record: { id: 'e4', data: { deviceId: 1, timestamp: 7000 } },
    })

    // deviceId 2: timestamp 500
    await backend.insert({
      collection: 'evt',
      record: { id: 'e5', data: { deviceId: 2, timestamp: 500 } },
    })
  })

  afterEach(async () => {
    await backend.shutdown()
  })

  it('buckets counts by (timestamp - origin)/bucketSize within a where+range filter', async () => {
    const out = await backend.histogram({
      collection: 'evt',
      field: 'timestamp',
      bucketSize: 5000,
      origin: 0,
      filter: { where: { deviceId: 1 }, whereBetween: { timestamp: [0, 8000] } },
    })
    // bucket 0 = [0,5000): ts 0,1000,2000 → 3 ; bucket 1 = [5000,10000): ts 7000 → 1
    expect(out).toEqual([
      { bucket: 0, count: 3 },
      { bucket: 1, count: 1 },
    ])
  })
  it('returns [] for an empty range', async () => {
    expect(
      await backend.histogram({
        collection: 'evt',
        field: 'timestamp',
        bucketSize: 5000,
        origin: 0,
        filter: { where: { deviceId: 9 } },
      }),
    ).toEqual([])
  })
})
