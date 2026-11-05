import { BrokerInUseError, makeInMemoryRecords, brokerLinkUserFinder } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildAlexaBrokerProvider } from '../alexa-broker-provider.js'
import { buildAlexaInstances } from '../alexa-instances.js'
import { alexaBrokersEntryKind, alexaConnectionsEntryKind } from '../broker-record-kinds.js'
import { recordingLogger } from './helpers/recording-logger.js'
import type { AlexaBrokerEntry } from '../config.js'

async function setup() {
  const world = makeInMemoryRecords('import-alexa')
  await world.records.declare({
    brokers: alexaBrokersEntryKind,
    connections: alexaConnectionsEntryKind,
  })
  const instances = buildAlexaInstances(world.records)
  const entry: AlexaBrokerEntry = {
    id: 'alexa_002',
    name: 'Home',
    connection: {
      amazonDomain: 'amazon.it',
      cookie: 'c',
      refreshToken: '',
      macDms: '',
      pollIntervalMs: 60_000,
    },
  }
  const removed: string[] = []
  const provider = buildAlexaBrokerProvider({
    ownerAddonId: 'import-alexa',
    registry: {
      list: () => [],
      get: () => null,
      createEntry: async () => entry,
      removeEntry: async (id) => {
        removed.push(id)
      },
      updateEntry: async () => entry,
      size: () => 1,
      connectedCount: () => 0,
    },
    getBrokers: () => [entry],
    persistBrokers: async () => undefined,
    brokerUsers: [
      brokerLinkUserFinder(instances),
      {
        find: async (brokerId) =>
          brokerId === 'alexa_002' ? [{ kind: 'notification-target', id: 'echo-kitchen' }] : [],
      },
    ],
    cascadeRemoveDevices: async () => undefined,
    logger: recordingLogger().logger,
  })
  return { instances, provider, removed }
}

describe('removing an Alexa account', () => {
  it('is refused while an integration or an Echo target still uses it, naming both', async () => {
    const { instances, provider, removed } = await setup()
    await instances.createInstance({ id: 'int_0036', name: 'Alexa home' })
    await instances.updateInstance({ id: 'int_0036', values: { brokerId: 'alexa_002' } })
    const err = await provider.remove({ id: 'alexa_002' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerInUseError)
    if (!(err instanceof BrokerInUseError)) throw err
    expect(err.users.map((u) => u.id).sort()).toEqual(['echo-kitchen', 'int_0036'])
    expect(removed).toEqual([])
  })
})
