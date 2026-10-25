/**
 * SensorEventStore — insert, per-camera query semantics
 * (window / kinds / limit / ordering) and the retention eviction drain.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { type FakeRecords, kindRows, makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { wireSensorEventLedger } from '../event-ledger-wiring.js'
import { SensorEventStore } from '../sensor-event-store.js'

describe('SensorEventStore', () => {
  let world: FakeRecords
  let store: SensorEventStore

  beforeEach(async () => {
    world = await makeAnalyticsRecords()
    store = new SensorEventStore({
      logger: makeSilentLogger(),
      sensorLedger: wireSensorEventLedger({ records: world.records }),
    })
  })

  const insertAll = async (): Promise<void> => {
    await store.insert({
      id: 'e1',
      deviceId: 1,
      sourceDeviceId: 10,
      kind: 'contact',
      value: { entryOpen: true },
      timestamp: 1000,
    })
    await store.insert({
      id: 'e2',
      deviceId: 1,
      sourceDeviceId: 11,
      kind: 'flood',
      value: { flooded: false },
      timestamp: 2000,
    })
    await store.insert({
      id: 'e3',
      deviceId: 2,
      sourceDeviceId: 10,
      kind: 'contact',
      value: null,
      timestamp: 3000,
    })
  }

  it('queries per camera, newest first, with round-tripped values', async () => {
    await insertAll()
    const rows = await store.query({ deviceId: 1 })
    expect(rows.map((r) => r.id)).toEqual(['e2', 'e1'])
    expect(rows[1]).toEqual({
      id: 'e1',
      deviceId: 1,
      sourceDeviceId: 10,
      kind: 'contact',
      value: { entryOpen: true },
      timestamp: 1000,
    })
  })

  it('narrows by time window, kinds, and limit', async () => {
    await insertAll()
    expect((await store.query({ deviceId: 1, since: 1500 })).map((r) => r.id)).toEqual(['e2'])
    expect((await store.query({ deviceId: 1, until: 1500 })).map((r) => r.id)).toEqual(['e1'])
    expect((await store.query({ deviceId: 1, kinds: ['contact'] })).map((r) => r.id)).toEqual([
      'e1',
    ])
    expect((await store.query({ deviceId: 1, limit: 1 })).map((r) => r.id)).toEqual(['e2'])
  })

  it('normalizes a null/absent value on read', async () => {
    await insertAll()
    const rows = await store.query({ deviceId: 2 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.value).toBeNull()
  })

  it("evictBefore drains ONE device's rows at or below the cutoff", async () => {
    await insertAll()
    const deleted = await store.evictBefore(1, 2000)
    expect(deleted).toBe(2)
    expect(kindRows(world, 'sensor-events').length).toBe(1)
    const remaining = await store.query({ deviceId: 2 })
    expect(remaining.map((r) => r.id)).toEqual(['e3'])
  })

  it("never touches another device — the cutoff is that camera's, not the fleet's", async () => {
    // This used to sweep the whole table on the fleet MINIMUM cutoff, purely
    // because the store predated a device scope (D61). A camera on a 1-day
    // window now cannot drag a camera on 7 days down with it, and vice versa.
    await insertAll()
    const deleted = await store.evictBefore(1, Number.MAX_SAFE_INTEGER)
    expect(deleted).toBe(2)
    expect((await store.query({ deviceId: 2 })).map((r) => r.id)).toEqual(['e3'])
  })
})
