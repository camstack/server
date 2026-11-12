/**
 * The HomeKit name (D1049), through the addon's `device-export` provider:
 *  - a rename of an exposed device rebuilds its accessory IN PLACE under the new name, with the
 *    same accessory UUID and the same exposure entry (never an unexpose, which would wipe the
 *    pairing and make Home add it again);
 *  - the name is per bridge: another bridge keeps its own;
 *  - a refused name and a dry run write nothing and rebuild nothing.
 * (A removed bridge's names: `bridge-instances.spec`.)
 *
 * Disarm: dropping the re-expose in `setExposedName` fails the first case; a UUID derived from
 * the name fails it too.
 */
import { Accessory } from '@homebridge/hap-nodejs'
import { EXPOSED_NAMES_STORE_KEY, ExportNameRefusedError } from '@camstack/types'
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it } from 'vitest'
import { BridgeHost } from '../bridge-host.js'
import { BridgeInstance } from '../bridge-instance.js'
import type { ExposedConfigEntry } from '../hap-export-records.js'
import { hapNameValidator } from '../exposed-name.js'
import { ExportHapAddon } from '../hap-export.addon.js'
import { HAP_DEFAULT_INSTANCE_ID } from '../hap-instance-kinds.js'
import { accessoryUuidFor } from '../mappers/kind.js'

const DEVICE = '7'

class TestAddon extends ExportHapAddon {
  readonly store = new Map<number, Record<string, unknown>>()
  readonly attached: { name: string; uuid: string }[] = []
  readonly detached: string[] = []
  private readonly context = fakeAddonContext({
    id: 'export-hap',
    settings: {
      readDeviceStore: async (id) => this.store.get(id) ?? {},
      writeDeviceStore: async (id, patch) => {
        this.store.set(id, { ...this.store.get(id), ...patch })
      },
      listDeviceStoreIds: async () => [...this.store.keys()],
      readDeviceStoreBatch: async (ids) =>
        new Map(ids.map((id): [number, Record<string, unknown>] => [id, this.store.get(id) ?? {}])),
    },
  })

  override get ctx() {
    return this.context
  }

  add(inst: BridgeInstance): void {
    this.bridges.set(inst.id, inst)
  }

  provider() {
    return this.buildExportProvider()
  }

  protected override async fetchDeviceSummary() {
    return { name: 'Kitchen plug', type: 'switch' }
  }

  protected override async attachMapper(inst: BridgeInstance, entry: ExposedConfigEntry) {
    const uuid = accessoryUuidFor(entry.mapperKind, Number(entry.deviceId), inst.id)
    const accessory = new Accessory(entry.displayName, uuid)
    this.attached.push({ name: entry.displayName, uuid })
    inst.exposed.set(entry.deviceId, {
      accessory,
      accessories: [accessory],
      dispose: async () => {},
    })
    return { childAccessoryUuids: [] }
  }

  protected override async detachMapper(inst: BridgeInstance, deviceId: string) {
    this.detached.push(deviceId)
    inst.exposed.delete(deviceId)
  }

  protected override async setExposedDevices(
    inst: BridgeInstance,
    devices: readonly ExposedConfigEntry[],
  ) {
    inst.exposure = { ...inst.exposure, devices: [...devices] }
  }

  protected override async computeExportFingerprint() {
    return null
  }
}

function bridge(addon: TestAddon, id: string, name: string): BridgeInstance {
  return new BridgeInstance(
    id,
    name,
    { username: 'AA:BB:CC:DD:EE:FF', uuid: `uuid-${id}`, pincode: '031-45-154' },
    new BridgeHost({
      displayName: name,
      uuid: `uuid-${id}`,
      pincode: '031-45-154',
      logger: addon.ctx.logger,
    }),
    { name: 'HomeKit exposure', devices: [], actions: [] },
  )
}

async function exposedOnTwoBridges() {
  const addon = new TestAddon()
  addon.add(bridge(addon, HAP_DEFAULT_INSTANCE_ID, 'Home'))
  addon.add(bridge(addon, 'hap-b2', 'Guest house'))
  const provider = addon.provider()
  await provider.exposeDevice({ instanceId: HAP_DEFAULT_INSTANCE_ID, deviceId: DEVICE })
  await provider.exposeDevice({ instanceId: 'hap-b2', deviceId: DEVICE })
  return { addon, provider }
}

describe('HomeKit exposed name', () => {
  it('accepts a HomeKit name and refuses what hap-nodejs would reject', () => {
    expect(hapNameValidator('Porta d’ingresso (nord) 2').ok).toBe(true)
    expect(hapNameValidator('Porch!').ok).toBe(false)
    expect(hapNameValidator('x'.repeat(65)).ok).toBe(false)
  })

  it('a rename rebuilds the same accessory in place under the new name', async () => {
    const { addon, provider } = await exposedOnTwoBridges()
    const before = addon.attached[0]
    expect(before?.name).toBe('Kitchen plug')

    await provider.setExposedName({
      instanceId: HAP_DEFAULT_INSTANCE_ID,
      deviceId: DEVICE,
      name: 'Coffee machine',
    })

    const after = addon.attached.at(-1)
    expect(after?.name).toBe('Coffee machine')
    expect(after?.uuid).toBe(before?.uuid)
    expect(addon.detached).toEqual([DEVICE])
    const listed = await provider.listExposedDevices({ instanceId: HAP_DEFAULT_INSTANCE_ID })
    expect(listed).toEqual([
      expect.objectContaining({ deviceId: DEVICE, exposedName: 'Coffee machine' }),
    ])
  })

  it('is per bridge: the other bridge keeps the device name', async () => {
    const { addon, provider } = await exposedOnTwoBridges()
    await provider.setExposedName({ instanceId: 'hap-b2', deviceId: DEVICE, name: 'Guest plug' })
    const other = await provider.listExposedDevices({ instanceId: HAP_DEFAULT_INSTANCE_ID })
    expect(other[0]?.exposedName).toBeUndefined()
    expect(addon.store.get(7)?.[EXPOSED_NAMES_STORE_KEY]).toEqual({ 'hap-b2': 'Guest plug' })
  })

  it('a refused name and a dry run write nothing and rebuild nothing', async () => {
    const { addon, provider } = await exposedOnTwoBridges()
    const attachedBefore = addon.attached.length
    await expect(
      provider.setExposedName({
        instanceId: HAP_DEFAULT_INSTANCE_ID,
        deviceId: DEVICE,
        name: 'Porch!',
      }),
    ).rejects.toBeInstanceOf(ExportNameRefusedError)
    await provider.setExposedName({
      instanceId: HAP_DEFAULT_INSTANCE_ID,
      deviceId: DEVICE,
      name: 'Valid name',
      dryRun: true,
    })
    expect(addon.store.get(7)).toBeUndefined()
    expect(addon.attached.length).toBe(attachedBefore)
  })
})
