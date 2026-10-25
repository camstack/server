import { describe, expect, it } from 'vitest'
import { HmBrokerEntrySchema } from '../config.js'
import { HmBrokerStore } from '../hm-broker-store.js'
import { makeHmRecords } from './fake-records.js'

describe('HmBrokerStore', () => {
  it('replaceAll persists CCU brokers on the brokers entry kind', async () => {
    const world = await makeHmRecords()
    const store = HmBrokerStore.of(world.records)
    const a = HmBrokerEntrySchema.parse({
      id: 'hm_001',
      name: 'CCU',
      connection: { host: '192.168.1.10', port: 2010, username: 'Admin', password: 'pw' },
    })
    const b = HmBrokerEntrySchema.parse({
      id: 'hm_002',
      name: 'Backup',
      connection: { host: '192.168.1.11', port: 2010, username: 'Admin', password: 'pw2' },
    })
    await store.replaceAll([a, b])
    await store.replaceAll([b])
    expect((await store.listResolved()).map((e) => e.id)).toEqual(['hm_002'])
  })
})
