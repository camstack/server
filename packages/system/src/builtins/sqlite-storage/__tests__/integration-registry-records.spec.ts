import { createRecordsAccess, type ISettingsStoreProvider } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { IntegrationRegistry } from '../integration-registry.js'
import { integrationRegistryRecordKinds } from '../integration-record-kinds.js'
import { makeRecordsWorld } from './support/records-world.js'

describe('IntegrationRegistry over ctx.records', () => {
  let registry: IntegrationRegistry

  beforeEach(async () => {
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'integration-registry',
      transport: world.transportFor('integration-registry'),
      secrets: null,
    })
    const legacy = {
      declareCollection: async () => {},
      query: async () => [],
      insert: async () => {},
      updateWhere: async () => {},
      deleteWhere: async () => {},
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      update: async () => {},
    }
    await records.declare(integrationRegistryRecordKinds)
    registry = new IntegrationRegistry(
      legacy as unknown as ISettingsStoreProvider,
      IntegrationRegistry.recordStoresOf(records),
    )
    await registry.initialize()
  })

  it('does not declare legacy integration tables', async () => {
    const created = await registry.createIntegration({ addonId: 'provider-x', name: 'X' })
    expect(created.addonId).toBe('provider-x')
    expect(await registry.getIntegration(created.id)).not.toBeNull()
  })
})
