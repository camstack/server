/**
 * D1033 — a provider names the role of the devices it registers (a Gree unit
 * is `climate-ac`, a radiator valve `climate-radiator`). That role lands on a
 * row that has NONE yet — a device registered before the role existed gets
 * it at its next registration, with no migration — and never replaces a role
 * that is already there, which may be the operator's.
 *
 * Harness: the real addon over a real sqlite-backed row store, as in
 * `device-ghost-rows.spec.ts`.
 */
import type {
  AddonContext,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  SystemEvent,
} from '@camstack/types'
import { DeviceRole, DeviceType, EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
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
  return { provider: provider as IDeviceManagerProvider, events }
}

const ADDON = 'provider-gree'

async function register(h: Harness, id: number, role: string | null | undefined): Promise<void> {
  await h.provider.registerDevice({
    addonId: ADDON,
    stableId: 'unit-1',
    id,
    type: DeviceType.Climate,
    name: 'Living AC',
    parentDeviceId: null,
    ...(role !== undefined ? { role } : {}),
    features: [],
    config: {},
  })
}

async function roleOf(h: Harness, id: number): Promise<string | null | undefined> {
  return (await h.provider.getDevice({ deviceId: id }))?.role
}

describe('registerDevice fills a missing role (D1033)', () => {
  it('a row without a role takes the role the provider names, and says so', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId: 'unit-1' })
    await register(h, id, undefined)
    expect((await roleOf(h, id)) ?? null).toBeNull()

    await register(h, id, DeviceRole.ClimateAc)
    expect(await roleOf(h, id)).toBe(DeviceRole.ClimateAc)
    expect(h.events).toContainEqual(
      expect.objectContaining({
        category: EventCategory.DeviceMetaChanged,
        data: { deviceId: id, field: 'role', value: DeviceRole.ClimateAc },
      }),
    )
  })

  it('never replaces a role the row already carries (the operator may have set it)', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId: 'unit-1' })
    await register(h, id, undefined)
    await h.provider.setRole({ deviceId: id, role: DeviceRole.ClimateHeatPumpCircuit })

    await register(h, id, DeviceRole.ClimateAc)
    expect(await roleOf(h, id)).toBe(DeviceRole.ClimateHeatPumpCircuit)
  })

  it('a provider that names no role leaves the row alone', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId: 'unit-1' })
    await register(h, id, DeviceRole.ClimateAc)
    await register(h, id, null)
    expect(await roleOf(h, id)).toBe(DeviceRole.ClimateAc)
  })
})
