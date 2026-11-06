import {
  InstanceInUseError,
  linkUserFinder,
  guardInstanceDelete,
  makeInMemoryRecords,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildAlexaAccountInstances } from '../alexa-account-instances.js'
import { buildAlexaInstances } from '../alexa-instances.js'
import { alexaBrokersEntryKind, alexaConnectionsEntryKind } from '../broker-record-kinds.js'

async function setup() {
  const world = makeInMemoryRecords('import-alexa')
  await world.records.declare({
    brokers: alexaBrokersEntryKind,
    connections: alexaConnectionsEntryKind,
  })
  const instances = buildAlexaInstances(world.records)
  const changed: string[] = []
  const accounts = buildAlexaAccountInstances(world.records, {
    mintId: () => 'alexa_002',
    infoOf: () => null,
    onChanged: async (id) => {
      changed.push(id)
    },
  })
  const provider = guardInstanceDelete(accounts.toProvider(), () => [
    linkUserFinder(instances, 'brokerId'),
    {
      find: async (brokerId) =>
        brokerId === 'alexa_002' ? [{ kind: 'notification-target', id: 'echo-kitchen' }] : [],
    },
  ])
  await world.records.kind(alexaBrokersEntryKind).put(
    {
      id: 'alexa_002',
      data: {
        name: 'Home',
        amazonDomain: 'amazon.it',
        cookie: 'c',
        refreshToken: '',
        macDms: '',
        pollIntervalMs: 60_000,
      },
    },
    { ifRev: 0 },
  )
  return { instances, provider, changed }
}

describe('deleting an Alexa account', () => {
  it('is refused while an integration or an Echo target still uses it, naming both', async () => {
    const { instances, provider } = await setup()
    await instances.createInstance({ id: 'int_0036', name: 'Alexa home' })
    await instances.updateInstance({ id: 'int_0036', values: { brokerId: 'alexa_002' } })
    const err = await provider.deleteInstance({ id: 'alexa_002' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InstanceInUseError)
    if (!(err instanceof InstanceInUseError)) throw err
    expect(err.users.map((u) => u.id).sort()).toEqual(['echo-kitchen', 'int_0036'])
    expect((await provider.listInstances()).map((i) => i.id)).toContain('alexa_002')
  })
})
