/**
 * IntegrationRegistry round-trip over the REAL engine.
 *
 * Deliberately not a fake: this file exists because B2 moved the registry from
 * the `table*` bypass onto the collection surface, and the two surfaces differ
 * in ways no hand-written fake reproduces — `query` reassembles typed columns
 * and JSON-PARSES any TEXT column whose value starts with `{` or `[`, where
 * `tableQuery` handed back the raw string. A fake that returns what the mapper
 * expects proves nothing; an in-memory `SqliteSettingsBackend` is the same code
 * the hub runs.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { IntegrationRegistry } from '../integration-registry.js'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

describe('IntegrationRegistry over the collection surface', () => {
  let backend: SqliteSettingsBackend
  let registry: IntegrationRegistry

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()
    registry = new IntegrationRegistry(backend)
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
