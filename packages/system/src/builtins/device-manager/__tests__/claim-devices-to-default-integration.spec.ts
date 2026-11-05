/**
 * `claimDevicesToDefaultIntegration` over the REAL device manager on real SQLite (planning#416):
 * the devices a provider persisted before integrations were named get the addon's default
 * integration, by the same `setIntegrationId` patch the hub uses everywhere. The fixture device
 * carries a marked config field and a location, so a stamp that rewrote the row (instead of
 * patching the one column) loses them and the spec fails; an already-stamped device must keep
 * the integration it has.
 */
import { claimDevicesToDefaultIntegration, type ClaimDevicesPorts } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { setup } from './device-manager-harness.js'
import { readDeviceRow } from './settings-store-api.js'

const ADDON = 'provider-spec'
const MARK = 'marked-field-the-claim-does-not-know'

async function world() {
  const h = await setup()
  const make = async (
    stableId: string,
    config: Record<string, unknown>,
    parentDeviceId: number | null = null,
  ) => {
    const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId })
    await h.provider.registerDevice({
      addonId: ADDON,
      stableId,
      id,
      type: 'container',
      name: stableId,
      parentDeviceId,
      config,
    })
    return id
  }
  const integrations = [
    { id: 'int_0031', name: 'Hub', info: { migratedFromHub: 1 } },
    { id: 'int_0012', name: 'Default', info: {} },
  ]
  const infoLog: string[] = []
  const warnings: { message: string; deviceId: number }[] = []
  const ports: ClaimDevicesPorts = {
    listIntegrations: async (addonId) => (addonId === ADDON ? integrations : []),
    listDevices: async (addonId) =>
      (await h.provider.listAll({ addonId, projection: 'slim' })).map((d) => ({
        id: d.id,
        integrationId: d.integrationId,
        parentDeviceId: d.parentDeviceId,
        type: d.type,
        name: d.name,
        stableId: d.stableId,
      })),
    hasConfig: async (deviceId) =>
      Object.keys((await h.provider.getDevice({ deviceId }))?.config ?? {}).length > 0,
    setIntegrationId: (deviceId, integrationId) =>
      h.provider.setIntegrationId({ deviceId, integrationId }),
    readIntegrationId: async (deviceId) =>
      (await h.provider.getDevice({ deviceId }))?.integrationId ?? null,
    info: (m) => {
      infoLog.push(m)
    },
    warnDevice: (m, deviceId) => {
      warnings.push({ message: m, deviceId })
    },
  }
  return { h, make, ports, infoLog, warnings }
}

describe('claimDevicesToDefaultIntegration', () => {
  it('stamps the default integration on the un-stamped devices, keeps everything else, and leaves a stamped device alone', async () => {
    const w = await world()
    const orphan = await w.make('gree:aa', { host: '192.0.2.10', mark: MARK })
    const orphanTwo = await w.make('gree:bb', { host: '192.0.2.11' })
    const stamped = await w.make('gree:cc', { host: '192.0.2.12' })
    await w.h.provider.setIntegrationId({ deviceId: stamped, integrationId: 'int_0031' })
    await w.h.provider.setLocation({ deviceId: orphan, location: 'Kitchen' })

    const result = await claimDevicesToDefaultIntegration(w.ports, {
      addonId: ADDON,
      eligible: (i) => i.info['migratedFromHub'] === undefined,
    })

    expect(result.outcome).toBe('done')
    const row = await readDeviceRow(w.h.settingsStore, orphan)
    expect(row['integrationId']).toBe('int_0012')
    expect(row['stableId']).toBe('gree:aa')
    expect(row['deviceId']).toBe(orphan)
    expect(row['location']).toBe('Kitchen')
    expect((await readDeviceRow(w.h.settingsStore, orphanTwo))['integrationId']).toBe('int_0012')
    // the already-stamped device keeps ITS integration
    expect((await readDeviceRow(w.h.settingsStore, stamped))['integrationId']).toBe('int_0031')
    // the marked config survives the stamp
    expect((await w.h.provider.getDevice({ deviceId: orphan }))?.config['mark']).toBe(MARK)
  })

  it('a rerun is a no-op', async () => {
    const w = await world()
    await w.make('gree:aa', { mark: MARK })
    await claimDevicesToDefaultIntegration(w.ports, { addonId: ADDON })
    const again = await claimDevicesToDefaultIntegration(w.ports, { addonId: ADDON })
    expect(again.outcome).toBe('already-done')
  })

  it('throws when the addon has no integration to claim to, and changes nothing', async () => {
    const w = await world()
    const id = await w.make('gree:aa', {})
    await expect(
      claimDevicesToDefaultIntegration(
        { ...w.ports, listIntegrations: async () => [] },
        { addonId: ADDON },
      ),
    ).rejects.toThrow(/no integration to claim/)
    expect((await readDeviceRow(w.h.settingsStore, id))['integrationId'] ?? null).toBeNull()
  })

  it('throws, naming the device, when a stamp does not read back', async () => {
    const w = await world()
    const id = await w.make('gree:aa', {})
    await expect(
      claimDevicesToDefaultIntegration(
        { ...w.ports, readIntegrationId: async () => null },
        { addonId: ADDON },
      ),
    ).rejects.toThrow(new RegExp(`device\\(s\\) ${id} did not read back`))
  })

  it('a child takes its PARENT integration, not the default: roots under the default and under an ineligible migrated hub', async () => {
    const w = await world()
    const rootA = await w.make('cam:a', {})
    const rootB = await w.make('cam:b', {})
    await w.h.provider.setIntegrationId({ deviceId: rootA, integrationId: 'int_0012' })
    await w.h.provider.setIntegrationId({ deviceId: rootB, integrationId: 'int_0031' })
    const childA = await w.make('cam:a:siren', { mark: MARK }, rootA)
    const childB = await w.make('cam:b:siren', { mark: MARK }, rootB)
    const result = await claimDevicesToDefaultIntegration(w.ports, {
      addonId: ADDON,
      eligible: (i) => i.info['migratedFromHub'] === undefined,
    })
    expect(result.outcome).toBe('done')
    expect((await readDeviceRow(w.h.settingsStore, childA))['integrationId']).toBe('int_0012')
    expect((await readDeviceRow(w.h.settingsStore, childB))['integrationId']).toBe('int_0031')
    expect((await w.h.provider.getDevice({ deviceId: childB }))?.config['mark']).toBe(MARK)
    const again = await claimDevicesToDefaultIntegration(w.ports, { addonId: ADDON })
    expect(again.outcome).toBe('already-done')
  })

  it('an unstamped parent is stamped first (root to the default), then its child from it', async () => {
    const w = await world()
    const root = await w.make('cam:a', {})
    const child = await w.make('cam:a:light', {}, root)
    const result = await claimDevicesToDefaultIntegration(w.ports, {
      addonId: ADDON,
      eligible: (i) => i.info['migratedFromHub'] === undefined,
    })
    expect(result.outcome).toBe('done')
    expect((await readDeviceRow(w.h.settingsStore, root))['integrationId']).toBe('int_0012')
    expect((await readDeviceRow(w.h.settingsStore, child))['integrationId']).toBe('int_0012')
  })

  it('children alone never need a default integration', async () => {
    const w = await world()
    const root = await w.make('cam:a', {})
    await w.h.provider.setIntegrationId({ deviceId: root, integrationId: 'int_0031' })
    const child = await w.make('cam:a:light', {}, root)
    const result = await claimDevicesToDefaultIntegration(
      { ...w.ports, listIntegrations: async () => [] },
      { addonId: ADDON },
    )
    expect(result.outcome).toBe('done')
    expect((await readDeviceRow(w.h.settingsStore, child))['integrationId']).toBe('int_0031')
  })

  it('a child whose parent is missing is left unstamped, counted and warned with its deviceId', async () => {
    const w = await world()
    const child = await w.make('cam:x:light', {}, 99999)
    const result = await claimDevicesToDefaultIntegration(w.ports, { addonId: ADDON })
    expect(result.outcome).toBe('already-done')
    expect(result).toMatchObject({ summary: { claimed: 0, unresolved: 1 } })
    expect(w.warnings.map((x) => x.deviceId)).toEqual([child])
    expect((await readDeviceRow(w.h.settingsStore, child))['integrationId'] ?? null).toBeNull()
  })

  it('an allocation reservation is skipped and counted, never stamped', async () => {
    const w = await world()
    const { id: reserved } = await w.h.provider.allocateDeviceId({
      addonId: ADDON,
      stableId: '__probe__',
    })
    const real = await w.make('cam:a', {})
    const result = await claimDevicesToDefaultIntegration(w.ports, { addonId: ADDON })
    expect(result).toMatchObject({ summary: { claimed: 1, reservations: 1 } })
    expect((await readDeviceRow(w.h.settingsStore, real))['integrationId']).toBe('int_0012')
    expect((await readDeviceRow(w.h.settingsStore, reserved))['integrationId'] ?? null).toBeNull()
  })
})
