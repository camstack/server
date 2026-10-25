/**
 * Ghost rows: the two ways the registry grew a device nobody owns (D376).
 *
 * Both were live on the hub on 2026-09-05, both with `config: {}`:
 *
 * - **105 "Camera studio"** — deleted the day before. `removeDevice`
 *   deleted the row and cleared its config, and a write already in flight from
 *   the still-live device object put the row BACK: `registerDevice` upserts
 *   unconditionally and does not write config. Result: a row with the right
 *   name, no configuration, `online: true`, and a provider that failed its Zod
 *   schema on `host`/`password` at every boot.
 * - **4370 `__camstack_probe_nonexistent__`** — a reservation minted by
 *   `allocateDeviceId` for a stableId nobody owns, never registered, handed to
 *   a provider's restore at every boot as though it were a device
 *   (`No device class registered for restored type`).
 *
 * Harness style mirrors `migrate-device-wiring.spec.ts` — real addon, real
 * sqlite-backed row store, fake api surfaces.
 */
import type {
  AddonContext,
  IDevice,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  SystemEvent,
} from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

class FakeDevice {
  online = true
  parentDeviceId: number | null = null
  features: readonly string[] = []
  type = 'camera'
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
    id: number,
  ) {
    this.id = id
    this.name = stableId
  }
  removeDevice = vi.fn(async () => {})
}

/** Fake → interface: the one documented type boundary this harness needs. */
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
    readDeviceRuntimeState: vi.fn(async (id: number) => ({ ...runtimeStores[id] })),
    writeDeviceRuntimeState: vi.fn(async (id: number, data: Record<string, unknown>) => {
      runtimeStores[id] = { ...data }
    }),
    clearDeviceRuntimeState: vi.fn(async (id: number) => {
      delete runtimeStores[id]
    }),
  }
}

interface Harness {
  readonly provider: IDeviceManagerProvider
  readonly registry: DeviceRegistry
  readonly logger: IScopedLogger
  readonly events: SystemEvent[]
  /** Runs synchronously inside every `emit`, before the emitter continues. */
  onEmit: ((event: SystemEvent) => void) | null
}

async function setup(): Promise<Harness> {
  const addon = new DeviceManagerAddon()
  const settings = makeSettings()
  const events: SystemEvent[] = []
  const hooks: { onEmit: ((event: SystemEvent) => void) | null } = { onEmit: null }
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      events.push(event)
      hooks.onEmit?.(event)
    },
    subscribe: () => () => {},
    getRecent: () => [],
    // Fake → interface: the bus has typed `emit`/`subscribe` overloads a plain
    // object literal cannot state. Same boundary the sibling specs use.
  } as unknown as IEventBus
  const registry = new DeviceRegistry()
  const logger = makeLogger()
  const { api: settingsStoreApi } = await makeSettingsStoreApi()

  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: settingsStoreApi },
    id: 'device-manager',
    logger,
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
  const provider = first.provider
  if (!('removeDevice' in provider)) throw new Error('not the device-manager provider')
  return Object.assign(hooks, {
    provider: provider as IDeviceManagerProvider,
    registry,
    logger,
    events,
  })
}

const ADDON = 'provider-reolink'

async function bringUpCamera(
  h: Harness,
  stableId: string,
  config: Record<string, unknown>,
): Promise<number> {
  const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId })
  await h.provider.persistConfig({ deviceId: id, data: config })
  const device = new FakeDevice(stableId, id)
  h.registry.register(ADDON, asDevice(device))
  await h.provider.registerDevice({
    addonId: ADDON,
    stableId,
    id,
    type: 'camera',
    name: 'Camera studio',
    parentDeviceId: null,
    features: [],
    config: {},
  })
  return id
}

describe('a removal cannot be undone by a write already in flight', () => {
  it('refuses the late registerDevice that resurrected 105', async () => {
    const h = await setup()
    const id = await bringUpCamera(h, 'studio-cam', { host: '192.168.10.40', password: 'x' })

    await h.provider.removeDevice({ deviceId: id })

    // The still-live device object re-registers as its runner tears down.
    await expect(
      h.provider.registerDevice({
        addonId: ADDON,
        stableId: 'studio-cam',
        id,
        type: 'camera',
        name: 'Camera studio',
        parentDeviceId: null,
        features: [],
        config: {},
      }),
    ).rejects.toThrow(/removed/i)

    // The live object outliving its row is the whole premise — what must NOT
    // survive is the persisted shell.
    expect(await h.provider.loadMeta({ deviceId: id })).toBeNull()
    expect(await h.provider.listPersistedByAddon({ addonId: ADDON })).toEqual([])
  })

  it('refuses the late allocateDeviceId for the same identity', async () => {
    const h = await setup()
    const id = await bringUpCamera(h, 'studio-cam', { host: '192.168.10.40', password: 'x' })
    await h.provider.removeDevice({ deviceId: id })

    await expect(
      h.provider.allocateDeviceId({ addonId: ADDON, stableId: 'studio-cam' }),
    ).rejects.toThrow(/removed/i)
    expect(await h.provider.listPersistedByAddon({ addonId: ADDON })).toEqual([])
  })

  it('leaves no row and no config behind', async () => {
    const h = await setup()
    const id = await bringUpCamera(h, 'studio-cam', { host: '192.168.10.40', password: 'x' })

    await h.provider.removeDevice({ deviceId: id })

    expect(await h.provider.loadMeta({ deviceId: id })).toBeNull()
    expect(await h.provider.loadConfig({ deviceId: id })).toEqual({})
  })
})

describe('a reservation is not a device', () => {
  it('never hands a never-registered, config-less row to a provider restore', async () => {
    const h = await setup()
    const real = await bringUpCamera(h, 'studio-cam', { host: '192.168.10.40', password: 'x' })
    // What an external caller did to mint 4370: ask for an id for a stableId
    // nobody owns, and never register it.
    const { id: ghost } = await h.provider.allocateDeviceId({
      addonId: ADDON,
      stableId: '__camstack_probe_nonexistent__',
    })

    const rows = await h.provider.listPersistedByAddon({ addonId: ADDON })

    expect(rows.map((r) => r.id)).toEqual([real])
    expect(rows.some((r) => r.id === ghost)).toBe(false)
  })

  it('still hands over a reservation that carries config — a create() that crashed mid-flight', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId: 'half-made' })
    await h.provider.persistConfig({ deviceId: id, data: { host: '192.168.10.41' } })

    const rows = await h.provider.listPersistedByAddon({ addonId: ADDON })

    expect(rows.map((r) => r.id)).toContain(id)
  })
})

describe('a device without configuration is never reported online', () => {
  it('reports a config-less top-level row offline in listAll and getDevice', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId: 'shell-cam' })
    await h.provider.registerDevice({
      addonId: ADDON,
      stableId: 'shell-cam',
      id,
      type: 'camera',
      name: 'Camera studio',
      parentDeviceId: null,
      features: [],
      config: {},
    })

    const all = await h.provider.listAll({})
    expect(all.find((d) => d.id === id)?.online).toBe(false)
    expect((await h.provider.getDevice({ deviceId: id }))?.online).toBe(false)
  })

  it('still reports a configured persisted row online', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId: 'real-cam' })
    await h.provider.persistConfig({ deviceId: id, data: { host: '192.168.10.42' } })
    await h.provider.registerDevice({
      addonId: ADDON,
      stableId: 'real-cam',
      id,
      type: 'camera',
      name: 'Real',
      parentDeviceId: null,
      features: [],
      config: {},
    })

    const all = await h.provider.listAll({})
    expect(all.find((d) => d.id === id)?.online).toBe(true)
  })
})

/**
 * `DeviceUnregistered` MEANS DELETED — the notification centre prunes a device
 * from every rule on it (`addon-post-analysis/.../device-prune-runner.ts`), and
 * its second read is `getDevice === null`. Both halves hold only if the event
 * fires AFTER the row is gone, and never on a path that keeps the row.
 */
describe('DeviceUnregistered fires only once the row is gone', () => {
  it('removeDevice emits it once, and the persisted row is already gone at that moment', async () => {
    const h = await setup()
    const id = await bringUpCamera(h, 'studio-cam', { host: '192.168.10.40' })
    let rowAtEmission: Promise<unknown> | null = null
    h.onEmit = (event) => {
      if (event.category === EventCategory.DeviceUnregistered) {
        rowAtEmission = h.provider.loadMeta({ deviceId: id })
      }
    }
    await h.provider.removeDevice({ deviceId: id })
    const unregistered = h.events.filter((e) => e.category === EventCategory.DeviceUnregistered)
    expect(unregistered).toHaveLength(1)
    expect(unregistered[0]?.data['deviceId']).toBe(id)
    expect(rowAtEmission).not.toBeNull()
    expect(await rowAtEmission).toBeNull()
  })

  it('in the remove() order (live object decommissioned first) getDevice answers null at emission', async () => {
    const h = await setup()
    const id = await bringUpCamera(h, 'studio-cam', { host: '192.168.10.40' })
    let deviceAtEmission: Promise<unknown> | null = null
    h.onEmit = (event) => {
      if (event.category === EventCategory.DeviceUnregistered) {
        deviceAtEmission = h.provider.getDevice({ deviceId: id })
      }
    }
    // `DeviceManagerApi.remove` = `decommission` (drops the live object) then
    // `removeDevice` — the order `device-cap-proxy.ts` runs.
    h.registry.remove(id)
    await h.provider.removeDevice({ deviceId: id })
    expect(await deviceAtEmission).toBeNull()
  })
})
