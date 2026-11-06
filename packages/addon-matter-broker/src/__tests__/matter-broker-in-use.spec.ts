import {
  InstanceInUseError,
  linkUserFinder,
  guardInstanceDelete,
  makeInMemoryRecords,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { matterBrokersEntryKind, matterConnectionsEntryKind } from '../broker-record-kinds.js'
import { buildMatterAccountInstances } from '../matter-account-instances.js'
import { buildMatterInstances } from '../matter-instances.js'

describe('deleting a Matter fabric', () => {
  it('is refused while an integration still uses it, naming it', async () => {
    const world = makeInMemoryRecords('matter-broker')
    await world.records.declare({
      brokers: matterBrokersEntryKind,
      connections: matterConnectionsEntryKind,
    })
    const instances = buildMatterInstances(world.records)
    const changed: string[] = []
    const accounts = buildMatterAccountInstances(world.records, {
      mintId: () => 'matter_002',
      infoOf: () => null,
      onChanged: async (id) => {
        changed.push(id)
      },
    })
    const provider = guardInstanceDelete(accounts.toProvider(), () => [
      linkUserFinder(instances, 'brokerId'),
    ])
    await world.records.kind(matterBrokersEntryKind).put(
      {
        id: 'matter_002',
        data: {
          name: 'Home',
          threadDataset: 't',
          wifiSsid: 'lab',
          wifiPassword: 'w',
          reconcileIntervalMs: 300_000,
        },
      },
      { ifRev: 0 },
    )
    await instances.createInstance({ id: 'int_0050', name: 'Matter home' })
    await instances.updateInstance({ id: 'int_0050', values: { brokerId: 'matter_002' } })
    const err = await provider.deleteInstance({ id: 'matter_002' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InstanceInUseError)
    if (!(err instanceof InstanceInUseError)) throw err
    expect(err.users.map((u) => u.id)).toEqual(['int_0050'])
    expect(changed).toEqual([])
  })
})
