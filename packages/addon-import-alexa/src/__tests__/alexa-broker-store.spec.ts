import { describe, expect, it } from 'vitest'
import { AlexaBrokerEntrySchema } from '../config.js'
import { AlexaBrokerStore } from '../alexa-broker-store.js'
import { makeInMemoryRecords } from '@camstack/types'
import { alexaBrokersEntryKind } from '../broker-record-kinds.js'

async function makeAlexaRecords() {
  const world = makeInMemoryRecords('import-alexa')
  await world.records.declare({ brokers: alexaBrokersEntryKind })
  return world
}

describe('AlexaBrokerStore', () => {
  it('persists cookie secret through the brokers kind', async () => {
    const world = await makeAlexaRecords()
    const store = AlexaBrokerStore.of(world.records)
    const entry = AlexaBrokerEntrySchema.parse({
      id: 'alexa_001',
      name: 'Home',
      connection: {
        amazonDomain: 'amazon.com',
        cookie: 'secret-cookie-blob',
        refreshToken: '',
        macDms: '',
        pollIntervalMs: 60_000,
      },
    })
    await store.replaceAll([entry])
    expect((await store.listResolved())[0]?.connection.cookie).toBe('secret-cookie-blob')
  })
})
