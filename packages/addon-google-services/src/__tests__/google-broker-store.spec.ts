import { describe, expect, it } from 'vitest'
import { GoogleBrokerEntrySchema } from '../google-types.js'
import { GoogleBrokerStore } from '../google-broker-store.js'
import { makeInMemoryRecords } from '@camstack/types'
import { googleBrokersEntryKind } from '../broker-record-kinds.js'

async function makeGoogleRecords() {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({ brokers: googleBrokersEntryKind })
  return world
}

describe('GoogleBrokerStore', () => {
  it('round-trips clientSecret on the brokers kind', async () => {
    const world = await makeGoogleRecords()
    const store = GoogleBrokerStore.of(world.records)
    const entry = GoogleBrokerEntrySchema.parse({
      id: 'google_001',
      name: 'Workspace',
      clientSecret: 'sec',
    })
    await store.replaceAll([entry])
    expect((await store.listResolved())[0]?.clientSecret).toBe('sec')
  })
})
