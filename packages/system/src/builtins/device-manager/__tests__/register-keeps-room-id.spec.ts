/**
 * A re-registration keeps the room id a row stores (D1089). `location` is the NAME the room record
 * resolves to; a record that does not resolve (not loaded, or removed) must never turn into a
 * `null` locationId when the provider re-registers the device.
 */
import type {
  AddonContext,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  SystemEvent,
} from '@dominevo/types'
import { DeviceType } from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import {
  DEVICE_ROWS_COLLECTION,
  type DeviceRowBackend,
  deviceRowBackendOf,
} from '../device-row-store.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

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
  const readDeviceStore = vi.fn(async (id: number) => ({ ...deviceStores[id] }))
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore,
    readDeviceStoreBatch: vi.fn(
      async (ids: readonly number[]) =>
        new Map(await Promise.all(ids.map(async (id) => [id, await readDeviceStore(id)] as const))),
    ),
    listDeviceStoreIds: vi.fn(async () => Object.keys(deviceStores).map(Number)),
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
    clearDeviceStore: vi.fn(async (id: number) => {
      delete deviceStores[id]
    }),
    readDeviceRuntimeState: vi.fn(async () => ({})),
    writeDeviceRuntimeState: vi.fn(async () => {}),
    clearDeviceRuntimeState: vi.fn(async () => {}),
  }
}

interface Harness {
  readonly provider: IDeviceManagerProvider
  readonly events: SystemEvent[]
  readonly backend: DeviceRowBackend
}

async function setup(): Promise<Harness> {
  const addon = new DeviceManagerAddon()
  const events: SystemEvent[] = []
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      events.push(event)
    },
    subscribe: () => () => {},
    getRecent: () => [],
    // Fake → interface: the bus has typed `emit`/`subscribe` overloads a plain
    // object literal cannot state. Same boundary the sibling specs use.
  } as unknown as IEventBus
  const { api: settingsStoreApi } = await makeSettingsStoreApi()
  const ctx = {
    api: { settingsStore: settingsStoreApi },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp',
    settings: makeSettings(),
    records: await makeRecordsAccessForOwner('device-manager'),
    kernel: { deviceRegistry: new DeviceRegistry() },
  }
  // Fake context → interface: the documented boundary of this harness family.
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  const providers: readonly ProviderRegistration[] | undefined = Array.isArray(initResult)
    ? initResult
    : initResult?.providers
  const provider = providers?.[0]?.provider
  if (provider === undefined || !('registerDevice' in provider)) {
    throw new Error('not the device-manager provider')
  }
  // Registration → its provider interface, as in `device-ghost-rows.spec.ts`.
  return {
    provider: provider as IDeviceManagerProvider,
    events,
    backend: deviceRowBackendOf(settingsStoreApi),
  }
}

const ADDON = 'provider-gree'

async function register(h: Harness, id: number): Promise<void> {
  await h.provider.registerDevice({
    addonId: ADDON,
    stableId: 'unit-1',
    id,
    type: DeviceType.Climate,
    name: 'Living AC',
    parentDeviceId: null,
    features: [],
    config: {},
  })
}

describe('registerDevice keeps the stored room id', () => {
  it('a room record that does not resolve does not null the id on re-registration', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId: 'unit-1' })
    await register(h, id)
    const raw = await h.backend.get({ collection: DEVICE_ROWS_COLLECTION, key: String(id) })
    if (typeof raw !== 'object' || raw === null) throw new Error('fixture')
    await h.backend.set({
      collection: DEVICE_ROWS_COLLECTION,
      key: String(id),
      value: { ...raw, locationId: 'room_unresolved' },
    })

    await register(h, id)

    const after = await h.backend.get({ collection: DEVICE_ROWS_COLLECTION, key: String(id) })
    expect(after).toMatchObject({ locationId: 'room_unresolved' })
  })
})
