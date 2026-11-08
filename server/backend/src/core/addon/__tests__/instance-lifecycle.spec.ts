/**
 * The hub half of `integration-instances` create / delete for an instance that brings devices
 * (epic #440 H3), over the REAL integration registry on REAL SQLite: the registry row with its
 * candidate, the D1016 gate, the rollback, the device cascade, the fixed-builtin and link refusals,
 * and the `IntegrationDeleted` event.
 */
import { IntegrationRegistry } from '@camstack/server/system'
import {
  createRecordsAccess,
  EventCategory,
  type IIntegrationInstancesProvider,
  type IntegrationInstance,
  type IntegrationInstanceDescription,
  type IntegrationTestConnectionResult,
  type IScopedLogger,
} from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { integrationRegistryRecordKinds } from '../../../../../../packages/system/src/builtins/sqlite-storage/integration-record-kinds.js'
import { makeRecordsWorld } from '../../../../../../packages/system/src/builtins/sqlite-storage/__tests__/support/records-world.js'
import { isIntegrationInstancesProvider } from '../integration-instances-provider.js'
import {
  type InstanceLifecycleDeps,
  rawInstancesProvider,
  withInstanceLifecycle,
} from '../instance-lifecycle.js'
import { type InstanceHolder, registeredProviderFor } from '../instance-links.service.js'

const ADDON = 'provider-acme'

type EmitEvent = InstanceLifecycleDeps['eventBus']['emit']

function instancesProviderOrThrow(value: unknown): IIntegrationInstancesProvider {
  if (!isIntegrationInstancesProvider(value)) throw new Error('not an instances provider')
  return value
}

function silentLogger(): IScopedLogger {
  const noop = vi.fn()
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as IScopedLogger
}

interface Kit {
  readonly registry: IntegrationRegistry
  readonly provider: IIntegrationInstancesProvider
  readonly wrapped: IIntegrationInstancesProvider
  readonly calls: string[]
  readonly stored: Map<string, IntegrationInstance>
  readonly removeByIntegration: ReturnType<typeof vi.fn>
  readonly emit: Mock<EmitEvent>
  readonly testInstance: ReturnType<typeof vi.fn>
  readonly failNextCreate: { value: boolean }
  readonly holders: InstanceHolder[]
}

function description(mode: 'single' | 'multiple'): IntegrationInstanceDescription {
  return {
    role: 'devices',
    instanceMode: mode,
    kind: 'account',
    canTest: true,
    kinds: [
      { id: 'connection', label: 'Acme', functionCap: 'device-provider' },
      { id: 'dest', label: 'Destination', functionCap: 'log-destination', role: 'services' },
    ],
  }
}

async function makeKit(mode: 'single' | 'multiple' = 'multiple'): Promise<Kit> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'integration-registry',
    transport: world.transportFor('integration-registry'),
    secrets: null,
  })
  await records.declare(integrationRegistryRecordKinds)
  const registry = new IntegrationRegistry(IntegrationRegistry.recordStoresOf(records))
  await registry.initialize()

  const calls: string[] = []
  const stored = new Map<string, IntegrationInstance>()
  const failNextCreate = { value: false }
  const testInstance = vi.fn(
    async (): Promise<IntegrationTestConnectionResult> => ({ success: true, status: 'validated' }),
  )
  const provider: IIntegrationInstancesProvider = {
    describe: async () => description(mode),
    instanceFormSchema: async () => ({ sections: [] }),
    listInstances: async () => [...stored.values()],
    getInstance: async ({ id }) => stored.get(id) ?? null,
    createInstance: async ({ id, name, kind }) => {
      calls.push('createInstance')
      if (failNextCreate.value) throw new Error('record refused')
      const minted = id ?? 'minted-by-provider'
      stored.set(minted, {
        id: minted,
        name,
        kind: kind ?? 'connection',
        configured: false,
        formValues: {},
      })
      return { id: minted }
    },
    updateInstance: async ({ id, values }) => {
      calls.push('updateInstance')
      const row = stored.get(id)
      if (row !== undefined)
        stored.set(id, { ...row, formValues: { ...row.formValues, ...values } })
      return { ok: true as const }
    },
    setInstanceEnabled: async () => ({ ok: true as const }),
    deleteInstance: async ({ id }) => {
      calls.push('deleteInstance')
      stored.delete(id)
      return { ok: true as const }
    },
    testInstance,
  }
  const removeByIntegration = vi.fn(async () => {
    calls.push('removeByIntegration')
    return { removed: 3 }
  })
  const emit = vi.fn<EmitEvent>()
  const holders: InstanceHolder[] = []
  const deps: InstanceLifecycleDeps = {
    logger: silentLogger(),
    integrations: () => registry,
    deviceManager: () => ({ removeByIntegration }),
    eventBus: { emit },
    providerFor: () => provider,
    holders: () => holders,
    manifestRole: () => undefined,
  }
  const wrapped = withInstanceLifecycle(ADDON, provider, deps)
  return {
    registry,
    provider,
    wrapped,
    calls,
    stored,
    removeByIntegration,
    emit,
    testInstance,
    failNextCreate,
    holders,
  }
}

describe('createInstance of a kind that brings devices', () => {
  let kit: Kit
  beforeEach(async () => {
    kit = await makeKit()
  })

  it('writes the registry row with its candidate, and the record under the same id', async () => {
    const created = await kit.wrapped.createInstance({
      name: 'Home',
      kind: 'connection',
      values: { host: '192.0.2.10' },
      originStableId: 'mac-aabbcc',
    })
    const rows = await kit.registry.listIntegrations()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ addonId: ADDON, name: 'Home', originStableId: 'mac-aabbcc' })
    expect(created.id).toBe(rows[0]?.id)
    expect(kit.stored.get(created.id)?.formValues).toMatchObject({ host: '192.0.2.10' })
  })

  it('is refused when the connection test rejects, before any row exists', async () => {
    kit.testInstance.mockResolvedValueOnce({ success: false, status: 'rejected', error: 'bad key' })
    await expect(
      kit.wrapped.createInstance({ name: 'Home', kind: 'connection', values: { k: 'x' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'bad key' })
    expect(await kit.registry.listIntegrations()).toHaveLength(0)
    expect(kit.calls).not.toContain('createInstance')
  })

  it('passes an inconclusive test (nothing was observed) and still creates', async () => {
    kit.testInstance.mockResolvedValueOnce({ success: false, status: 'inconclusive' })
    await kit.wrapped.createInstance({ name: 'Home', kind: 'connection' })
    expect(await kit.registry.listIntegrations()).toHaveLength(1)
  })

  it('leaves nothing behind when the record is refused after the row was written', async () => {
    kit.failNextCreate.value = true
    await expect(kit.wrapped.createInstance({ name: 'Home', kind: 'connection' })).rejects.toThrow(
      'record refused',
    )
    expect(await kit.registry.listIntegrations()).toHaveLength(0)
    expect(kit.stored.size).toBe(0)
    expect(kit.calls).toContain('deleteInstance')
  })

  it('refuses a second instance of a single-instance addon', async () => {
    const single = await makeKit('single')
    await single.wrapped.createInstance({ name: 'One', kind: 'connection' })
    await expect(
      single.wrapped.createInstance({ name: 'Two', kind: 'connection' }),
    ).rejects.toBeInstanceOf(TRPCError)
    expect(await single.registry.listIntegrations()).toHaveLength(1)
  })

  it('refuses an id that names no registry row: the hub mints it', async () => {
    await expect(
      kit.wrapped.createInstance({ id: 'made-up', name: 'Home', kind: 'connection' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(await kit.registry.listIntegrations()).toHaveLength(0)
    expect(kit.stored.size).toBe(0)
  })

  it('passes through an id that names an existing row (the legacy create made it first)', async () => {
    const row = await kit.registry.createIntegration({ addonId: ADDON, name: 'Home' })
    await kit.wrapped.createInstance({ id: row.id, name: 'Home', kind: 'connection' })
    expect(await kit.registry.listIntegrations()).toHaveLength(1)
    expect(kit.stored.has(row.id)).toBe(true)
  })

  it('is the addon record alone for a kind that brings no devices', async () => {
    const created = await kit.wrapped.createInstance({ name: 'Out', kind: 'dest' })
    expect(created.id).toBe('minted-by-provider')
    expect(await kit.registry.listIntegrations()).toHaveLength(0)
    expect(kit.testInstance).not.toHaveBeenCalled()
  })
})

describe('deleteInstance of an integration', () => {
  let kit: Kit
  let id: string
  beforeEach(async () => {
    kit = await makeKit()
    id = (await kit.wrapped.createInstance({ name: 'Home', kind: 'connection' })).id
    kit.calls.length = 0
  })

  it('removes the devices first, then the record and the row, and announces it', async () => {
    await kit.wrapped.deleteInstance({ id })
    expect(kit.calls).toEqual(['removeByIntegration', 'deleteInstance'])
    expect(kit.removeByIntegration).toHaveBeenCalledWith({ integrationId: id })
    expect(await kit.registry.getIntegration(id)).toBeNull()
    expect(kit.stored.has(id)).toBe(false)
    expect(kit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        category: EventCategory.IntegrationDeleted,
        data: { integrationId: id, addonId: ADDON },
      }),
    )
  })

  it('refuses a fixed builtin before touching any device', async () => {
    await kit.registry.updateIntegration(id, { info: { fixed: true } })
    await expect(kit.wrapped.deleteInstance({ id })).rejects.toThrow(/is fixed/)
    expect(kit.removeByIntegration).not.toHaveBeenCalled()
    expect(await kit.registry.getIntegration(id)).not.toBeNull()
    expect(kit.emit).not.toHaveBeenCalled()
  })

  it('refuses while a link names the instance, before touching any device', async () => {
    const consumer: IIntegrationInstancesProvider = {
      ...kit.provider,
      describe: async () => ({
        ...description('multiple'),
        links: [{ kind: 'conn', field: 'accountId', to: { cap: 'device-provider' } }],
      }),
      listInstances: async () => [
        {
          id: 'user-1',
          name: 'Uses it',
          kind: 'conn',
          configured: true,
          formValues: { accountId: id },
        },
      ],
    }
    kit.holders.push({ addonId: 'consumer', provider: consumer })
    await expect(kit.wrapped.deleteInstance({ id })).rejects.toThrow()
    expect(kit.removeByIntegration).not.toHaveBeenCalled()
    expect(await kit.registry.getIntegration(id)).not.toBeNull()
    expect(kit.stored.has(id)).toBe(true)
  })

  it('leaves an id that is no registry row to the addon alone', async () => {
    kit.stored.set('svc-1', {
      id: 'svc-1',
      name: 'Out',
      kind: 'dest',
      configured: true,
      formValues: {},
    })
    await kit.wrapped.deleteInstance({ id: 'svc-1' })
    expect(kit.removeByIntegration).not.toHaveBeenCalled()
    expect(kit.emit).not.toHaveBeenCalled()
    expect(kit.stored.has('svc-1')).toBe(false)
  })

  it('hands the legacy door the provider it wraps', () => {
    expect(rawInstancesProvider(kit.wrapped)).toBe(kit.provider)
  })
})

describe('registration', () => {
  it('registers a holder with the hub half around it, and not without a wrap', async () => {
    const kit = await makeKit()
    const registry = { getCollectionEntries: () => [] }
    const wrap = (addonId: string, p: IIntegrationInstancesProvider) =>
      withInstanceLifecycle(addonId, p, {
        logger: silentLogger(),
        integrations: () => kit.registry,
        deviceManager: () => null,
        eventBus: { emit: kit.emit },
        providerFor: () => kit.provider,
        holders: () => [],
        manifestRole: () => undefined,
      })
    const withHub = instancesProviderOrThrow(
      registeredProviderFor('integration-instances', kit.provider, registry, {
        addonId: ADDON,
        wrap,
      }),
    )
    await withHub.createInstance({ name: 'Home', kind: 'connection' })
    expect(await kit.registry.listIntegrations()).toHaveLength(1)

    const bare = instancesProviderOrThrow(
      registeredProviderFor('integration-instances', kit.provider, registry),
    )
    await bare.createInstance({ name: 'Other', kind: 'connection' })
    expect(await kit.registry.listIntegrations()).toHaveLength(1)
  })
})
