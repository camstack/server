/**
 * The create write persists the config before the device class exists, so the
 * secret paths its schema declares are unknown to the door and the password lands
 * raw. The FIRST registration brings the paths and moves the raw value into the
 * keychain; a re-registration of an older raw row converts nothing (D787 no
 * silent migration).
 *
 * Harness: the real addon over a real sqlite-backed row store, as in
 * `register-role-fill.spec.ts`, plus an in-memory keychain.
 */
import type {
  AddonContext,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  SystemEvent,
} from '@dominevo/types'
import {
  createSecretsAccess,
  DeviceType,
  isSecretMarker,
  type KeychainResolveResult,
  type KeychainTransport,
} from '@dominevo/types'
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
      // The real store MERGES a patch (`setAll` semantics); only the blob a test seeds replaces.
      deviceStores[id] = { ...deviceStores[id], ...data }
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
  readonly keychain: Map<string, string>
  readonly settings: ReturnType<typeof makeSettings>
}

function makeKeychain(values: Map<string, string>): KeychainTransport {
  return {
    async put({ ref, value }) {
      values.set(ref, value)
      return { ref, version: 1 }
    },
    async resolve({ refs }) {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const v = values.get(ref)
        out[ref] = v === undefined ? { kind: 'missing' } : { kind: 'value', value: v, version: 1 }
      }
      return out
    },
    async delete({ refs }) {
      for (const r of refs) values.delete(r)
      return { deleted: refs.length }
    },
    async getState() {
      return { state: 'ready' }
    },
  }
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
  const keychain = new Map<string, string>()
  const settings = makeSettings()
  const { api: settingsStoreApi } = await makeSettingsStoreApi()
  const ctx = {
    api: { settingsStore: settingsStoreApi },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp',
    settings,
    secrets: createSecretsAccess({
      owner: 'device-manager',
      transport: makeKeychain(keychain),
      transportForOwner: () => makeKeychain(keychain),
    }),
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
  return { provider: provider as IDeviceManagerProvider, events, keychain, settings }
}

const ADDON = 'provider-reolink'

async function register(h: Harness, id: number): Promise<void> {
  await h.provider.registerDevice({
    addonId: ADDON,
    stableId: 'cam-1',
    id,
    type: DeviceType.Camera,
    name: 'Cam',
    parentDeviceId: null,
    features: [],
    config: {},
    secretConfigPaths: ['password'],
  })
}

describe('the first registration secures a password the create write left raw', () => {
  it('create persists raw (no paths yet) then first registerDevice stores a marker + keychain value', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId: 'cam-1' })
    await h.provider.persistConfig({ deviceId: id, data: { host: 'h', password: 'x' } })
    expect((await h.settings.readDeviceStore(id))['password']).toBe('x')

    await register(h, id)

    const stored = await h.settings.readDeviceStore(id)
    expect(isSecretMarker(stored['password'])).toBe(true)
    expect([...h.keychain.values()]).toEqual(['x'])
    expect(stored['host']).toBe('h')
  })

  it('a RE-registration of a row that is already registered and raw stays raw (no silent migration)', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId: 'cam-1' })
    await register(h, id)
    await h.settings.writeDeviceStore(id, { host: 'h', password: 'legacy' })

    await register(h, id)

    expect((await h.settings.readDeviceStore(id))['password']).toBe('legacy')
    expect(h.keychain.size).toBe(0)
  })
})
