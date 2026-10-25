import { describe, expect, it } from 'vitest'
import { MatterBrokerEntrySchema } from '../config.js'
import { MatterBrokerStore } from '../matter-broker-store.js'
import { makeInMemoryRecords } from '@camstack/types'
import { matterBrokersEntryKind } from '../broker-record-kinds.js'

async function makeMatterRecords() {
  const world = makeInMemoryRecords('matter-broker')
  await world.records.declare({ brokers: matterBrokersEntryKind })
  return world
}

describe('MatterBrokerStore', () => {
  it('replaceAll round-trips a fabric broker', async () => {
    const world = await makeMatterRecords()
    const store = MatterBrokerStore.of(world.records)
    const entry = MatterBrokerEntrySchema.parse({
      id: 'matter_001',
      name: 'Home fabric',
      connection: { wifiPassword: 'pw', threadDataset: 'abc' },
    })
    await store.replaceAll([entry])
    const listed = await store.listResolved()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.connection.wifiPassword).toBe('pw')
  })
})
