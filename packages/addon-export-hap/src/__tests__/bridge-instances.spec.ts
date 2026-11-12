/**
 * The multi-instance surface of the HomeKit export (#422): which bridge a call addresses, what the
 * instance form shows, what a deleted bridge takes with it.
 */
import { describe, expect, it, vi } from 'vitest'
import { ExportInstanceUnknownError } from '@camstack/types'
import type { BridgeHost } from '../bridge-host.js'
import { BridgeInstance } from '../bridge-instance.js'
import type { Mapper } from '../mappers/types.js'
import { ExportHapAddon } from '../hap-export.addon.js'
import { HAP_DEFAULT_INSTANCE_ID } from '../hap-instance-kinds.js'

const warn = vi.fn()

function fakeHost() {
  return {
    accessory: null,
    dispose: vi.fn(async () => {}),
    holds: () => false,
  } as unknown as BridgeHost
}

function bridge(id: string, name: string, deviceIds: readonly string[] = []): BridgeInstance {
  const inst = new BridgeInstance(
    id,
    name,
    {
      username: 'AA:BB:CC:DD:EE:FF',
      uuid: `uuid-${id}`,
      pincode: '031-45-154',
    },
    fakeHost(),
    {
      name: 'HomeKit exposure',
      devices: deviceIds.map((deviceId) => ({
        deviceId,
        displayName: `d${deviceId}`,
        mapperKind: 'generic' as const,
        addedAt: 0,
      })),
      actions: [],
    },
  )
  for (const deviceId of deviceIds) {
    // A live accessory per exposed device; the listing only reads its display name.
    inst.exposed.set(deviceId, {
      accessory: { displayName: `${name}/${deviceId}` },
      accessories: [],
      dispose: async () => {},
    } as unknown as Mapper)
  }
  return inst
}

class TestAddon extends ExportHapAddon {
  readonly deleted: string[] = []
  /** The addon's per-device store (D865), where the bridges' device names live (D1049). */
  readonly deviceStore = new Map<number, Record<string, unknown>>()

  override get ctx() {
    const logger = {
      info: () => {},
      warn,
      debug: () => {},
      error: () => {},
      withTags: () => logger,
    }
    const store = this.deviceStore
    const settings = {
      listDeviceStoreIds: async () => [...store.keys()],
      readDeviceStoreBatch: async (ids: readonly number[]) =>
        new Map(ids.map((id): [number, Record<string, unknown>] => [id, store.get(id) ?? {}])),
      readDeviceStore: async (id: number) => store.get(id) ?? {},
      writeDeviceStore: async (id: number, patch: Record<string, unknown>) => {
        store.set(id, { ...store.get(id), ...patch })
      },
    }
    return { logger, settings } as unknown as ExportHapAddon['ctx']
  }

  add(inst: BridgeInstance): void {
    this.bridges.set(inst.id, inst)
  }

  has(id: string): boolean {
    return this.bridges.has(id)
  }

  provider() {
    return this.buildExportProvider()
  }

  form(id: string | null) {
    return this.bridgeForm(id)
  }

  warnName(inst: BridgeInstance): void {
    this.warnOnDuplicateName(inst)
  }

  remove(id: string): Promise<void> {
    return this.removeInstance(id)
  }

  protected override exposureHandle() {
    const deleted = this.deleted
    return {
      delete: async (id: string) => {
        deleted.push(id)
        return true
      },
    } as unknown as ReturnType<ExportHapAddon['exposureHandle']>
  }
}

function withBridges() {
  const addon = new TestAddon()
  addon.add(bridge(HAP_DEFAULT_INSTANCE_ID, 'Home', ['1', '2']))
  addon.add(bridge('hap-b2', 'Guest house', ['2', '3']))
  return addon
}

describe('the instance a device-export call addresses', () => {
  it('refuses a read that names a bridge the addon does not run', async () => {
    const provider = withBridges().provider()
    await expect(provider.listExposedDevices({ instanceId: 'ghost' })).rejects.toBeInstanceOf(
      ExportInstanceUnknownError,
    )
  })

  it('refuses a write that names a bridge the addon does not run', async () => {
    const provider = withBridges().provider()
    await expect(
      provider.unexposeDevice({ instanceId: 'ghost', deviceId: '1' }),
    ).rejects.toBeInstanceOf(ExportInstanceUnknownError)
  })

  it('scopes a read to the named bridge and spans every bridge without one', async () => {
    const provider = withBridges().provider()
    const only = await provider.listExposedDevices({ instanceId: 'hap-b2' })
    expect(only.map((d) => d.exposedAs)).toEqual(['Guest house/2', 'Guest house/3'])
    const all = await provider.listExposedDevices({})
    expect(all).toHaveLength(4)
  })

  it('counts a device exposed on two bridges once in the whole-addon status', async () => {
    const status = await withBridges().provider().getStatus({})
    expect(status.exposedDeviceCount).toBe(3)
    const one = await withBridges().provider().getStatus({ instanceId: 'hap-b2' })
    expect(one.exposedDeviceCount).toBe(2)
  })
})

describe('the instance form', () => {
  const fieldsOf = (id: string | null, addon = withBridges()) =>
    addon.form(id).sections.flatMap((s) => s.fields)

  it('shows the setup code read-only and offers Regenerate with a confirmation naming the effect', () => {
    const fields = fieldsOf('hap-b2')
    const code = fields.find((f) => 'key' in f && f.key === 'setupCode')
    expect(code).toMatchObject({ type: 'info', content: '031-45-154' })
    expect(fields.some((f) => f.type === 'password')).toBe(false)
    const button = fields.find((f) => f.type === 'addon-action-button')
    expect(button).toMatchObject({
      action: 'regenerateBridge',
      paramsStatic: { instanceId: 'hap-b2' },
      variant: 'danger',
    })
    expect(JSON.stringify(button)).toMatch(/unpaired/)
  })

  it('offers neither the code nor the button on the create form', () => {
    const fields = fieldsOf(null)
    expect(fields.some((f) => 'key' in f && f.key === 'setupCode')).toBe(false)
    expect(fields.some((f) => f.type === 'addon-action-button')).toBe(false)
  })
})

describe('bridge names and deletion', () => {
  it('warns when two bridges share a name', () => {
    warn.mockClear()
    const addon = withBridges()
    const twin = bridge('hap-b3', ' home ')
    addon.add(twin)
    addon.warnName(twin)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not warn for distinct names', () => {
    warn.mockClear()
    const addon = withBridges()
    addon.warnName(bridge('hap-b3', 'Garage'))
    expect(warn).not.toHaveBeenCalled()
  })

  it('unpublishes a deleted bridge and removes its exposure row', async () => {
    const addon = withBridges()
    await addon.remove('hap-b2')
    expect(addon.has('hap-b2')).toBe(false)
    expect(addon.has(HAP_DEFAULT_INSTANCE_ID)).toBe(true)
    expect(addon.deleted).toEqual(['hap-b2'])
  })

  it('a deleted bridge takes its device names with it; the other bridge keeps its own (D1049)', async () => {
    const addon = withBridges()
    addon.deviceStore.set(2, {
      exposedNames: { 'hap-b2': 'Guest plug', [HAP_DEFAULT_INSTANCE_ID]: 'Plug' },
      other: 1,
    })
    await addon.remove('hap-b2')
    expect(addon.deviceStore.get(2)).toEqual({
      exposedNames: { [HAP_DEFAULT_INSTANCE_ID]: 'Plug' },
      other: 1,
    })
  })
})
