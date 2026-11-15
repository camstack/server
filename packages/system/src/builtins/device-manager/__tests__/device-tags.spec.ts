/**
 * Device tags (D1054): `setTags` normalises and persists the list on the device
 * meta row, a re-registration keeps it, and nothing cascades to descendants
 * (a tag labels the record it is on; a location is organisational).
 */
import type { IDeviceManagerProvider, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import {
  isDeviceManagerProvider,
  makeAddonContext,
  registrationsOf,
} from './typed-addon-context.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import type { FakeSettingsStore } from './settings-store-api.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

let idSeq = 9000

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeSettings() {
  const addonStore: Record<string, unknown> = {}
  const deviceStores: Record<number, Record<string, unknown>> = {}
  const runtimeStores: Record<number, Record<string, unknown>> = {}
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore: vi.fn(async (id: number) => ({ ...deviceStores[id] })),
    readDeviceStoreBatch: vi.fn(async (ids: readonly number[]) => {
      const out = new Map<number, Record<string, unknown>>()
      for (const id of ids) out.set(id, { ...deviceStores[id] })
      return out
    }),
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
    listDeviceStoreIds: vi.fn(async () => Object.keys(deviceStores).map(Number)),
    getSection: vi.fn(async () => ({})),
    setSection: vi.fn(async () => undefined),
    clearDeviceStore: vi.fn(async (id: number) => {
      delete deviceStores[id]
    }),
    readDeviceRuntimeState: vi.fn(async (id: number) => ({ ...runtimeStores[id] })),
    writeDeviceRuntimeState: vi.fn(async (id: number, data: Record<string, unknown>) => {
      runtimeStores[id] = { ...data }
    }),
    clearDeviceRuntimeState: vi.fn(async (id: number) => {
      delete runtimeStores[id]
    }),
  }
}

/** The durable state a reboot carries over: the sqlite ledger + addon store. */
interface PersistentState {
  readonly store: FakeSettingsStore
  readonly settings: ReturnType<typeof makeSettings>
}

interface BootHandle {
  readonly provider: IDeviceManagerProvider
  readonly logger: IScopedLogger
  readonly state: PersistentState
}

/**
 * One device-manager "boot" over the given persistent state. A fresh addon
 * instance, registry and bus each time — exactly what a hub restart gives the
 * builtin — while the ledger and addon store survive.
 */
async function boot(shared?: PersistentState): Promise<BootHandle> {
  const state: PersistentState = shared ?? {
    store: await makeSettingsStoreApi(),
    settings: makeSettings(),
  }
  const addon = new DeviceManagerAddon()
  const logger = makeLogger()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = makeAddonContext({
    id: 'device-manager',
    logger,
    settings: state.settings,
    api: { settingsStore: state.store.api },
    kernel: { deviceRegistry: new DeviceRegistry() },
    records,
  })
  const first = registrationsOf(await addon.initialize(ctx)).find((r) =>
    isDeviceManagerProvider(r.provider),
  )
  if (!first || !isDeviceManagerProvider(first.provider)) {
    throw new Error('no device-manager registration')
  }
  return { provider: first.provider, logger, state }
}

/** Register a device through the canonical action path. */
async function register(
  h: BootHandle,
  opts: { type?: string; parentDeviceId?: number | null } = {},
): Promise<number> {
  const id = idSeq++
  const stableId = `tags-dev-${id}`
  await h.provider.allocateDeviceId({ addonId: 'test-addon', stableId })
  await h.provider.registerDevice({
    addonId: 'test-addon',
    stableId,
    id,
    type: opts.type ?? 'sensor',
    name: stableId,
    location: null,
    parentDeviceId: opts.parentDeviceId ?? null,
    config: {},
  })
  return id
}

async function tagsOf(h: BootHandle, id: number): Promise<readonly string[] | undefined> {
  const rows = await h.provider.listAll({ projection: 'slim' })
  return rows.find((r) => r.id === id)?.tags
}

describe('device tags', () => {
  it('setTags normalises on write and listAll returns them', async () => {
    const h = await boot()
    const id = await register(h)
    expect(await tagsOf(h, id)).toBeUndefined()
    await h.provider.setTags({ deviceId: id, tags: [' Garden ', 'garden', 'Night'] })
    expect(await tagsOf(h, id)).toEqual(['Garden', 'Night'])
    await h.provider.setTags({ deviceId: id, tags: [] })
    expect(await tagsOf(h, id)).toBeUndefined()
  })

  it('survives a re-registration and a reboot, and does not cascade to a child', async () => {
    const h = await boot()
    const parent = await register(h)
    const child = await register(h, { parentDeviceId: parent })
    await h.provider.setTags({ deviceId: parent, tags: ['Garden'] })
    await h.provider.registerDevice({
      addonId: 'test-addon',
      stableId: `tags-dev-${parent}`,
      id: parent,
      type: 'sensor',
      name: `tags-dev-${parent}`,
      location: null,
      parentDeviceId: null,
      config: {},
    })
    expect(await tagsOf(h, parent)).toEqual(['Garden'])
    expect(await tagsOf(h, child)).toBeUndefined()
    const rebooted = await boot(h.state)
    expect(await tagsOf(rebooted, parent)).toEqual(['Garden'])
  })

  it('an unknown device is refused', async () => {
    const h = await boot()
    await expect(h.provider.setTags({ deviceId: 424242, tags: ['x'] })).rejects.toThrow(
      /unknown device/,
    )
  })
})
