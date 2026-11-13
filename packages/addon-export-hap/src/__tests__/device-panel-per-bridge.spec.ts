/**
 * The device Export tab offers ONE HomeKit switch PER BRIDGE (#407, D1009).
 *
 * Before, the panel spoke for "the" bridge — whichever already exposed the device, else the
 * default — so with two bridges a device could not be put on the second one from its own page,
 * and a device on both showed one switch for one of them. Each bridge now has its own section,
 * its own keys, and a patch writes only the bridge its key names.
 */
import { describe, expect, it } from 'vitest'
import type { BridgeHost } from '../bridge-host.js'
import { BridgeInstance } from '../bridge-instance.js'
import { ExportHapAddon } from '../hap-export.addon.js'
import type { ExposedConfigEntry } from '../hap-export-records.js'
import { HAP_DEFAULT_INSTANCE_ID } from '../hap-instance-kinds.js'
import type { Mapper } from '../mappers/types.js'

function fakeHost() {
  return {
    accessory: null,
    dispose: async () => {},
    holds: () => false,
  } as unknown as BridgeHost
}

function bridge(id: string, name: string, deviceIds: readonly string[]): BridgeInstance {
  const inst = new BridgeInstance(
    id,
    name,
    { username: 'AA:BB:CC:DD:EE:FF', uuid: `uuid-${id}`, pincode: '031-45-154' },
    fakeHost(),
    {
      name: 'HomeKit exposure',
      devices: deviceIds.map((deviceId) => ({
        deviceId,
        displayName: `d${deviceId}`,
        mapperKind: 'camera' as const,
        addedAt: 0,
      })),
      actions: [],
    },
  )
  for (const deviceId of deviceIds) {
    inst.exposed.set(deviceId, {
      accessory: { displayName: `${name}/${deviceId}`, setupURI: () => '' },
      accessories: [],
      dispose: async () => {},
    } as unknown as Mapper)
  }
  return inst
}

class TestAddon extends ExportHapAddon {
  readonly writes: { instanceId: string; devices: readonly ExposedConfigEntry[] }[] = []

  override get ctx() {
    const logger = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
      withTags: () => logger,
    }
    return { logger } as unknown as ExportHapAddon['ctx']
  }

  add(inst: BridgeInstance): void {
    this.bridges.set(inst.id, inst)
  }

  provider() {
    return this.buildExportProvider()
  }

  protected override async fetchDeviceSummary() {
    return { name: 'Porch', type: 'camera' }
  }

  protected override async setExposedDevices(
    inst: BridgeInstance,
    devices: readonly ExposedConfigEntry[],
  ): Promise<void> {
    this.writes.push({ instanceId: inst.id, devices })
    inst.exposure = { ...inst.exposure, devices }
  }
}

function withBridges(): TestAddon {
  const addon = new TestAddon()
  addon.add(bridge(HAP_DEFAULT_INSTANCE_ID, 'Home', ['1', '2']))
  addon.add(bridge('hap-b2', 'Guest house', ['2', '3']))
  return addon
}

type Field = { readonly type: string; readonly key?: string; readonly value?: unknown }

async function exposeSwitches(addon: TestAddon, deviceId: number) {
  const contribution = await addon.provider().getDeviceSettingsContribution?.({ deviceId })
  return (contribution?.sections ?? []).map((section) => ({
    id: section.id,
    title: section.title,
    expose: section.fields
      .filter((f: Field) => f.type === 'boolean' && f.key?.endsWith(':enabled') === true)
      .map((f: Field) => ({ key: f.key, value: f.value })),
  }))
}

describe('the device Export tab, one switch per bridge', () => {
  it('draws one section and one Expose switch per running bridge, each with its own state', async () => {
    const sections = await exposeSwitches(withBridges(), 3)
    expect(sections).toEqual([
      {
        id: `export-hap:${HAP_DEFAULT_INSTANCE_ID}`,
        title: 'HomeKit Export — Home',
        expose: [{ key: `hap:${HAP_DEFAULT_INSTANCE_ID}:3:enabled`, value: false }],
      },
      {
        id: 'export-hap:hap-b2',
        title: 'HomeKit Export — Guest house',
        expose: [{ key: 'hap:hap-b2:3:enabled', value: true }],
      },
    ])
  })

  it('keeps the plain title when only one bridge runs', async () => {
    const addon = new TestAddon()
    addon.add(bridge(HAP_DEFAULT_INSTANCE_ID, 'Home', ['1']))
    const sections = await exposeSwitches(addon, 1)
    expect(sections.map((s) => s.title)).toEqual(['HomeKit Export'])
  })

  it('writes a setting only on the bridge its key names', async () => {
    const addon = withBridges()
    await addon.provider().applyDeviceSettingsPatch?.({
      deviceId: 2,
      patch: { 'hap:hap-b2:2:multiTierService': false },
    })
    expect(addon.writes.map((w) => w.instanceId)).toEqual(['hap-b2'])
    const entry = addon.writes[0]?.devices.find((d) => d.deviceId === '2')
    expect(entry?.settings?.multiTierService).toBe(false)
  })

  it('refuses a key that names a bridge the addon does not run', async () => {
    await expect(
      withBridges()
        .provider()
        .applyDeviceSettingsPatch?.({ deviceId: 2, patch: { 'hap:ghost:2:enabled': true } }),
    ).rejects.toThrow(/ghost/)
  })
})
