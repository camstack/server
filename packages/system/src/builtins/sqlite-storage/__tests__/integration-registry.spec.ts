/**
 * IntegrationRegistry round-trip over its record kind on the REAL records provider
 * (SQLite), so a body that does not survive serialisation fails here.
 */
import { createRecordsAccess } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { integrationRegistryRecordKinds } from '../integration-record-kinds.js'
import { IntegrationRegistry } from '../integration-registry.js'
import { makeRecordsWorld } from './support/records-world.js'

describe('IntegrationRegistry over its record kind', () => {
  let registry: IntegrationRegistry

  beforeEach(async () => {
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'integration-registry',
      transport: world.transportFor('integration-registry'),
      secrets: null,
    })
    await records.declare(integrationRegistryRecordKinds)
    registry = new IntegrationRegistry(IntegrationRegistry.recordStoresOf(records))
    await registry.initialize()
  })

  it('round-trips an integration INCLUDING its info blob', async () => {
    const created = await registry.createIntegration({
      addonId: 'provider-hikvision',
      name: 'Hikvision',
      info: { vendor: 'hik', channels: 4 },
    })
    expect(created.info).toEqual({ vendor: 'hik', channels: 4 })

    const read = await registry.getIntegration(created.id)
    expect(read).not.toBeNull()
    expect(read!.name).toBe('Hikvision')
    expect(read!.enabled).toBe(true)
    // The regression this file is for: `info` survives the round trip.
    expect(read!.info).toEqual({ vendor: 'hik', channels: 4 })

    const byAddon = await registry.getIntegrationByAddonId('provider-hikvision')
    expect(byAddon?.id).toBe(created.id)

    const all = await registry.listIntegrations()
    expect(all.map((i) => i.id)).toContain(created.id)
  })

  it('updates name / enabled / info and reflects them on read', async () => {
    const created = await registry.createIntegration({ addonId: 'a', name: 'A' })
    const updated = await registry.updateIntegration(created.id, {
      name: 'A2',
      enabled: false,
      info: { k: 'v' },
    })
    expect(updated?.name).toBe('A2')
    expect(updated?.enabled).toBe(false)
    expect(updated?.info).toEqual({ k: 'v' })
  })

  it('deleting an integration removes the row', async () => {
    const int = await registry.createIntegration({
      addonId: 'a',
      name: 'A',
    })

    await registry.deleteIntegration(int.id)

    expect(await registry.getIntegration(int.id)).toBeNull()
  })

  describe('a FIXED integration', () => {
    it("cannot be deleted — the refusal is the SERVER's, not the UI's", async () => {
      // A fixed integration is declared by an addon (the Notification Center's
      // alarm panel is the first), not added by an operator. Hiding the button
      // would leave the mutation one API call away.
      const int = await registry.createIntegration({
        addonId: 'pipeline-analytics',
        name: 'Notification Center',
        info: { fixed: true },
      })
      await expect(registry.deleteIntegration(int.id)).rejects.toThrow(/fixed/)
      expect(await registry.getIntegration(int.id)).not.toBeNull()
    })

    it('leaves an ordinary integration deletable', async () => {
      const int = await registry.createIntegration({ addonId: 'a', name: 'A' })
      expect(await registry.deleteIntegration(int.id)).toBe(true)
      expect(await registry.getIntegration(int.id)).toBeNull()
    })
  })

  it('keeps the candidate an integration was born from, as a typed field', async () => {
    const created = await registry.createIntegration({
      addonId: 'provider-reolink',
      name: 'Home Hub',
      originStableId: 'mac-aabbccddeeff',
    })
    expect(created.originStableId).toBe('mac-aabbccddeeff')
    expect((await registry.getIntegration(created.id))?.originStableId).toBe('mac-aabbccddeeff')
    const listed = (await registry.listIntegrations()).find((i) => i.id === created.id)
    expect(listed?.originStableId).toBe('mac-aabbccddeeff')
    expect(listed?.info).not.toHaveProperty('originStableId')
  })

  it('keys a row by the BARE addon id: a prefixed hub-main ctx.id is canonicalised on write and lookup', async () => {
    const created = await registry.createIntegration({ addonId: 'addon:x', name: 'X' })
    expect(created.addonId).toBe('x')
    expect((await registry.getIntegration(created.id))?.addonId).toBe('x')
    expect((await registry.getIntegrationByAddonId('addon:x'))?.id).toBe(created.id)
    expect((await registry.getIntegrationByAddonId('x'))?.id).toBe(created.id)
  })
})
