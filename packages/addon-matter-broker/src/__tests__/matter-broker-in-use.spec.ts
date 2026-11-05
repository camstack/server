import { BrokerInUseError, brokerLinkUserFinder, makeInMemoryRecords } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { matterBrokersEntryKind, matterConnectionsEntryKind } from '../broker-record-kinds.js'
import type { MatterBrokerEntry } from '../config.js'
import { buildMatterBrokerProvider } from '../matter-broker-provider.js'
import { buildMatterInstances } from '../matter-instances.js'

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const ENTRY: MatterBrokerEntry = {
  id: 'matter_002',
  name: 'Home',
  connection: {
    threadDataset: 't',
    wifiSsid: 'lab',
    wifiPassword: 'w',
    reconcileIntervalMs: 300_000,
  },
}

describe('removing a Matter fabric', () => {
  it('is refused while an integration still uses it, naming it', async () => {
    const world = makeInMemoryRecords('matter-broker')
    await world.records.declare({
      brokers: matterBrokersEntryKind,
      connections: matterConnectionsEntryKind,
    })
    const instances = buildMatterInstances(world.records)
    const removed: string[] = []
    const provider = buildMatterBrokerProvider({
      ownerAddonId: 'matter-broker',
      registry: {
        list: () => [],
        get: () => null,
        createEntry: async () => ENTRY,
        removeEntry: async (id) => {
          removed.push(id)
        },
        updateEntry: async () => ENTRY,
        size: () => 1,
        connectedCount: () => 0,
        commissionNode: async () => ({ nodeId: '1' }),
        getCommissionProgress: () => null,
      },
      getBrokers: () => [ENTRY],
      persistBrokers: async () => undefined,
      brokerUsers: [brokerLinkUserFinder(instances)],
      cascadeRemoveDevices: async () => undefined,
      logger: silentLogger(),
    })
    await instances.createInstance({ id: 'int_0050', name: 'Matter home' })
    await instances.updateInstance({ id: 'int_0050', values: { brokerId: 'matter_002' } })
    const err = await provider.remove({ id: 'matter_002' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerInUseError)
    if (!(err instanceof BrokerInUseError)) throw err
    expect(err.users.map((u) => u.id)).toEqual(['int_0050'])
    expect(removed).toEqual([])
  })
})
