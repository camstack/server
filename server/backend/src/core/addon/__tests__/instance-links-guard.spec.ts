import {
  InstanceInUseError,
  type IIntegrationInstancesProvider,
  type IntegrationInstance,
  type IntegrationInstanceDescription,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  guardInstanceDeletes,
  holdersOf,
  InstanceLinksIndex,
  registeredProviderFor,
  type InstanceHolder,
} from '../instance-links.service.js'

function row(
  id: string,
  kind: string | undefined,
  formValues: Record<string, unknown>,
): IntegrationInstance {
  return {
    id,
    name: `n-${id}`,
    configured: true,
    formValues,
    ...(kind !== undefined ? { kind } : {}),
  }
}

function provider(
  description: Partial<IntegrationInstanceDescription>,
  rows: readonly IntegrationInstance[],
  deleted: string[] = [],
): IIntegrationInstancesProvider {
  return {
    describe: async () => ({
      role: 'services',
      instanceMode: 'multiple',
      kind: 'x',
      canTest: false,
      ...description,
    }),
    instanceFormSchema: async () => ({ sections: [] }),
    listInstances: async () => rows,
    getInstance: async ({ id }) => rows.find((r) => r.id === id) ?? null,
    createInstance: async () => ({ id: 'x' }),
    updateInstance: async () => ({ ok: true }),
    setInstanceEnabled: async () => ({ ok: true }),
    deleteInstance: async ({ id }) => {
      deleted.push(id)
      return { ok: true }
    },
  }
}

function world() {
  const deleted: string[] = []
  const owner = provider(
    {
      kinds: [
        { id: 'account', label: 'Account', functionCap: 'broker', brokerKind: 'mqtt' },
        { id: 'inbound', label: 'Inbound', functionCap: 'broker', brokerKind: 'smtp-inbound' },
      ],
    },
    [row('b1', 'account', {}), row('b2', 'inbound', {})],
    deleted,
  )
  const consumer = provider(
    {
      links: [{ kind: 'connections', field: 'brokerId', to: { cap: 'broker', kind: 'mqtt' } }],
    },
    [
      row('c1', undefined, { brokerId: 'b1' }),
      row('c2', undefined, { brokerId: 'b2' }),
      row('c3', undefined, { brokerId: 'other' }),
    ],
  )
  const holders: readonly InstanceHolder[] = [
    { addonId: 'owner', provider: owner },
    { addonId: 'consumer', provider: consumer },
  ]
  const index = new InstanceLinksIndex(() => holders)
  return { deleted, owner, index, guarded: guardInstanceDeletes(owner, index) }
}

describe('instance links guard', () => {
  it('refuses the delete of an instance a link names, naming the users, and deletes nothing', async () => {
    const { deleted, guarded } = world()
    const err = await guarded.deleteInstance({ id: 'b1' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InstanceInUseError)
    if (!(err instanceof InstanceInUseError)) throw new Error('unreachable')
    expect(err.instanceId).toBe('b1')
    expect(err.users).toEqual([{ kind: 'connections', id: 'c1', name: 'n-c1' }])
    expect(deleted).toEqual([])
  })

  it('refuses to delete an MQTT broker an MQTT Discovery connection links, as provider-mqtt-ha declares it', async () => {
    const deleted: string[] = []
    const brokers = provider(
      {
        kind: 'brokers',
        kinds: [{ id: 'mqtt', label: 'MQTT broker', functionCap: 'broker', brokerKind: 'mqtt' }],
      },
      [row('mq1', 'mqtt', {})],
      deleted,
    )
    const connections = provider(
      {
        kind: 'connection',
        links: [
          { kind: 'connections', field: 'mqttBrokerId', to: { cap: 'broker', kind: 'mqtt' } },
        ],
      },
      [row('ha1', undefined, { mqttBrokerId: 'mq1' }), row('ha2', undefined, { mqttBrokerId: '' })],
    )
    const index = new InstanceLinksIndex(() => [
      { addonId: 'mqtt-broker', provider: brokers },
      { addonId: 'provider-mqtt-ha', provider: connections },
    ])
    const err = await guardInstanceDeletes(brokers, index)
      .deleteInstance({ id: 'mq1' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InstanceInUseError)
    if (!(err instanceof InstanceInUseError)) throw new Error('unreachable')
    expect(err.users).toEqual([{ kind: 'connections', id: 'ha1', name: 'n-ha1' }])
    expect(deleted).toEqual([])
  })

  it('deletes an instance nothing links, and one whose kind the link does not name', async () => {
    const { deleted, guarded } = world()
    // b2 is held by c2, but that link names kind `mqtt`, and b2 is `smtp-inbound`.
    await guarded.deleteInstance({ id: 'b2' })
    expect(deleted).toEqual(['b2'])
  })

  it('reads the links from every holder describe() and matches the cap and the kind', async () => {
    const { index } = world()
    expect(await index.edges()).toEqual([
      {
        holderId: 'consumer',
        kind: 'connections',
        field: 'brokerId',
        to: { cap: 'broker', kind: 'mqtt' },
      },
    ])
    expect(await index.findersFor('broker', ['mqtt'])).toHaveLength(1)
    expect(await index.findersFor('broker', ['smtp-inbound'])).toHaveLength(0)
    expect(await index.findersFor('llm', ['mqtt'])).toHaveLength(0)
  })

  it('refuses when a consumer cannot be read, instead of deleting blind', async () => {
    const { owner, deleted } = world()
    const broken: IIntegrationInstancesProvider = {
      ...provider({ links: [{ kind: 'k', field: 'f', to: { cap: 'broker' } }] }, []),
      listInstances: async () => {
        throw new Error('holder down')
      },
    }
    const index = new InstanceLinksIndex(() => [
      { addonId: 'owner', provider: owner },
      { addonId: 'broken', provider: broken },
    ])
    await expect(guardInstanceDeletes(owner, index).deleteInstance({ id: 'b1' })).rejects.toThrow(
      'holder down',
    )
    expect(deleted).toEqual([])
  })

  it('leaves every other method of the provider alone', async () => {
    const { guarded } = world()
    expect((await guarded.listInstances()).map((r) => r.id)).toEqual(['b1', 'b2'])
  })
})

describe('registeredProviderFor', () => {
  it('guards an integration-instances holder and passes any other cap through', async () => {
    const { owner } = world()
    const registry = { getCollectionEntries: vi.fn(() => []) }
    expect(registeredProviderFor('llm', owner, registry)).toBe(owner)
    expect(registeredProviderFor('integration-instances', owner, registry)).not.toBe(owner)
    const plain = { not: 'a provider' }
    expect(registeredProviderFor('integration-instances', plain, registry)).toBe(plain)
  })

  it('holdersOf lists the registry holders and skips what is not a provider', () => {
    const { owner } = world()
    const registry = {
      getCollectionEntries: () =>
        [
          ['owner', owner],
          ['junk', {}],
        ] as const,
    }
    expect(holdersOf(registry).map((h) => h.addonId)).toEqual(['owner'])
  })
})
