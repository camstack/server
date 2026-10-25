/**
 * Lifecycle tests for the per-device `display` override + `roleDisplayDefaults`
 * store on the device-manager addon.
 *
 * Mirrors the harness style of `device-manager.addon.spec.ts` (in-memory
 * settings, fake device registry) but stays self-contained. Exercises:
 *   - setDisplay persists → getDevice projection carries `display`
 *   - setDisplay(null) removes the key entirely (no `display: undefined`)
 *   - preservation across re-register (same stableId)
 *   - write-time unit normalization ('fahrenheit' → '°F')
 *   - getRoleDisplayDefaults / setRoleDisplayDefaults round-trip (full replace)
 */

import type {
  AddonContext,
  IDevice,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
// Import DeviceRegistry from source (not the `@camstack/system` barrel) so the
// suite runs without a built dist — the barrel transitively pulls node-only
// deps (otplib) that vitest doesn't need for this test.
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import type { FakeSettingsStore } from './settings-store-api.js'
import { makeSettingsStoreApi, readDeviceRow } from './settings-store-api.js'

let fakeIdSeq = 500

class FakeDevice {
  online = true
  parentDeviceId: number | null = null
  features: readonly string[] = []
  type = 'sensor'
  name: string
  readonly id: number
  readonly config = {
    entries: () => [],
    get: () => undefined,
    set: vi.fn(async () => {}),
    setAll: vi.fn(async () => {}),
    onChange: () => () => {},
  }
  constructor(
    readonly stableId: string,
    id?: number,
  ) {
    this.id = id ?? fakeIdSeq++
    this.name = stableId
  }
  removeDevice = vi.fn(async () => {})
}

function asDevice(d: FakeDevice): IDevice {
  return d as unknown as IDevice
}

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
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
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

async function setup(): Promise<{
  provider: IDeviceManagerProvider
  settings: ReturnType<typeof makeSettings>
  store: FakeSettingsStore
  registry: DeviceRegistry
}> {
  const addon = new DeviceManagerAddon()
  const settings = makeSettings()
  const bus: IEventBus = {
    emit: vi.fn(),
    subscribe: () => () => {},
    getRecent: () => [],
  } as unknown as IEventBus
  const registry = new DeviceRegistry()
  const store = await makeSettingsStoreApi()
  const settingsStoreApi = store.api
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: settingsStoreApi },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp',
    settings,
    records,
    kernel: { deviceRegistry: registry },
  }
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  let providers: readonly ProviderRegistration[] | undefined
  if (Array.isArray(initResult)) providers = initResult
  else if (initResult) providers = initResult.providers
  const first = providers?.[0]
  if (!first) throw new Error('no provider registrations')
  return { provider: first.provider as IDeviceManagerProvider, settings, store, registry }
}

describe('setDisplay lifecycle', () => {
  it('persists a display override and projects it via getDevice', async () => {
    const { provider, registry } = await setup()
    const dev = new FakeDevice('temp-1')
    registry.register('home-assistant', asDevice(dev))
    await provider.allocateDeviceId({ addonId: 'home-assistant', stableId: 'temp-1' })
    await provider.registerDevice({
      addonId: 'home-assistant',
      stableId: 'temp-1',
      id: dev.id,
      type: 'sensor',
      name: 'Temp',
      parentDeviceId: null,
      config: {},
    })

    await provider.setDisplay({
      deviceId: dev.id,
      display: { unit: '°F', precision: 0, icon: 'thermometer' },
    })

    const info = await provider.getDevice({ deviceId: dev.id })
    expect(info).not.toBeNull()
    expect(info!.display).toEqual({ unit: '°F', precision: 0, icon: 'thermometer' })
  })

  it('setDisplay(null) removes the key entirely (no display:undefined)', async () => {
    const { provider, store, registry } = await setup()
    const dev = new FakeDevice('temp-2')
    registry.register('home-assistant', asDevice(dev))
    await provider.allocateDeviceId({ addonId: 'home-assistant', stableId: 'temp-2' })
    await provider.registerDevice({
      addonId: 'home-assistant',
      stableId: 'temp-2',
      id: dev.id,
      type: 'sensor',
      name: 'Temp',
      parentDeviceId: null,
      config: {},
    })
    await provider.setDisplay({ deviceId: dev.id, display: { unit: '°F' } })
    expect((await readDeviceRow(store, dev.id)).display).toEqual({ unit: '°F' })

    await provider.setDisplay({ deviceId: dev.id, display: null })
    const row = await readDeviceRow(store, dev.id)
    // A cleared override is a NULL column, which is what "absent" means in a
    // row. The blob shape spelled the same thing by deleting the key.
    expect(row.display).toBeNull()
    const info = await provider.getDevice({ deviceId: dev.id })
    expect(info!.display).toBeUndefined()
  })

  it('normalizes the override unit at write time (fahrenheit → °F)', async () => {
    const { provider, store, registry } = await setup()
    const dev = new FakeDevice('temp-3')
    registry.register('home-assistant', asDevice(dev))
    await provider.allocateDeviceId({ addonId: 'home-assistant', stableId: 'temp-3' })
    await provider.registerDevice({
      addonId: 'home-assistant',
      stableId: 'temp-3',
      id: dev.id,
      type: 'sensor',
      name: 'Temp',
      parentDeviceId: null,
      config: {},
    })

    await provider.setDisplay({
      deviceId: dev.id,
      display: { unit: 'fahrenheit', perCap: { 'numeric-sensor': { unit: 'celsius' } } },
    })
    const row = await readDeviceRow(store, dev.id)
    expect(row.display).toEqual({ unit: '°F', perCap: { 'numeric-sensor': { unit: '°C' } } })
  })

  it('preserves the display override across a re-register (same stableId)', async () => {
    const { provider, store, registry } = await setup()
    const dev = new FakeDevice('temp-4')
    registry.register('home-assistant', asDevice(dev))
    await provider.allocateDeviceId({ addonId: 'home-assistant', stableId: 'temp-4' })
    await provider.registerDevice({
      addonId: 'home-assistant',
      stableId: 'temp-4',
      id: dev.id,
      type: 'sensor',
      name: 'Temp',
      parentDeviceId: null,
      config: {},
    })
    await provider.setDisplay({ deviceId: dev.id, display: { unit: '°F', hidden: true } })

    // Re-register (boot / re-sync) must not clobber the operator override.
    await provider.registerDevice({
      addonId: 'home-assistant',
      stableId: 'temp-4',
      id: dev.id,
      type: 'sensor',
      name: 'Temp (refreshed)',
      parentDeviceId: null,
      config: {},
    })
    expect((await readDeviceRow(store, dev.id)).display).toEqual({ unit: '°F', hidden: true })
  })
})

describe('roleDisplayDefaults store', () => {
  it('round-trips via get/setRoleDisplayDefaults (full replace)', async () => {
    const { provider } = await setup()
    expect(await provider.getRoleDisplayDefaults({})).toEqual({ defaults: {} })

    await provider.setRoleDisplayDefaults({
      defaults: {
        'temperature-sensor': { unit: 'fahrenheit', precision: 1 },
        'pressure-sensor': { unit: 'inHg' },
      },
    })
    const first = await provider.getRoleDisplayDefaults({})
    // Units are normalized on write.
    expect(first.defaults['temperature-sensor']).toEqual({ unit: '°F', precision: 1 })
    expect(first.defaults['pressure-sensor']).toEqual({ unit: 'inHg' })

    // Full replace — a subsequent write drops the prior keys.
    await provider.setRoleDisplayDefaults({
      defaults: { 'temperature-sensor': { unit: 'K' } },
    })
    const second = await provider.getRoleDisplayDefaults({})
    expect(second.defaults).toEqual({ 'temperature-sensor': { unit: 'K' } })
  })
})
