/**
 * Unit tests for DeviceManagerAddon.
 *
 * Strategy:
 *  - Persistence methods use an in-memory settings store (no SQLite).
 *  - Live query / runtime methods use a real DeviceRegistry with fake device stubs.
 *  - Null-registry (fallback) path exercised by passing registry=null.
 *
 * Note: FakeDevice / FakeCameraDevice are plain classes cast to IDevice at
 * registry.register() call sites — the addon only accesses a subset of IDevice
 * (stableId, type, name, online, features, parentDeviceId, config, removeDevice).
 */

import { DeviceRegistry } from '@camstack/system'
import type {
  AddonContext,
  IDevice,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  StreamSourceEntry,
} from '@camstack/types'
import { consumablesCapability, DeviceType } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { z } from 'zod'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import type { FakeSettingsStore } from './settings-store-api.js'
import {
  deviceRowWrites,
  makeSettingsStoreApi,
  readDeviceRow,
  readDeviceRows,
} from './settings-store-api.js'

// ── Fake devices ─────────────────────────────────────────────────────────────

// The addon only accesses: stableId, type, name, online, features,
// parentDeviceId, config.entries(), config.setAll(), removeDevice().
// We cast to IDevice at call sites to avoid implementing the full interface.

function makeConfigStore(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial }
  return {
    entries: () =>
      Object.entries(values).map(([key, value]) => ({ key, value, description: undefined })),
    get: (k: string) => values[k],
    set: vi.fn(async (k: string, v: unknown) => {
      values[k] = v
    }),
    setAll: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(values, patch)
    }),
    onChange: () => () => {},
    _values: values,
  }
}

let fakeDeviceIdSeq = 100

class FakeDevice {
  online = true
  parentDeviceId: number | null
  features: readonly string[] = []
  type = 'camera'
  name: string
  readonly id: number
  readonly config

  constructor(
    readonly stableId: string,
    configValues: Record<string, unknown> = {},
    options: { parentDeviceId?: number | null; id?: number } = {},
  ) {
    this.id = options.id ?? fakeDeviceIdSeq++
    this.name = (configValues['name'] as string) ?? stableId
    this.parentDeviceId = options.parentDeviceId ?? null
    this.config = makeConfigStore(configValues)
  }

  removeDevice = vi.fn(async () => {})
}

class FakeCameraDevice extends FakeDevice {
  getStreamSources = vi.fn(
    async (): Promise<StreamSourceEntry[]> => [
      { id: 'main', label: 'Main', protocol: 'rtsp', url: 'rtsp://cam/main', profileHint: 'high' },
      { id: 'sub', label: 'Sub', protocol: 'rtsp', url: 'rtsp://cam/sub', profileHint: 'low' },
    ],
  )
}

function asDevice(d: FakeDevice): IDevice {
  return d as unknown as IDevice
}

/**
 * A FakeDevice that carries a `feature-probe` runtime-state slice, so the
 * `toDeviceInfo` `probed` derivation can be exercised across the
 * 0 / >0 / absent cases. `runtimeState.getCapState('feature-probe')`
 * returns the configured slice (or `undefined` to model "no slice").
 */
class FakeDeviceWithProbe extends FakeDevice {
  readonly runtimeState: { getCapState: (capName: string) => Record<string, unknown> | undefined }
  constructor(stableId: string, featureProbeSlice: Record<string, unknown> | undefined) {
    super(stableId)
    this.runtimeState = {
      getCapState: (capName: string) =>
        capName === 'feature-probe' ? featureProbeSlice : undefined,
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeEventBus() {
  const emitted: unknown[] = []
  const bus: IEventBus = {
    emit: (e: unknown) => emitted.push(e),
    subscribe: () => () => {},
    getRecent: () => [],
  } as unknown as IEventBus
  return { bus, emitted }
}

function makeSettings() {
  let addonStore: Record<string, unknown> = {}
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

// TypeScript cannot track mutations of variables through closures, so we use
// a single-element array as a mutable box that TS can reason about.
interface DeviceStateProviderLike {
  setCapSlice: (input: {
    deviceId: number
    capName: string
    slice: Record<string, unknown>
  }) => Promise<void>
  getCapSlice: (input: {
    deviceId: number
    capName: string
  }) => Promise<Record<string, unknown> | null>
}

async function setup(registryOrNull?: DeviceRegistry | null): Promise<{
  provider: IDeviceManagerProvider
  deviceState: DeviceStateProviderLike
  settings: ReturnType<typeof makeSettings>
  store: FakeSettingsStore
  registry: DeviceRegistry | null
  emitted: unknown[]
}> {
  const addon = new DeviceManagerAddon()
  const settings = makeSettings()
  const { bus: eventBus, emitted } = makeEventBus()
  const registry = registryOrNull !== undefined ? registryOrNull : new DeviceRegistry()

  const store = await makeSettingsStoreApi()
  const settingsStoreApi = store.api
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: settingsStoreApi },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus,
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
  if (!first) {
    throw new Error('DeviceManagerAddon did not return provider registrations')
  }

  const provider = first.provider as IDeviceManagerProvider
  // providers[1] is the `deviceState` cap — the canonical cross-process
  // runtime-state write/read surface backing the hub mirror.
  const deviceStateReg = providers?.[1]
  if (!deviceStateReg) {
    throw new Error('DeviceManagerAddon did not return a deviceState provider registration')
  }
  const deviceState = deviceStateReg.provider as unknown as DeviceStateProviderLike
  return { provider, deviceState, settings, store, registry, emitted }
}

/** Collect `device.provisioned` events (export trigger) from a captured bus. */
function provisionedFingerprints(emitted: readonly unknown[]): string[] {
  const out: string[] = []
  for (const e of emitted) {
    if (
      e &&
      typeof e === 'object' &&
      'category' in e &&
      (e as { category: unknown }).category === 'device.provisioned'
    ) {
      const data = (e as { data?: { fingerprint?: unknown } }).data
      if (data && typeof data.fingerprint === 'string') out.push(data.fingerprint)
    }
  }
  return out
}

/**
 * Variant of `setup` that injects a capability registry whose
 * `waitForProvider` resolves to a caller-supplied value. Used to exercise
 * the device-adoption proxy path, which resolves its provider through
 * `capabilityRegistry.waitForProvider('device-adoption', addonId, …)`.
 */
async function setupWithCapRegistry(waitForProviderResult: unknown): Promise<{
  provider: IDeviceManagerProvider
  waitForProvider: ReturnType<typeof vi.fn>
  settings: ReturnType<typeof makeSettings>
  store: FakeSettingsStore
  registry: DeviceRegistry
}> {
  const addon = new DeviceManagerAddon()
  const settings = makeSettings()
  const { bus: eventBus } = makeEventBus()
  const registry = new DeviceRegistry()
  const waitForProvider = vi.fn(async () => waitForProviderResult)

  const store = await makeSettingsStoreApi()
  const settingsStoreApi = store.api
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: settingsStoreApi },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus,
    addonConfig: {},
    dataDir: '/tmp',
    settings,
    records,
    kernel: {
      deviceRegistry: registry,
      capabilityRegistry: {
        waitForProvider,
        // The `remove` teardown (exercised by resetToSource) clears hub-local
        // natives — stub the methods the real CapabilityRegistry provides.
        unregisterAllNativeForDevice: vi.fn(),
        getNativeProvider: vi.fn(() => undefined),
        // The addon installs the claimed-status overlay at init (D663, S3).
        setStatusOverlay: vi.fn(),
      },
    },
  }

  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  let providers: readonly ProviderRegistration[] | undefined
  if (Array.isArray(initResult)) providers = initResult
  else if (initResult) providers = initResult.providers
  const first = providers?.[0]
  if (!first) {
    throw new Error('DeviceManagerAddon did not return provider registrations')
  }
  return {
    provider: first.provider as IDeviceManagerProvider,
    waitForProvider,
    settings,
    store,
    registry,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('DeviceManagerAddon', () => {
  // ── Persistence ─────────────────────────────────────────────────────────────

  describe('registerDevice', () => {
    it('adds stableId to deviceIndex and writes meta + config', async () => {
      const { provider, settings, store } = await setup()

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'Front Door',
        parentDeviceId: null,
        config: { url: 'rtsp://10.0.0.1' },
      })

      // `registered` is what `deviceIndex` membership used to say. It is the
      // only bit of the index that was not derivable from the row itself.
      expect(await readDeviceRow(store, id)).toMatchObject({
        deviceId: id,
        addonId: 'rtsp',
        stableId: 'cam-1',
        type: 'camera',
        name: 'Front Door',
        parentDeviceId: null,
        features: [],
        registered: true,
      })
      // Device store is keyed by the numeric deviceId after the Phase 2 migration.
      expect(settings.writeDeviceStore).toHaveBeenCalledWith(id, { url: 'rtsp://10.0.0.1' })
    })

    it('does not duplicate the device when called twice for the same stableId', async () => {
      const { provider, store } = await setup()

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        config: {},
      })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        config: {},
      })

      // The blob shape could grow a duplicate stableId inside `deviceIndex`;
      // the row shape cannot represent one — `(addonId, stableId)` resolves to
      // exactly the row the second register updated in place.
      const rows = await readDeviceRows(store)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ deviceId: id, stableId: 'cam-1', registered: true })
    })
  })

  describe('userNamed name-precedence (#17)', () => {
    // Read the most-recently-persisted meta row for a numeric device id.
    // The meta map is keyed by `String(id)`; addonId/stableId are fields.
    const readMetaRow = async (
      store: FakeSettingsStore,
      id: number,
    ): Promise<Record<string, unknown>> => {
      const row = await readDeviceRow(store, id)
      if (Object.keys(row).length === 0) throw new Error(`no device row for id=${id}`)
      return row
    }

    it('adopts a fresh provider name for an auto-named device on re-register (self-heal, not frozen)', async () => {
      const { provider, store } = await setup()
      const { id } = await provider.allocateDeviceId({ addonId: 'ecowitt', stableId: 'wh65-temp' })

      // First registration with a generic provider name → stamped userNamed:false.
      await provider.registerDevice({
        addonId: 'ecowitt',
        stableId: 'wh65-temp',
        id,
        type: 'generic',
        name: 'Outdoor',
        parentDeviceId: null,
        config: {},
      })
      let meta = await readMetaRow(store, id)
      expect(meta.name).toBe('Outdoor')
      expect(meta.userNamed).toBe(false)

      // A later boot resolves the specific name — it MUST propagate, not freeze.
      await provider.registerDevice({
        addonId: 'ecowitt',
        stableId: 'wh65-temp',
        id,
        type: 'generic',
        name: 'Outdoor Temperature',
        parentDeviceId: null,
        config: {},
      })
      meta = await readMetaRow(store, id)
      expect(meta.name).toBe('Outdoor Temperature')
      expect(meta.userNamed).toBe(false)
    })

    it('preserves an operator rename (setName) against a fresh provider name', async () => {
      const { provider, store } = await setup()
      const { id } = await provider.allocateDeviceId({ addonId: 'ecowitt', stableId: 'wh65-temp' })
      await provider.registerDevice({
        addonId: 'ecowitt',
        stableId: 'wh65-temp',
        id,
        type: 'generic',
        name: 'Outdoor',
        parentDeviceId: null,
        config: {},
      })

      // Operator renames → userNamed:true.
      await provider.setName({ deviceId: id, name: 'Garden Temp' })
      expect((await readMetaRow(store, id)).userNamed).toBe(true)

      // Provider re-derives "Outdoor Temperature" on the next boot — operator wins.
      await provider.registerDevice({
        addonId: 'ecowitt',
        stableId: 'wh65-temp',
        id,
        type: 'generic',
        name: 'Outdoor Temperature',
        parentDeviceId: null,
        config: {},
      })
      const meta = await readMetaRow(store, id)
      expect(meta.name).toBe('Garden Temp')
      expect(meta.userNamed).toBe(true)
    })

    it('preserves a legacy non-placeholder name with no userNamed flag and stamps it forward (migration safety)', async () => {
      const { provider, store } = await setup()
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-legacy' })

      // Simulate a row persisted BEFORE the flag existed: a custom name, and a
      // `userNamed` column that is NULL — which is how a row that predates the
      // flag reads back, and which `decodeDeviceRow` turns into "absent".
      await store.backend.updateWhere({
        collection: 'device-manager:devices',
        filter: { where: { id: String(id) } },
        data: { name: 'My Camera', userNamed: null },
      })

      // Provider re-registers with a DIFFERENT auto name — legacy name must stay.
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-legacy',
        id,
        type: 'camera',
        name: 'Camera (Auto)',
        parentDeviceId: null,
        config: {},
      })
      const meta = await readMetaRow(store, id)
      expect(meta.name).toBe('My Camera')
      // The PRESERVE decision is stamped forward so subsequent reconciles are explicit.
      expect(meta.userNamed).toBe(true)
    })

    it('takes the fresh name for a legacy row still on the stableId placeholder', async () => {
      const { provider, store } = await setup()
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      // allocateDeviceId seeded name === stableId ('cam-1') with no flag — pure placeholder.
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'Front Door',
        parentDeviceId: null,
        config: {},
      })
      const meta = await readMetaRow(store, id)
      expect(meta.name).toBe('Front Door')
      expect(meta.userNamed).toBe(false)
    })
  })

  describe('export fingerprint + DeviceProvisioned', () => {
    it('persists an exportFingerprint and emits DeviceProvisioned on first registration', async () => {
      const { provider, emitted, store } = await setup()
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        features: ['motion-trigger', 'two-way-audio'],
        config: {},
      })

      const fps = provisionedFingerprints(emitted)
      expect(fps).toHaveLength(1)
      expect(fps[0]).toMatch(/^[0-9a-f]{64}$/)
      // The persisted row carries the SAME fingerprint.
      expect((await readDeviceRow(store, id)).exportFingerprint).toBe(fps[0])
    })

    it('does NOT re-emit DeviceProvisioned when the feature set is unchanged', async () => {
      const { provider, emitted } = await setup()
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      const input = {
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        features: ['motion-trigger'],
        config: {},
      }
      await provider.registerDevice(input)
      await provider.registerDevice(input)
      expect(provisionedFingerprints(emitted)).toHaveLength(1)
    })

    it('re-emits DeviceProvisioned with a new fingerprint when features change', async () => {
      const { provider, emitted } = await setup()
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        features: ['motion-trigger'],
        config: {},
      })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        features: ['motion-trigger', 'pan-tilt-zoom'],
        config: {},
      })
      const fps = provisionedFingerprints(emitted)
      expect(fps).toHaveLength(2)
      expect(fps[0]).not.toBe(fps[1])
    })
  })

  describe('removeDevice', () => {
    it('removes stableId from index, meta, and clears device store', async () => {
      const { provider, settings, store } = await setup()

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        config: { a: 1 },
      })
      settings.writeDeviceStore.mockClear()
      settings.clearDeviceStore.mockClear()

      await provider.removeDevice({ deviceId: id })

      // Identity, index membership and hardware metadata were three blobs that
      // had to be rewritten in step; they are three columns of one row now, so
      // removal is one DELETE and there is nothing left to disagree.
      expect(await readDeviceRows(store)).toEqual([])

      // Device store cleared — atomic per-device delete, keyed by numeric id.
      expect(settings.clearDeviceStore).toHaveBeenCalledWith(id)
    })

    it('clears the device runtime-state slice so no __device-state rows orphan', async () => {
      const { provider, settings } = await setup()

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-rt' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-rt',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        config: {},
      })
      // Simulate a persisted runtime-state slice (the __device-state:<id>.* rows).
      await settings.writeDeviceRuntimeState(id, { battery: 50, lastFetchedAt: 1 })
      settings.clearDeviceRuntimeState.mockClear()

      await provider.removeDevice({ deviceId: id })

      // The runtime-state slice must be dropped on remove — otherwise the
      // __device-state:<id>.* rows orphan in addon-device-settings forever.
      expect(settings.clearDeviceRuntimeState).toHaveBeenCalledWith(id)
      expect(await settings.readDeviceRuntimeState(id)).toEqual({})
    })
  })

  describe('persistConfig', () => {
    it('writes to the device store keyed by the numeric deviceId', async () => {
      const { provider, settings } = await setup()
      // Device must be registered first so persistConfig can resolve its numeric id.
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        config: {},
      })
      settings.writeDeviceStore.mockClear()
      await provider.persistConfig({ deviceId: id, data: { fps: 15 } })
      expect(settings.writeDeviceStore).toHaveBeenCalledWith(id, { fps: 15 })
    })
  })

  describe('loadConfig', () => {
    it('reads from the device store keyed by the numeric deviceId', async () => {
      const { provider, settings } = await setup()
      // Device must be registered first so loadConfig can resolve its numeric id.
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        config: {},
      })
      settings.readDeviceStore.mockResolvedValueOnce({ url: 'rtsp://foo' })

      const result = await provider.loadConfig({ deviceId: id })

      expect(settings.readDeviceStore).toHaveBeenCalledWith(id)
      expect(result).toEqual({ url: 'rtsp://foo' })
    })
  })

  describe('listPersistedByAddon', () => {
    it('returns rows combining index + meta', async () => {
      const { provider } = await setup()

      const { id: id1 } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id: id1,
        type: 'camera',
        name: 'Front',
        parentDeviceId: null,
        config: {},
      })
      const { id: id2 } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-2' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-2',
        id: id2,
        type: 'camera',
        name: 'Back',
        parentDeviceId: id1,
        config: {},
      })

      const rows = await provider.listPersistedByAddon({ addonId: 'rtsp' })

      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.stableId === 'cam-1')?.name).toBe('Front')
      expect(rows.find((r) => r.stableId === 'cam-2')?.parentDeviceId).toBe(id1)
    })

    it('returns empty array for unknown addonId', async () => {
      const { provider } = await setup()
      const rows = await provider.listPersistedByAddon({ addonId: 'unknown' })
      expect(rows).toEqual([])
    })
  })

  // ── Live queries ─────────────────────────────────────────────────────────────

  describe('listAll', () => {
    it('returns devices from all addons when no addonId filter', async () => {
      const registry = new DeviceRegistry()
      registry.register('rtsp', asDevice(new FakeDevice('cam-1')))
      registry.register('onvif', asDevice(new FakeDevice('cam-2')))
      const { provider } = await setup(registry)

      const list = await provider.listAll({})
      expect(list.map((d) => d.stableId).toSorted()).toEqual(['cam-1', 'cam-2'])
    })

    it('filters by addonId', async () => {
      const registry = new DeviceRegistry()
      registry.register('rtsp', asDevice(new FakeDevice('cam-1')))
      registry.register('onvif', asDevice(new FakeDevice('cam-2')))
      const { provider } = await setup(registry)

      const list = await provider.listAll({ addonId: 'rtsp' })
      expect(list).toHaveLength(1)
      expect(list[0]!.stableId).toBe('cam-1')
      expect(list[0]!.addonId).toBe('rtsp')
    })

    /**
     * `addonId: null` is NOT "no filter".
     *
     * It is the shape a declarer produces when it reads `ctx.addonId` — a
     * field `AddonContext` does not have; the id is `ctx.id`. Measured on the
     * live hub 2026-08-09: nothing errored and all 319 devices came back, so a
     * `DeclaredDevices` wired the obvious way silently indexes the WHOLE
     * CLUSTER, where its `stableId` lookups can collide with another addon's
     * and its withdrawal sweep considers rows it does not own.
     *
     * Absent stays permissive on purpose — `listAll({})` is a legitimate and
     * widely-used "everything" call. The distinction being drawn is between
     * OMITTING the key and naming an owner that is not one.
     */
    it('REFUSES an owner filter that is present but is not an addon id', async () => {
      const { provider } = await setup(new DeviceRegistry())
      // How the value actually arrives: decoded off the wire, untyped.
      const fromTheWire: Parameters<typeof provider.listAll>[0] = JSON.parse('{"addonId":null}')

      await expect(provider.listAll(fromTheWire)).rejects.toThrow(/addonId/)
    })

    it('still treats an OMITTED owner filter as every device', async () => {
      // Discriminating: a guard that rejected absence too would break every
      // `listAll({})` caller in the product, and this test would be the only
      // thing standing between that and a boot loop.
      const registry = new DeviceRegistry()
      registry.register('rtsp', asDevice(new FakeDevice('cam-1')))
      registry.register('onvif', asDevice(new FakeDevice('cam-2')))
      const { provider } = await setup(registry)

      expect(await provider.listAll({})).toHaveLength(2)
      // An explicitly-undefined key is spread syntax, not a missing owner.
      expect(await provider.listAll({ addonId: undefined })).toHaveLength(2)
    })

    /**
     * A full listing of 293 devices measured 271 KB, of which `config` was
     * 113 KB and `metadata` 22 KB — half the payload — while the viewer's
     * camera list reads 1.8 KB of it. `config` also costs a per-device
     * settings read on the persisted branch, so the slim projection removes
     * round-trips as well as bytes.
     */
    describe('projection: slim', () => {
      it('drops config and metadata but keeps everything identifying', async () => {
        const registry = new DeviceRegistry()
        registry.register('rtsp', asDevice(new FakeCameraDevice('cam-1')))
        const { provider } = await setup(registry)

        const [full] = await provider.listAll({})
        const [slim] = await provider.listAll({ projection: 'slim' })

        expect(slim!.config).toEqual({})
        expect(slim!.metadata).toBeNull()
        // Everything a consumer identifies a device by is untouched.
        for (const key of [
          'id',
          'stableId',
          'addonId',
          'name',
          'type',
          'online',
          'isCamera',
        ] as const) {
          expect(slim![key]).toEqual(full![key])
        }
      })

      it('does NOT read a persisted device settings row', async () => {
        // The point of the projection: the persisted branch reads each
        // device's settings ONE AT A TIME, so a 293-device listing paid 293
        // round-trips for a field the caller discards.
        const { provider, settings } = await setup(null)
        const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-p' })
        await provider.registerDevice({
          addonId: 'rtsp',
          stableId: 'cam-p',
          id,
          type: 'camera',
          name: 'Persisted',
          parentDeviceId: null,
          config: {},
        })

        const before = settings.readDeviceStore.mock.calls.length
        await provider.listAll({ projection: 'slim' })
        expect(settings.readDeviceStore.mock.calls.length).toBe(before)

        await provider.listAll({})
        expect(settings.readDeviceStore.mock.calls.length).toBeGreaterThan(before)
      })
    })

    /**
     * The viewer's linked-devices panel joins `type` + `online` onto ~8
     * already-resolved ids. Unfiltered that answer was the whole fleet:
     * measured on the live hub 2026-08-25, 967 devices = 958 KB unprojected /
     * 433 KB slim, on a query that refetches on the reconcile interval.
     */
    describe('deviceIds filter', () => {
      it('returns only the named ids, from both the live and the persisted branch', async () => {
        const registry = new DeviceRegistry()
        const keep = new FakeDevice('cam-1')
        registry.register('rtsp', asDevice(keep))
        registry.register('rtsp', asDevice(new FakeDevice('cam-2')))
        const { provider } = await setup(registry)
        await provider.registerDevice({
          addonId: 'worker',
          stableId: 'persisted-1',
          id: 4242,
          type: 'sensor',
          name: 'Persisted',
          parentDeviceId: null,
          config: {},
        })

        const list = await provider.listAll({ deviceIds: [keep.id, 4242] })
        expect(list.map((d) => d.stableId).toSorted()).toEqual(['cam-1', 'persisted-1'])
      })

      it('an EMPTY id list means nothing, never everything', async () => {
        // The failure mode this exists to prevent: a filter that is present
        // but empty being "helpfully" widened back to the fleet — the same
        // defect `addonId` already refuses, one field over.
        const registry = new DeviceRegistry()
        registry.register('rtsp', asDevice(new FakeDevice('cam-1')))
        const { provider } = await setup(registry)

        expect(await provider.listAll({ deviceIds: [] })).toEqual([])
      })

      it('an ABSENT id list stays permissive', async () => {
        const registry = new DeviceRegistry()
        registry.register('rtsp', asDevice(new FakeDevice('cam-1')))
        registry.register('rtsp', asDevice(new FakeDevice('cam-2')))
        const { provider } = await setup(registry)

        expect(await provider.listAll({})).toHaveLength(2)
      })
    })

    describe('isCamera filter', () => {
      it('returns only cameras, from both the live and the persisted branch', async () => {
        const registry = new DeviceRegistry()
        registry.register('rtsp', asDevice(new FakeCameraDevice('cam-1')))
        registry.register('rtsp', asDevice(new FakeDevice('sensor-1')))
        const { provider } = await setup(registry)

        const list = await provider.listAll({ isCamera: true })
        expect(list.map((d) => d.stableId)).toEqual(['cam-1'])
      })
    })

    it('sets isCamera=true for a device that has getStreamSources()', async () => {
      const registry = new DeviceRegistry()
      registry.register('rtsp', asDevice(new FakeCameraDevice('cam-1')))
      const { provider } = await setup(registry)

      const list = await provider.listAll({})
      expect(list[0]!.isCamera).toBe(true)
    })

    it('falls back to persisted metadata when registry is null (online=false)', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-offline' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-offline',
        id,
        type: 'camera',
        name: 'Offline',
        parentDeviceId: null,
        config: {},
      })
      const list = await provider.listAll({})

      expect(list).toHaveLength(1)
      expect(list[0]!.stableId).toBe('cam-offline')
      expect(list[0]!.online).toBe(false)
      // isCamera is now inferred from the persisted DeviceType (fixing a
      // regression where forked-worker cameras looked like non-cameras to
      // the stream-broker). A persisted row with `type: 'camera'` is a
      // camera regardless of whether its IDevice lives on the hub registry.
      expect(list[0]!.isCamera).toBe(true)
    })

    it('getDevice and listAll agree isCamera for a persisted-only camera (forked worker)', async () => {
      // Reolink (and every forked provider) lives in a worker: the hub
      // registry is PRESENT but does not hold the IDevice. listAll already
      // infers isCamera from DeviceType; getDevice's persisted fallback used
      // to hardcode false — the 4263 Campanello contradiction of 2026-08-31.
      const { provider } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({
        addonId: 'provider-reolink',
        stableId: 'mac-182c65d761d7',
      })
      await provider.registerDevice({
        addonId: 'provider-reolink',
        stableId: 'mac-182c65d761d7',
        id,
        type: 'camera',
        name: 'Campanello',
        parentDeviceId: null,
        config: {},
      })

      const got = await provider.getDevice({ deviceId: id })
      const listed = (await provider.listAll({})).find((d) => d.id === id)
      expect(listed?.isCamera).toBe(true)
      expect(got?.isCamera).toBe(true)
    })

    it('getDevice does not call a persisted sensor a camera', async () => {
      const { provider } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({
        addonId: 'provider-reolink',
        stableId: 'pir-1',
      })
      await provider.registerDevice({
        addonId: 'provider-reolink',
        stableId: 'pir-1',
        id,
        type: 'sensor',
        name: 'Campanello PIR',
        parentDeviceId: null,
        config: {},
      })
      expect((await provider.getDevice({ deviceId: id }))?.isCamera).toBe(false)
    })

    it('surfaces online=false for a forked device whose mirrored device-status reports offline', async () => {
      // Forked-worker device: registered persisted-only (lives in the worker
      // process, not the hub registry) but the hub registry is present.
      const { provider, deviceState } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({
        addonId: 'home-assistant',
        stableId: 'climate-studio',
      })
      await provider.registerDevice({
        addonId: 'home-assistant',
        stableId: 'climate-studio',
        id,
        type: 'sensor',
        name: 'Studio',
        parentDeviceId: null,
        config: {},
      })

      await deviceState.setCapSlice({
        deviceId: id,
        capName: 'device-status',
        slice: { online: false, lastChangedAt: Date.now() },
      })

      const list = await provider.listAll({})
      const dev = list.find((d) => d.id === id)
      expect(dev).toBeDefined()
      expect(dev!.online).toBe(false)
    })

    it('surfaces online=true for a forked device whose mirrored device-status reports online', async () => {
      const { provider, deviceState } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({
        addonId: 'home-assistant',
        stableId: 'light-kitchen',
      })
      await provider.registerDevice({
        addonId: 'home-assistant',
        stableId: 'light-kitchen',
        id,
        type: 'sensor',
        name: 'Kitchen',
        parentDeviceId: null,
        config: {},
      })

      await deviceState.setCapSlice({
        deviceId: id,
        capName: 'device-status',
        slice: { online: true, lastChangedAt: Date.now() },
      })

      const list = await provider.listAll({})
      const dev = list.find((d) => d.id === id)
      expect(dev).toBeDefined()
      expect(dev!.online).toBe(true)
    })

    it('defaults a CONFIGURED forked device with no mirrored device-status slice to online (registry present)', async () => {
      const { provider } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({
        addonId: 'home-assistant',
        stableId: 'switch-fan',
      })
      await provider.persistConfig({ deviceId: id, data: { entityId: 'switch.fan' } })
      await provider.registerDevice({
        addonId: 'home-assistant',
        stableId: 'switch-fan',
        id,
        type: 'sensor',
        name: 'Fan',
        parentDeviceId: null,
        config: {},
      })

      const list = await provider.listAll({})
      const dev = list.find((d) => d.id === id)
      expect(dev).toBeDefined()
      expect(dev!.online).toBe(true)
    })

    it('never defaults a CONFIG-LESS top-level row to online (D376)', async () => {
      // The shell device 105 was left behind: row present, `config: {}`, no
      // owner able to restore it — and it read `online: true` for a day.
      const { provider } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({
        addonId: 'home-assistant',
        stableId: 'switch-ghost',
      })
      await provider.registerDevice({
        addonId: 'home-assistant',
        stableId: 'switch-ghost',
        id,
        type: 'sensor',
        name: 'Ghost',
        parentDeviceId: null,
        config: {},
      })

      const list = await provider.listAll({})
      const dev = list.find((d) => d.id === id)
      expect(dev).toBeDefined()
      expect(dev!.online).toBe(false)
    })
  })

  describe('toDeviceInfo probed flag', () => {
    it('reports probed=true for a live device with NO feature-probe slice', async () => {
      const registry = new DeviceRegistry()
      registry.register('rtsp', asDevice(new FakeDeviceWithProbe('cam-noprobe', undefined)))
      const { provider } = await setup(registry)

      const list = await provider.listAll({})
      const dev = list.find((d) => d.stableId === 'cam-noprobe')
      expect(dev).toBeDefined()
      expect(dev!.probed).toBe(true)
    })

    it('reports probed=false for a live device whose feature-probe slice has lastProbedAt=0', async () => {
      const registry = new DeviceRegistry()
      registry.register(
        'rtsp',
        asDevice(new FakeDeviceWithProbe('cam-midprobe', { lastProbedAt: 0 })),
      )
      const { provider } = await setup(registry)

      const list = await provider.listAll({})
      const dev = list.find((d) => d.stableId === 'cam-midprobe')
      expect(dev).toBeDefined()
      expect(dev!.probed).toBe(false)
    })

    it('reports probed=true for a live device whose feature-probe slice has lastProbedAt>0', async () => {
      const registry = new DeviceRegistry()
      registry.register(
        'rtsp',
        asDevice(new FakeDeviceWithProbe('cam-probed', { lastProbedAt: Date.now() })),
      )
      const { provider } = await setup(registry)

      const list = await provider.listAll({})
      const dev = list.find((d) => d.stableId === 'cam-probed')
      expect(dev).toBeDefined()
      expect(dev!.probed).toBe(true)
    })

    it('a plain FakeDevice (no runtimeState) reports probed=true', async () => {
      const registry = new DeviceRegistry()
      registry.register('rtsp', asDevice(new FakeDevice('cam-plain')))
      const { provider } = await setup(registry)

      const list = await provider.listAll({})
      const dev = list.find((d) => d.stableId === 'cam-plain')
      expect(dev).toBeDefined()
      expect(dev!.probed).toBe(true)
    })

    it('derives probed for a forked (offline-view) device from its mirrored feature-probe slice', async () => {
      const { provider, deviceState } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({
        addonId: 'home-assistant',
        stableId: 'sensor-midprobe',
      })
      await provider.registerDevice({
        addonId: 'home-assistant',
        stableId: 'sensor-midprobe',
        id,
        type: 'sensor',
        name: 'MidProbe',
        parentDeviceId: null,
        config: {},
      })

      // Mirror a mid-probe slice → probed=false.
      await deviceState.setCapSlice({
        deviceId: id,
        capName: 'feature-probe',
        slice: { lastProbedAt: 0 },
      })
      let list = await provider.listAll({})
      expect(list.find((d) => d.id === id)!.probed).toBe(false)

      // Mirror a completed probe → probed=true.
      await deviceState.setCapSlice({
        deviceId: id,
        capName: 'feature-probe',
        slice: { lastProbedAt: Date.now() },
      })
      list = await provider.listAll({})
      expect(list.find((d) => d.id === id)!.probed).toBe(true)
    })

    it('defaults a forked device with no mirrored feature-probe slice to probed=true', async () => {
      const { provider } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({
        addonId: 'home-assistant',
        stableId: 'sensor-noprobe',
      })
      await provider.registerDevice({
        addonId: 'home-assistant',
        stableId: 'sensor-noprobe',
        id,
        type: 'sensor',
        name: 'NoProbe',
        parentDeviceId: null,
        config: {},
      })

      const list = await provider.listAll({})
      expect(list.find((d) => d.id === id)!.probed).toBe(true)
    })

    it('seeds the mirror feature-probe with lastProbedAt=0 on load even when persisted >0 (per-session probe reset)', async () => {
      const { provider, settings } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-restart' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-restart',
        id,
        type: 'camera',
        name: 'Cam',
        parentDeviceId: null,
        config: {},
      })

      // A device that completed a probe BEFORE the restart: persisted runtime
      // state carries a STALE completed-probe timestamp plus an online slice.
      await settings.writeDeviceRuntimeState(id, {
        'feature-probe': {
          lastProbedAt: 1_000,
          flags: { 'pan-tilt-zoom': true },
          deviceType: 'camera',
          model: 'X',
          channelCount: 1,
          lastFetchedAt: 1_000,
        },
        'device-status': { online: true, lastChangedAt: 1_000 },
      })

      // Boot / worker-respawn restore path: the worker calls loadRuntimeState,
      // which seeds the hub mirror.
      await provider.loadRuntimeState({ deviceId: id })

      const list = await provider.listAll({})
      const dev = list.find((d) => d.id === id)
      expect(dev).toBeDefined()
      // probed MUST be false (per-session reset) so the export carry-forward
      // gate engages until the worker republishes a fresh probe — NOT true
      // from the stale persisted timestamp.
      expect(dev!.probed).toBe(false)
      // Non-probe slices (online) are preserved by the seed.
      expect(dev!.online).toBe(true)
    })

    it('lets a fresh post-restore probe publish flip probed back to true', async () => {
      const { provider, settings, deviceState } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-reprobe' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-reprobe',
        id,
        type: 'camera',
        name: 'Cam',
        parentDeviceId: null,
        config: {},
      })
      await settings.writeDeviceRuntimeState(id, {
        'feature-probe': { lastProbedAt: 1_000, lastFetchedAt: 1_000 },
      })
      await provider.loadRuntimeState({ deviceId: id })
      expect((await provider.listAll({})).find((d) => d.id === id)!.probed).toBe(false)

      // Worker completes its fresh probe THIS session → publishes lastProbedAt>0.
      await deviceState.setCapSlice({
        deviceId: id,
        capName: 'feature-probe',
        slice: { lastProbedAt: Date.now() },
      })
      expect((await provider.listAll({})).find((d) => d.id === id)!.probed).toBe(true)
    })

    it('preserves a persisted blob with no feature-probe slice verbatim (no-op guard)', async () => {
      const { provider, settings } = await setup(new DeviceRegistry())
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-noprobe' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-noprobe',
        id,
        type: 'camera',
        name: 'Cam',
        parentDeviceId: null,
        config: {},
      })
      await settings.writeDeviceRuntimeState(id, {
        'device-status': { online: true, lastChangedAt: 1_000 },
        // deliberately no 'feature-probe' key
      })
      await provider.loadRuntimeState({ deviceId: id })
      const dev = (await provider.listAll({})).find((d) => d.id === id)!
      expect(dev.probed).toBe(true) // no probe slice → probed defaults true
      expect(dev.online).toBe(true) // non-probe slices unaffected
    })
  })

  describe('getDevice', () => {
    it('finds device by numeric deviceId', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-1', { name: 'Front' })
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      const result = await provider.getDevice({ deviceId: cam.id })
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Front')
    })

    it('resolves the owning addonId from the registry', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-deep')
      registry.register('onvif', asDevice(cam))
      const { provider } = await setup(registry)

      const result = await provider.getDevice({ deviceId: cam.id })
      expect(result).not.toBeNull()
      expect(result!.addonId).toBe('onvif')
    })

    it('returns null when device not found', async () => {
      const { provider } = await setup(new DeviceRegistry())
      const result = await provider.getDevice({ deviceId: 99999 })
      expect(result).toBeNull()
    })
  })

  describe('getChildren', () => {
    it('returns only devices whose parentDeviceId matches the resolved parent', async () => {
      const registry = new DeviceRegistry()
      const parent = new FakeDevice('nvr-1')
      registry.register('onvif', asDevice(parent))
      registry.register(
        'onvif',
        asDevice(new FakeDevice('ch-1', {}, { parentDeviceId: parent.id })),
      )
      registry.register(
        'onvif',
        asDevice(new FakeDevice('ch-2', {}, { parentDeviceId: parent.id })),
      )
      registry.register('onvif', asDevice(new FakeDevice('unrelated')))
      const { provider } = await setup(registry)

      const children = await provider.getChildren({ parentDeviceId: parent.id })
      expect(children.map((c) => c.stableId).toSorted()).toEqual(['ch-1', 'ch-2'])
    })

    it('surfaces the mirrored device-status online for persisted (forked) children', async () => {
      const { provider, deviceState } = await setup(new DeviceRegistry())
      // Persisted-only parent + two persisted-only children (forked worker).
      const parent = await provider.allocateDeviceId({
        addonId: 'home-assistant',
        stableId: 'ha-broker',
      })
      await provider.registerDevice({
        addonId: 'home-assistant',
        stableId: 'ha-broker',
        id: parent.id,
        type: 'sensor',
        name: 'Broker',
        parentDeviceId: null,
        config: {},
      })

      const offline = await provider.allocateDeviceId({
        addonId: 'home-assistant',
        stableId: 'cover-tapparella',
      })
      await provider.registerDevice({
        addonId: 'home-assistant',
        stableId: 'cover-tapparella',
        id: offline.id,
        type: 'sensor',
        name: 'Tapparella',
        parentDeviceId: parent.id,
        config: {},
      })

      const online = await provider.allocateDeviceId({
        addonId: 'home-assistant',
        stableId: 'light-living',
      })
      await provider.registerDevice({
        addonId: 'home-assistant',
        stableId: 'light-living',
        id: online.id,
        type: 'sensor',
        name: 'Living',
        parentDeviceId: parent.id,
        config: {},
      })

      await deviceState.setCapSlice({
        deviceId: offline.id,
        capName: 'device-status',
        slice: { online: false, lastChangedAt: Date.now() },
      })
      await deviceState.setCapSlice({
        deviceId: online.id,
        capName: 'device-status',
        slice: { online: true, lastChangedAt: Date.now() },
      })

      const children = await provider.getChildren({ parentDeviceId: parent.id })
      const offlineChild = children.find((c) => c.id === offline.id)
      const onlineChild = children.find((c) => c.id === online.id)
      expect(offlineChild?.online).toBe(false)
      expect(onlineChild?.online).toBe(true)
    })
  })

  // ── Runtime methods ──────────────────────────────────────────────────────────

  describe('getStreamSources', () => {
    it('returns stream sources for a camera device (has getStreamSources)', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeCameraDevice('cam-1')
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      const sources = await provider.getStreamSources({ deviceId: cam.id })
      expect(sources).toHaveLength(2)
      expect(sources[0]!.id).toBe('main')
    })

    it('returns [] for a non-camera device', async () => {
      const registry = new DeviceRegistry()
      const sensor = new FakeDevice('sensor-1')
      registry.register('rtsp', asDevice(sensor))
      const { provider } = await setup(registry)

      const sources = await provider.getStreamSources({ deviceId: sensor.id })
      expect(sources).toEqual([])
    })

    it('throws when device is absent both in registry and persisted state', async () => {
      const { provider } = await setup(null)
      await expect(provider.getStreamSources({ deviceId: 99999 })).rejects.toThrow(
        /Device with id 99999 not found/,
      )
    })
  })

  describe('getConfigSchema', () => {
    it('returns config entries from the live device', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-1', { url: 'rtsp://foo', enabled: true })
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      const entries = await provider.getConfigSchema({ deviceId: cam.id })
      const keys = entries.map((e) => e.key)
      expect(keys).toContain('url')
      expect(keys).toContain('enabled')
    })

    it('throws when device is absent both in registry and persisted state', async () => {
      const { provider } = await setup(new DeviceRegistry())
      await expect(provider.getConfigSchema({ deviceId: 99999 })).rejects.toThrow(
        /Device with id 99999 not found/,
      )
    })
  })

  describe('updateConfig', () => {
    it('calls config.setAll on the device with the provided values', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-1', { name: 'cam-1', fps: 10 })
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      await provider.updateConfig({ deviceId: cam.id, values: { name: 'Updated', fps: 15 } })

      expect(cam.config.setAll).toHaveBeenCalledWith({ name: 'Updated', fps: 15 })
    })

    it('refuses by name a key the device config schema does not own, writing nothing', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-1', { name: 'cam-1' })
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      // `fps` is in the schema; `streamSection` is claimed by a device-store
      // section, so `config.setAll` would strip it and still answer success.
      await expect(
        provider.updateConfig({ deviceId: cam.id, values: { name: 'x', streamSection: 1 } }),
      ).rejects.toThrow(/streamSection/)
      expect(cam.config.setAll).not.toHaveBeenCalled()
    })

    it('throws when device not found in live registry', async () => {
      const { provider } = await setup(new DeviceRegistry())
      await expect(provider.updateConfig({ deviceId: 99999, values: {} })).rejects.toThrow()
    })

    it('throws when registry is null and no persisted owner', async () => {
      const { provider } = await setup(null)
      await expect(provider.updateConfig({ deviceId: 99999, values: {} })).rejects.toThrow(
        /Device with id 99999 not found/,
      )
    })
  })

  describe('setType', () => {
    it('setType updates the persisted device type and emits DeviceMetaChanged', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-1')
      registry.register('rtsp', asDevice(cam))
      const { provider, settings, emitted, store } = await setup(registry)

      // Device must be persisted for setType to resolve the meta row.
      await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id: cam.id,
        type: 'generic',
        name: 'cam-1',
        parentDeviceId: null,
        config: {},
      })
      settings.writeAddonStore.mockClear()

      await provider.setType({ deviceId: cam.id, type: DeviceType.Cover })

      // Verify persisted meta was updated
      expect((await readDeviceRow(store, cam.id)).type).toBe('cover')

      // Verify DeviceMetaChanged was emitted with field='type'
      expect(emitted).toContainEqual(
        expect.objectContaining({
          category: 'device.meta-changed',
          data: expect.objectContaining({ field: 'type', value: 'cover' }),
        }),
      )
    })
  })

  describe('enable / disable', () => {
    it('enable writes disabled=false to deviceMeta', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-1')
      registry.register('rtsp', asDevice(cam))
      const { provider, store } = await setup(registry)

      // Device must be persisted for setDisabled to resolve the meta row.
      await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id: cam.id,
        type: 'camera',
        name: 'cam-1',
        parentDeviceId: null,
        config: {},
      })
      await provider.enable({ deviceId: cam.id })

      expect((await readDeviceRow(store, cam.id)).disabled).toBe(false)
    })

    it('disable writes disabled=true to deviceMeta', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-1')
      registry.register('rtsp', asDevice(cam))
      const { provider, store } = await setup(registry)

      // Device must be persisted for setDisabled to resolve the meta row.
      await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id: cam.id,
        type: 'camera',
        name: 'cam-1',
        parentDeviceId: null,
        config: {},
      })
      await provider.disable({ deviceId: cam.id })

      expect((await readDeviceRow(store, cam.id)).disabled).toBe(true)
    })
  })

  describe('remove', () => {
    it('calls device.removeDevice(), removes from registry, and triggers persistence removal', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-1')
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      // Persist so removeDevice has something to clean up
      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'X',
        parentDeviceId: null,
        config: {},
      })

      await provider.remove({ deviceId: cam.id })

      expect(cam.removeDevice).toHaveBeenCalledOnce()
      expect(registry.getById(cam.id)).toBeNull()
    })

    it('remove(parent) cascades to all children (registry + persisted)', async () => {
      const registry = new DeviceRegistry()
      const parent = new FakeDevice('parent-1')
      registry.register('rtsp', asDevice(parent))
      const child1 = new FakeDevice('child-1', {}, { parentDeviceId: parent.id })
      const child2 = new FakeDevice('child-2', {}, { parentDeviceId: parent.id })
      registry.register('rtsp', asDevice(child1))
      registry.register('rtsp', asDevice(child2))
      const { provider } = await setup(registry)

      // Persist parent + children so removeDevice clears all
      const { id: parentId } = await provider.allocateDeviceId({
        addonId: 'rtsp',
        stableId: 'parent-1',
      })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'parent-1',
        id: parentId,
        type: 'camera',
        name: 'Parent',
        parentDeviceId: null,
        config: {},
      })
      const { id: childId1 } = await provider.allocateDeviceId({
        addonId: 'rtsp',
        stableId: 'child-1',
      })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'child-1',
        id: childId1,
        type: 'camera',
        name: 'Child1',
        parentDeviceId: parentId,
        config: {},
      })
      const { id: childId2 } = await provider.allocateDeviceId({
        addonId: 'rtsp',
        stableId: 'child-2',
      })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'child-2',
        id: childId2,
        type: 'camera',
        name: 'Child2',
        parentDeviceId: parentId,
        config: {},
      })

      await provider.remove({ deviceId: parentId })

      expect(await provider.getDevice({ deviceId: parentId })).toBeNull()
      expect(await provider.getDevice({ deviceId: childId1 })).toBeNull()
      expect(await provider.getDevice({ deviceId: childId2 })).toBeNull()
    })

    it('remove() is a no-op for a device with no children (unchanged single-device behavior)', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('solo-1')
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'solo-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'solo-1',
        id,
        type: 'camera',
        name: 'Solo',
        parentDeviceId: null,
        config: {},
      })

      await provider.remove({ deviceId: id })

      expect(await provider.getDevice({ deviceId: id })).toBeNull()
    })
  })

  // ── Stream profile map ────────────────────────────────────────────────────────

  describe('getStreamProfileMap', () => {
    it('derives profile map from profileHint on stream sources', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeCameraDevice('cam-1')
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      const map = await provider.getStreamProfileMap({ deviceId: cam.id })
      expect(map['high']).toBe('main')
      expect(map['low']).toBe('sub')
    })

    it('prefers explicitly stored _profileMap over derived hint', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeCameraDevice('cam-1', { _profileMap: { high: 'override-stream' } })
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      const map = await provider.getStreamProfileMap({ deviceId: cam.id })
      expect(map['high']).toBe('override-stream')
    })

    it('returns {} when device not found', async () => {
      const { provider } = await setup(new DeviceRegistry())
      const map = await provider.getStreamProfileMap({ deviceId: 99999 })
      expect(map).toEqual({})
    })
  })

  describe('setStreamProfileMap', () => {
    it('writes _profileMap to device config', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-1')
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      await provider.setStreamProfileMap({
        deviceId: cam.id,
        profileMap: { high: 'stream-a', low: 'stream-b' },
      })

      expect(cam.config.setAll).toHaveBeenCalledWith({
        _profileMap: { high: 'stream-a', low: 'stream-b' },
      })
    })
  })

  // ── probeStreams ──────────────────────────────────────────────────────────────

  describe('probeStreams', () => {
    it('returns [] — StreamProbeService not available in addon context', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeCameraDevice('cam-1')
      registry.register('rtsp', asDevice(cam))
      const { provider } = await setup(registry)

      const result = await provider.probeStreams({ deviceId: cam.id })
      expect(result).toEqual([])
    })
  })

  // ── setIntegrationId ────────────────────────────────────────────────────────

  describe('setIntegrationId', () => {
    it('persists integrationId on the meta row and emits DeviceMetaChanged', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-1')
      registry.register('rtsp', asDevice(cam))
      const { provider, store, emitted } = await setup(registry)

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-1' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-1',
        id,
        type: 'camera',
        name: 'Front',
        parentDeviceId: null,
        config: {},
      })

      await provider.setIntegrationId({ deviceId: id, integrationId: 'ha-integration-1' })

      expect((await readDeviceRow(store, id)).integrationId).toBe('ha-integration-1')

      expect(emitted).toContainEqual(
        expect.objectContaining({
          category: 'device.meta-changed',
          data: expect.objectContaining({ field: 'integrationId', value: 'ha-integration-1' }),
        }),
      )
    })

    it('integrationId round-trips through getDevice (persisted fallback path)', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-int' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-int',
        id,
        type: 'camera',
        name: 'Int',
        parentDeviceId: null,
        config: {},
      })
      await provider.setIntegrationId({ deviceId: id, integrationId: 'ha-integration-1' })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.integrationId).toBe('ha-integration-1')
    })

    it('integrationId round-trips through listAll (persisted fallback path)', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-int' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-int',
        id,
        type: 'camera',
        name: 'Int',
        parentDeviceId: null,
        config: {},
      })
      await provider.setIntegrationId({ deviceId: id, integrationId: 'ha-integration-1' })

      const list = await provider.listAll({})
      expect(list.find((d) => d.stableId === 'cam-int')?.integrationId).toBe('ha-integration-1')
    })

    it('throws for an unknown deviceId', async () => {
      const { provider } = await setup(null)
      await expect(
        provider.setIntegrationId({ deviceId: 99999, integrationId: 'x' }),
      ).rejects.toThrow(/stampIntegrationId: unknown device id=99999/)
    })
  })

  // ── setLinkDeviceId ─────────────────────────────────────────────────────────

  describe('setLinkDeviceId', () => {
    it('persists linkDeviceId and survives a re-register round-trip', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-link' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-link',
        id,
        type: 'camera',
        name: 'Link',
        parentDeviceId: null,
        config: {},
      })
      await provider.setLinkDeviceId({ deviceId: id, linkDeviceId: 999 })

      // Re-register (mirrors the kernel create() flow: setter runs before registerDevice)
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-link',
        id,
        type: 'camera',
        name: 'Link',
        parentDeviceId: null,
        config: {},
      })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.linkDeviceId).toBe(999)
    })
  })

  // ── setPrimaryChildEntityId ──────────────────────────────────────────────────

  describe('setPrimaryChildEntityId', () => {
    it('persists primaryChildEntityId and survives a re-register round-trip', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'container-1' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-1',
        id,
        type: 'container',
        name: 'Tapparella',
        parentDeviceId: null,
        config: {},
      })
      await provider.setPrimaryChildEntityId({
        deviceId: id,
        primaryChildEntityId: 'cover.tapparella_kitchen',
      })

      // Re-register (mirrors the kernel create() flow + re-sync re-registration:
      // the field must be preserved across a register clobber).
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-1',
        id,
        type: 'container',
        name: 'Tapparella',
        parentDeviceId: null,
        config: {},
      })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.primaryChildEntityId).toBe('cover.tapparella_kitchen')
    })

    it('surfaces primaryChildEntityId on listAll and getChildren', async () => {
      const { provider } = await setup(null)

      const parent = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'container-2' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-2',
        id: parent.id,
        type: 'container',
        name: 'Studio',
        parentDeviceId: null,
        config: {},
      })
      await provider.setPrimaryChildEntityId({
        deviceId: parent.id,
        primaryChildEntityId: 'cover.tapparella_studio',
      })

      const child = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'cover-studio' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'cover-studio',
        id: child.id,
        type: 'cover',
        name: 'Cover',
        parentDeviceId: parent.id,
        config: {},
      })

      const all = await provider.listAll({})
      const parentInfo = all.find((d) => d.id === parent.id)
      expect(parentInfo?.primaryChildEntityId).toBe('cover.tapparella_studio')

      const children = await provider.getChildren({ parentDeviceId: parent.id })
      // child carries no override of its own
      expect(children.find((c) => c.id === child.id)?.primaryChildEntityId).toBeUndefined()
    })

    it('null clears a previously-set override', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'container-3' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-3',
        id,
        type: 'container',
        name: 'C3',
        parentDeviceId: null,
        config: {},
      })
      await provider.setPrimaryChildEntityId({ deviceId: id, primaryChildEntityId: 'cover.x' })
      await provider.setPrimaryChildEntityId({ deviceId: id, primaryChildEntityId: null })

      // A cleared override is a NULL column, and a NULL column projects as
      // ABSENT. The blob shape could tell "explicitly null" from "never set";
      // a column cannot, and no consumer ever branched between them — every
      // reader of `primaryChildEntityId` gates on `typeof === 'string'`.
      const info = await provider.getDevice({ deviceId: id })
      expect(info?.primaryChildEntityId).toBeUndefined()
    })

    it('throws for an unknown device id', async () => {
      const { provider } = await setup(null)
      await expect(
        provider.setPrimaryChildEntityId({ deviceId: 99999, primaryChildEntityId: 'x' }),
      ).rejects.toThrow(/setPrimaryChildEntityId: unknown device id=99999/)
    })
  })

  // ── childLayout (container accordion-section placement) ───────────────────────

  describe('childLayout', () => {
    // childLayout flows onto the persisted meta row via the create-time pre-seed
    // (kernel `setChildLayout`) — see the dedicated `setChildLayout` block below
    // for the cap-surface setter round-trip. These tests seed the field directly
    // onto the persisted meta row (the same store the create pre-seed /
    // preserve-spread reads) and assert the data-plane round-trip: persistence,
    // projection, and survival across a re-register clobber.
    type ChildLayoutEntry = { childKey: string; section: string; order?: number }

    // `childLayout` is now on the cap's `DeviceInfoSchema`, so the statically-
    // typed `DeviceInfo` returned by the provider exposes it. Read it through a
    // structural type guard so the helper also works on the persisted-meta
    // projection paths — no casts.
    function readChildLayout(info: unknown): readonly ChildLayoutEntry[] | undefined {
      if (info === null || typeof info !== 'object') return undefined
      const record: Record<string, unknown> = { ...info }
      const value = record['childLayout']
      if (value === undefined) return undefined
      if (!Array.isArray(value)) return undefined
      return value.filter(
        (e): e is ChildLayoutEntry =>
          e !== null && typeof e === 'object' && 'childKey' in e && 'section' in e,
      )
    }

    /** Stamp a layout straight onto the device's row, bypassing the setter. */
    async function seedChildLayout(
      store: FakeSettingsStore,
      deviceId: number,
      childLayout: readonly ChildLayoutEntry[],
    ): Promise<void> {
      await store.backend.updateWhere({
        collection: 'device-manager:devices',
        filter: { where: { id: String(deviceId) } },
        data: { childLayout: [...childLayout] },
      })
    }

    const LAYOUT: readonly ChildLayoutEntry[] = [
      { childKey: 'maint-voltage', section: 'Maintenance', order: 1 },
      { childKey: 'maint-rssi', section: 'Maintenance', order: 2 },
      { childKey: 'climate-temp', section: 'Climate' },
    ]

    it('childLayout survives a re-register round-trip (preserve-spread)', async () => {
      // Proves the CRITICAL preserve-spread: registerDevice must NOT clobber a
      // childLayout stamped on the meta row. Without the preserve-spread the
      // layout is silently dropped on every re-register (incl. re-sync).
      const { provider, store } = await setup(null)

      const { id } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'container-layout-1',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-layout-1',
        id,
        type: 'container',
        name: 'Sensor Hub',
        parentDeviceId: null,
        config: {},
      })
      await seedChildLayout(store, id, LAYOUT)

      // Re-register (mirrors the kernel create() flow + re-sync re-registration).
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-layout-1',
        id,
        type: 'container',
        name: 'Sensor Hub',
        parentDeviceId: null,
        config: {},
      })

      const info = await provider.getDevice({ deviceId: id })
      expect(readChildLayout(info)).toEqual(LAYOUT)
    })

    it('childLayout round-trips through getDevice (persisted fallback path)', async () => {
      const { provider, store } = await setup(null)

      const { id } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'container-layout-2',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-layout-2',
        id,
        type: 'container',
        name: 'Hub2',
        parentDeviceId: null,
        config: {},
      })
      await seedChildLayout(store, id, LAYOUT)

      const info = await provider.getDevice({ deviceId: id })
      expect(readChildLayout(info)).toEqual(LAYOUT)
    })

    it('surfaces childLayout on listAll and getChildren (parent only)', async () => {
      const { provider, store } = await setup(null)

      const parent = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'container-layout-3',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-layout-3',
        id: parent.id,
        type: 'container',
        name: 'Hub3',
        parentDeviceId: null,
        config: {},
      })
      await seedChildLayout(store, parent.id, LAYOUT)

      const child = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'maint-voltage' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'maint-voltage',
        id: child.id,
        type: 'sensor',
        name: 'Voltage',
        parentDeviceId: parent.id,
        config: {},
      })

      const all = await provider.listAll({})
      expect(readChildLayout(all.find((d) => d.id === parent.id))).toEqual(LAYOUT)

      const children = await provider.getChildren({ parentDeviceId: parent.id })
      // The container's child carries no layout of its own — the hint lives on
      // the parent container only.
      expect(readChildLayout(children.find((c) => c.id === child.id))).toBeUndefined()
    })

    it('absent childLayout projects as undefined (no layout declared)', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'container-layout-none',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-layout-none',
        id,
        type: 'container',
        name: 'NoLayout',
        parentDeviceId: null,
        config: {},
      })

      const info = await provider.getDevice({ deviceId: id })
      expect(readChildLayout(info)).toBeUndefined()
    })
  })

  // ── setChildLayout (cap-surface setter) ──────────────────────────────────────

  describe('setChildLayout', () => {
    type ChildLayoutEntry = { childKey: string; section: string; order?: number }

    const LAYOUT: readonly ChildLayoutEntry[] = [
      { childKey: 'maint-voltage', section: 'Maintenance', order: 1 },
      { childKey: 'maint-rssi', section: 'Maintenance', order: 2 },
      { childKey: 'climate-temp', section: 'Climate' },
    ]

    it('persists childLayout via the cap setter and returns it through getDevice', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'container-set-1' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-set-1',
        id,
        type: 'container',
        name: 'Sensor Hub',
        parentDeviceId: null,
        config: {},
      })
      await provider.setChildLayout({ deviceId: id, childLayout: LAYOUT })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.childLayout).toEqual(LAYOUT)
    })

    it('survives a re-register round-trip (preserve-spread)', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'container-set-2' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-set-2',
        id,
        type: 'container',
        name: 'Hub2',
        parentDeviceId: null,
        config: {},
      })
      await provider.setChildLayout({ deviceId: id, childLayout: LAYOUT })

      // Re-register (mirrors the kernel create() flow + re-sync re-registration:
      // the field must be preserved across a register clobber).
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-set-2',
        id,
        type: 'container',
        name: 'Hub2',
        parentDeviceId: null,
        config: {},
      })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.childLayout).toEqual(LAYOUT)
    })

    it('replaces a previously-set layout', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'container-set-3' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'container-set-3',
        id,
        type: 'container',
        name: 'Hub3',
        parentDeviceId: null,
        config: {},
      })
      await provider.setChildLayout({ deviceId: id, childLayout: LAYOUT })

      const next: readonly ChildLayoutEntry[] = [{ childKey: 'only', section: 'Solo' }]
      await provider.setChildLayout({ deviceId: id, childLayout: next })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.childLayout).toEqual(next)
    })

    it('throws for an unknown device id', async () => {
      const { provider } = await setup(null)
      await expect(
        provider.setChildLayout({ deviceId: 99999, childLayout: LAYOUT }),
      ).rejects.toThrow(/setChildLayout: unknown device id=99999/)
    })
  })

  // ── removeByIntegration ──────────────────────────────────────────────────────

  describe('removeByIntegration', () => {
    it('removes only top-level parent devices for the matching integrationId and returns count', async () => {
      const registry = new DeviceRegistry()
      // Parent A (integrationId A) and its child
      const parentA = new FakeDevice('parent-a')
      const childOfA = new FakeDevice('child-of-a', {}, { parentDeviceId: parentA.id })
      // Unrelated device B (integrationId B)
      const parentB = new FakeDevice('parent-b')
      // Unrelated device with no integrationId
      const noInteg = new FakeDevice('no-integ')

      for (const d of [parentA, childOfA, parentB, noInteg]) {
        registry.register('ha', asDevice(d))
      }

      const { provider } = await setup(registry)

      // Register all four devices so persistence is consistent
      const { id: parentAId } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'parent-a',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'parent-a',
        id: parentAId,
        type: 'camera',
        name: 'Parent A',
        parentDeviceId: null,
        config: {},
      })
      const { id: childAId } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'child-of-a',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'child-of-a',
        id: childAId,
        type: 'camera',
        name: 'Child of A',
        parentDeviceId: parentAId,
        config: {},
      })
      const { id: parentBId } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'parent-b',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'parent-b',
        id: parentBId,
        type: 'camera',
        name: 'Parent B',
        parentDeviceId: null,
        config: {},
      })
      const { id: noIntegId } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'no-integ',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'no-integ',
        id: noIntegId,
        type: 'camera',
        name: 'No Integ',
        parentDeviceId: null,
        config: {},
      })

      // Stamp integrationIds
      await provider.setIntegrationId({ deviceId: parentAId, integrationId: 'integ-A' })
      await provider.setIntegrationId({ deviceId: childAId, integrationId: 'integ-A' })
      await provider.setIntegrationId({ deviceId: parentBId, integrationId: 'integ-B' })
      // noInteg has no integrationId

      const result = await provider.removeByIntegration({ integrationId: 'integ-A' })

      // Only 1 parent was directly passed to remove (child cascades)
      expect(result.removed).toBe(1)

      // Parent A and its child are gone
      expect(await provider.getDevice({ deviceId: parentAId })).toBeNull()
      expect(await provider.getDevice({ deviceId: childAId })).toBeNull()

      // Parent B and noInteg are untouched
      expect(await provider.getDevice({ deviceId: parentBId })).not.toBeNull()
      expect(await provider.getDevice({ deviceId: noIntegId })).not.toBeNull()
    })

    it('is idempotent — calling twice returns removed=0 on the second call', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('cam-integ')
      registry.register('ha', asDevice(cam))
      const { provider } = await setup(registry)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'cam-integ' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'cam-integ',
        id,
        type: 'camera',
        name: 'Cam',
        parentDeviceId: null,
        config: {},
      })
      await provider.setIntegrationId({ deviceId: id, integrationId: 'integ-A' })

      const first = await provider.removeByIntegration({ integrationId: 'integ-A' })
      expect(first.removed).toBe(1)

      const second = await provider.removeByIntegration({ integrationId: 'integ-A' })
      expect(second.removed).toBe(0)
    })

    it('returns removed=0 when no device has that integrationId', async () => {
      const { provider } = await setup(null)
      const result = await provider.removeByIntegration({ integrationId: 'nonexistent' })
      expect(result.removed).toBe(0)
    })
  })

  // ── integrationId stamp survives re-register ─────────────────────────────────

  describe('integrationId preserved across re-registration', () => {
    it('stamp survives register: setIntegrationId then re-registerDevice keeps the integrationId', async () => {
      // This test proves the CRITICAL bug fix: registerDevice must NOT clobber
      // an integrationId that was stamped by setIntegrationId before the call.
      // The kernel create() flow calls setIntegrationId THEN registerDevice, so
      // without the fix the integrationId is silently dropped, making
      // removeByIntegration a no-op cascade.
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({
        addonId: 'rtsp',
        stableId: 'cam-int-reregister',
      })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-int-reregister',
        id,
        type: 'camera',
        name: 'Int Cam',
        parentDeviceId: null,
        config: {},
      })

      // Stamp integrationId (simulates kernel setIntegrationId call)
      await provider.setIntegrationId({ deviceId: id, integrationId: 'int-X' })

      // Re-register the SAME device (simulates the create() order: register-after-setIntegrationId)
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-int-reregister',
        id,
        type: 'camera',
        name: 'Int Cam',
        parentDeviceId: null,
        config: {},
      })

      // The integrationId MUST still be present — registerDevice must not clobber it
      const info = await provider.getDevice({ deviceId: id })
      expect(info?.integrationId).toBe('int-X')
    })

    it('create-order round-trip: setIntegrationId then registerDevice → getDevice shows integrationId', async () => {
      // Simulates the kernel create() order: setIntegrationId is called BEFORE
      // registerDevice (or at least registerDevice is called after). Without the
      // fix, registerDevice rewrites the meta without integrationId.
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({
        addonId: 'rtsp',
        stableId: 'cam-create-order',
      })

      // First register (seeding the meta row)
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-create-order',
        id,
        type: 'camera',
        name: 'Create Order Cam',
        parentDeviceId: null,
        config: {},
      })

      // Stamp integrationId (kernel setIntegrationId pre-construction step)
      await provider.setIntegrationId({ deviceId: id, integrationId: 'int-Y' })

      // Register again — kernel does this after setIntegrationId in the create() flow
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-create-order',
        id,
        type: 'camera',
        name: 'Create Order Cam',
        parentDeviceId: null,
        config: {},
      })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.integrationId).toBe('int-Y')
    })

    it('removeByIntegration end-to-end after re-registration: cascade removes A, leaves B untouched', async () => {
      // Proves the full chain: setIntegrationId → re-register → removeByIntegration works.
      // Without the fix, registerDevice clobbers integrationId, removeByIntegration sees
      // zero matching devices, and returns removed=0 (silent no-op cascade).
      const registry = new DeviceRegistry()
      const parentA = new FakeDevice('parent-a2')
      const childOfA = new FakeDevice('child-of-a2', {}, { parentDeviceId: parentA.id })
      const parentB = new FakeDevice('parent-b2')
      for (const d of [parentA, childOfA, parentB]) {
        registry.register('ha', asDevice(d))
      }

      const { provider } = await setup(registry)

      // Register parent A + child
      const { id: parentAId } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'parent-a2',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'parent-a2',
        id: parentAId,
        type: 'camera',
        name: 'Parent A2',
        parentDeviceId: null,
        config: {},
      })
      const { id: childAId } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'child-of-a2',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'child-of-a2',
        id: childAId,
        type: 'camera',
        name: 'Child A2',
        parentDeviceId: parentAId,
        config: {},
      })
      const { id: parentBId } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'parent-b2',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'parent-b2',
        id: parentBId,
        type: 'camera',
        name: 'Parent B2',
        parentDeviceId: null,
        config: {},
      })

      // Stamp integrationIds (setIntegrationId BEFORE re-registration, matching kernel order)
      await provider.setIntegrationId({ deviceId: parentAId, integrationId: 'integ-AA' })
      await provider.setIntegrationId({ deviceId: childAId, integrationId: 'integ-AA' })
      await provider.setIntegrationId({ deviceId: parentBId, integrationId: 'integ-BB' })

      // Re-register all devices (simulates the create() → registerDevice-after-setIntegrationId path)
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'parent-a2',
        id: parentAId,
        type: 'camera',
        name: 'Parent A2',
        parentDeviceId: null,
        config: {},
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'child-of-a2',
        id: childAId,
        type: 'camera',
        name: 'Child A2',
        parentDeviceId: parentAId,
        config: {},
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'parent-b2',
        id: parentBId,
        type: 'camera',
        name: 'Parent B2',
        parentDeviceId: null,
        config: {},
      })

      // The integrationId must still be present for the cascade to work
      const result = await provider.removeByIntegration({ integrationId: 'integ-AA' })

      // Without the fix this returns removed=0 (integrationId was clobbered)
      expect(result.removed).toBe(1)

      // Parent A and child are gone
      expect(await provider.getDevice({ deviceId: parentAId })).toBeNull()
      expect(await provider.getDevice({ deviceId: childAId })).toBeNull()

      // Parent B is untouched
      expect(await provider.getDevice({ deviceId: parentBId })).not.toBeNull()
    })
  })

  // ── device-adoption proxy ───────────────────────────────────────────────────────

  describe('adoption proxy', () => {
    it('throws when no device-adoption provider is registered (waitForProvider → null)', async () => {
      const { provider, waitForProvider } = await setupWithCapRegistry(null)

      await expect(
        provider.adoptionListCandidates({
          addonId: 'home-assistant',
          integrationId: 'ha-1',
          page: 1,
          pageSize: 50,
        }),
      ).rejects.toThrow(/not found or not registered/)
      expect(waitForProvider).toHaveBeenCalledWith('device-adoption', 'home-assistant', 5_000)
    })
  })

  describe('adoptionResync resetToSource (#19)', () => {
    // Register a parent + N accessory children, all owned by `addonId`.
    const seedFamily = async (
      provider: IDeviceManagerProvider,
      addonId: string,
      parentStable: string,
      childStables: readonly string[],
    ): Promise<{ parentId: number; childIds: Map<string, number> }> => {
      const { id: parentId } = await provider.allocateDeviceId({ addonId, stableId: parentStable })
      await provider.registerDevice({
        addonId,
        stableId: parentStable,
        id: parentId,
        type: 'generic',
        name: 'Weather Station',
        parentDeviceId: null,
        config: {},
      })
      const childIds = new Map<string, number>()
      for (const cs of childStables) {
        const { id } = await provider.allocateDeviceId({ addonId, stableId: cs })
        await provider.registerDevice({
          addonId,
          stableId: cs,
          id,
          type: 'generic',
          name: cs,
          parentDeviceId: parentId,
          config: {},
        })
        childIds.set(cs, id)
      }
      return { parentId, childIds }
    }

    it('purges every accessory child then delegates to the provider resync, reporting removedChildren', async () => {
      const resync = vi.fn(async () => ({ changed: true, rebuiltChildren: 0 }))
      const { provider, store } = await setupWithCapRegistry({ resync })
      const { parentId, childIds } = await seedFamily(provider, 'ecowitt', 'station', [
        'station-temp',
        'station-hum',
      ])

      const result = await provider.adoptionResync({ camDeviceId: parentId, resetToSource: true })

      // Children torn down, parent untouched.
      const remaining = (await readDeviceRows(store)).map((r) => r['deviceId'])
      expect(remaining).not.toContain(childIds.get('station-temp'))
      expect(remaining).not.toContain(childIds.get('station-hum'))
      expect(remaining).toContain(parentId)

      // Provider re-derive ran with the flag passed through; result merges the count.
      expect(resync).toHaveBeenCalledWith({ camDeviceId: parentId, resetToSource: true })
      expect(result.removedChildren).toBe(2)
      expect(result.changed).toBe(true)
    })

    it('does NOT purge children on a normal (incremental) resync', async () => {
      const resync = vi.fn(async () => ({ changed: false, rebuiltChildren: 0 }))
      const { provider, store } = await setupWithCapRegistry({ resync })
      const { parentId, childIds } = await seedFamily(provider, 'ecowitt', 'station', [
        'station-temp',
      ])

      const result = await provider.adoptionResync({ camDeviceId: parentId })

      const remaining = (await readDeviceRows(store)).map((r) => r['deviceId'])
      expect(remaining).toContain(childIds.get('station-temp'))
      expect(resync).toHaveBeenCalledWith({ camDeviceId: parentId, resetToSource: undefined })
      expect(result.removedChildren).toBe(0)
    })
  })

  // ── sourceInfo projection from config (persisted-fallback paths) ─────────────

  describe('sourceInfo projection from persisted config', () => {
    it('getDevice returns identity-only sourceInfo when config has entityId + system (persisted fallback)', async () => {
      // Uses registry=null so every query takes the persisted-fallback path.
      // buildSourceInfoFromConfig now projects identity ONLY — unit and
      // deviceClass are no longer carried on sourceInfo.
      const { provider, settings } = await setup(null)

      const { id } = await provider.allocateDeviceId({
        addonId: 'homeassistant',
        stableId: 'sensor-x',
      })
      await provider.registerDevice({
        addonId: 'homeassistant',
        stableId: 'sensor-x',
        id,
        type: 'generic',
        name: 'Signal Strength',
        parentDeviceId: null,
        config: {},
      })

      // Persist config with HA sensor fields (mirrors spawnAccessoryChild output)
      settings.readDeviceStore.mockResolvedValue({
        unitOfMeasurement: 'dBm',
        system: 'homeassistant',
        entityId: 'sensor.x',
        role: 'numeric-sensor',
      })

      const info = await provider.getDevice({ deviceId: id })
      // Identity fields are present
      expect(info?.sourceInfo?.id).toBe('sensor.x')
      expect(info?.sourceInfo?.system).toBe('homeassistant')
      // Rendering hints are NOT on sourceInfo (unit flows live via the slice)
      expect((info?.sourceInfo as Record<string, unknown> | undefined)?.['unit']).toBeUndefined()
    })

    it('getDevice does NOT attach sourceInfo when config has no identity anchor (entityId/system)', async () => {
      // Pure-identity devices (cameras, hubs) don't carry entityId/system
      // in their config blob — buildSourceInfoFromConfig returns undefined.
      const { provider, settings } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-no-hints' })
      await provider.registerDevice({
        addonId: 'rtsp',
        stableId: 'cam-no-hints',
        id,
        type: 'camera',
        name: 'No Hints',
        parentDeviceId: null,
        config: {},
      })

      settings.readDeviceStore.mockResolvedValue({ url: 'rtsp://cam/main' })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.sourceInfo).toBeUndefined()
    })

    it('listAll returns identity-only sourceInfo (entityId + system) for a persisted device', async () => {
      // registry=null forces the persisted-fallback branch in listAll.
      // buildSourceInfoFromConfig now projects identity ONLY — unit and
      // deviceClass are no longer carried on sourceInfo (unit flows live
      // via the numeric-sensor slice; deviceClass is boundary-only).
      const { provider, settings } = await setup(null)

      const { id } = await provider.allocateDeviceId({
        addonId: 'homeassistant',
        stableId: 'sensor-dbm',
      })
      await provider.registerDevice({
        addonId: 'homeassistant',
        stableId: 'sensor-dbm',
        id,
        type: 'generic',
        name: 'Signal',
        parentDeviceId: null,
        config: {},
      })

      settings.readDeviceStore.mockResolvedValue({
        unitOfMeasurement: 'dBm',
        system: 'homeassistant',
        entityId: 'sensor.signal',
        deviceClass: 'signal_strength',
      })

      const list = await provider.listAll({})
      const row = list.find((d) => d.stableId === 'sensor-dbm')
      // sourceInfo carries identity fields only
      expect(row?.sourceInfo?.id).toBe('sensor.signal')
      expect(row?.sourceInfo?.system).toBe('homeassistant')
      // rendering hints are no longer on sourceInfo
      expect((row?.sourceInfo as Record<string, unknown> | undefined)?.['unit']).toBeUndefined()
      expect(
        (row?.sourceInfo as Record<string, unknown> | undefined)?.['deviceClass'],
      ).toBeUndefined()
    })
  })

  // ── setRole ─────────────────────────────────────────────────────────────────

  describe('setRole', () => {
    it('persists role on the meta row and emits DeviceMetaChanged', async () => {
      const registry = new DeviceRegistry()
      const cam = new FakeDevice('sensor-role')
      registry.register('ha', asDevice(cam))
      const { provider, store, emitted } = await setup(registry)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'sensor-role' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'sensor-role',
        id,
        type: 'generic',
        name: 'Sensor',
        parentDeviceId: null,
        config: {},
      })

      await provider.setRole({ deviceId: id, role: 'numeric-sensor' })

      expect((await readDeviceRow(store, id)).role).toBe('numeric-sensor')

      expect(emitted).toContainEqual(
        expect.objectContaining({
          category: 'device.meta-changed',
          data: expect.objectContaining({ field: 'role', value: 'numeric-sensor' }),
        }),
      )
    })

    it('role round-trips through getDevice (persisted fallback path)', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'sensor-rtrip' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'sensor-rtrip',
        id,
        type: 'generic',
        name: 'Sensor',
        parentDeviceId: null,
        config: {},
      })
      await provider.setRole({ deviceId: id, role: 'numeric-sensor' })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.role).toBe('numeric-sensor')
    })

    it('role round-trips through listAll (persisted fallback path)', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'sensor-rtrip-list',
      })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'sensor-rtrip-list',
        id,
        type: 'generic',
        name: 'Sensor',
        parentDeviceId: null,
        config: {},
      })
      await provider.setRole({ deviceId: id, role: 'binary-sensor' })

      const list = await provider.listAll({})
      expect(list.find((d) => d.stableId === 'sensor-rtrip-list')?.role).toBe('binary-sensor')
    })

    it('role survives a re-register round-trip (preserve-spread)', async () => {
      // This proves the CRITICAL preserve-spread: registerDevice must NOT clobber
      // a role stamped by setRole. The kernel create()/spawnAccessoryChild flow
      // calls setRole BEFORE registerDevice; without the preserve-spread the role
      // is silently dropped on every re-register.
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'sensor-preserve' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'sensor-preserve',
        id,
        type: 'generic',
        name: 'Sensor',
        parentDeviceId: null,
        config: {},
      })
      await provider.setRole({ deviceId: id, role: 'numeric-sensor' })

      // Re-register (simulates post-probe features refresh — same as create() ordering)
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'sensor-preserve',
        id,
        type: 'generic',
        name: 'Sensor',
        parentDeviceId: null,
        config: {},
      })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.role).toBe('numeric-sensor')
    })

    it('create-order round-trip: setRole before registerDevice → getDevice returns role', async () => {
      // Simulates the kernel create() order exactly: setRole is called BEFORE
      // registerDevice, so the preserve-spread must keep the value.
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({
        addonId: 'ha',
        stableId: 'sensor-create-order',
      })
      // kernel order: setRole → registerDevice
      await provider.setRole({ deviceId: id, role: 'numeric-sensor' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'sensor-create-order',
        id,
        type: 'generic',
        name: 'Sensor',
        parentDeviceId: null,
        config: {},
      })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.role).toBe('numeric-sensor')
    })

    it('throws for an unknown deviceId', async () => {
      const { provider } = await setup(null)
      await expect(provider.setRole({ deviceId: 99999, role: 'numeric-sensor' })).rejects.toThrow(
        /setRole: unknown device id=99999/,
      )
    })
  })

  // ── applyInitialMeta (batched meta pre-seed) ─────────────────────────────────

  describe('applyInitialMeta', () => {
    it('applies every provided field in ONE row write', async () => {
      const { provider, store } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'acc-1' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'acc-1',
        id,
        type: 'generic',
        name: 'acc-1',
        parentDeviceId: null,
        config: {},
      })
      const before = store.writes.length

      await provider.applyInitialMeta({
        deviceId: id,
        name: 'Living Sensor',
        location: 'Living Room',
        type: DeviceType.Sensor,
        integrationId: 'int_x',
        linkDeviceId: 42,
        role: 'numeric-sensor',
      })

      // Exactly one row write — the whole point of the batch setter.
      const rowWrites = deviceRowWrites(store, before)
      expect(rowWrites).toHaveLength(1)
      expect(rowWrites[0]?.columns).toEqual(
        expect.arrayContaining([
          'name',
          'location',
          'type',
          'integrationId',
          'linkDeviceId',
          'role',
        ]),
      )

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.name).toBe('Living Sensor')
      expect(info?.location).toBe('Living Room')
      expect(info?.type).toBe(DeviceType.Sensor)
      expect(info?.integrationId).toBe('int_x')
      expect(info?.linkDeviceId).toBe(42)
      expect(info?.role).toBe('numeric-sensor')
    })

    it('leaves omitted fields untouched', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'acc-omit' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'acc-omit',
        id,
        type: 'generic',
        name: 'Original Name',
        parentDeviceId: null,
        config: {},
      })

      // Pre-seed a role + integrationId, then apply a batch that omits them.
      await provider.applyInitialMeta({
        deviceId: id,
        role: 'binary-sensor',
        integrationId: 'int_keep',
      })
      await provider.applyInitialMeta({ deviceId: id, type: DeviceType.Sensor })

      const info = await provider.getDevice({ deviceId: id })
      // Omitted in the second call → preserved from the first.
      expect(info?.role).toBe('binary-sensor')
      expect(info?.integrationId).toBe('int_keep')
      // name was never supplied to applyInitialMeta → stays the registered name.
      expect(info?.name).toBe('Original Name')
      // type was supplied in the second call → updated.
      expect(info?.type).toBe(DeviceType.Sensor)
    })

    it('emits one DeviceMetaChanged per supplied field (matches individual setters)', async () => {
      const { provider, emitted } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'acc-evt' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'acc-evt',
        id,
        type: 'generic',
        name: 'acc-evt',
        parentDeviceId: null,
        config: {},
      })
      emitted.length = 0

      await provider.applyInitialMeta({
        deviceId: id,
        type: DeviceType.Sensor,
        linkDeviceId: 7,
        role: 'numeric-sensor',
      })

      const metaChanged = emitted.filter(
        (e): e is { category: string; data: { field: string; value: unknown } } =>
          e !== null &&
          typeof e === 'object' &&
          'category' in e &&
          (e as { category: unknown }).category === 'device.meta-changed',
      )
      const fields = metaChanged.map((e) => e.data.field).toSorted()
      // Exactly the three supplied fields — no event for omitted name/location/integrationId.
      expect(fields).toEqual(['linkDeviceId', 'role', 'type'])
      expect(metaChanged.find((e) => e.data.field === 'type')?.data.value).toBe(DeviceType.Sensor)
      expect(metaChanged.find((e) => e.data.field === 'linkDeviceId')?.data.value).toBe(7)
      expect(metaChanged.find((e) => e.data.field === 'role')?.data.value).toBe('numeric-sensor')
    })

    it('matches individual-setter semantics: null clears location / linkDeviceId / role', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'acc-null' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'acc-null',
        id,
        type: 'generic',
        name: 'acc-null',
        parentDeviceId: null,
        config: {},
      })

      await provider.applyInitialMeta({
        deviceId: id,
        location: 'Garage',
        linkDeviceId: 99,
        role: 'numeric-sensor',
      })
      await provider.applyInitialMeta({
        deviceId: id,
        location: null,
        linkDeviceId: null,
        role: null,
      })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.location).toBeNull()
      // `linkDeviceId` is an optional field: a NULL column projects as ABSENT
      // (see `setPrimaryChildEntityId`). `role` goes through `toDeviceRole`,
      // which normalises both spellings to `null`.
      expect(info?.linkDeviceId).toBeUndefined()
      expect(info?.role).toBeNull()
    })

    it('is idempotent — re-applying the same fields keeps the same result', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'acc-idem' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'acc-idem',
        id,
        type: 'generic',
        name: 'acc-idem',
        parentDeviceId: null,
        config: {},
      })

      const input = {
        deviceId: id,
        type: DeviceType.Sensor,
        role: 'numeric-sensor',
        integrationId: 'int_idem',
      }
      await provider.applyInitialMeta(input)
      await provider.applyInitialMeta(input)

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.type).toBe(DeviceType.Sensor)
      expect(info?.role).toBe('numeric-sensor')
      expect(info?.integrationId).toBe('int_idem')
    })

    it('survives a re-register round-trip (preserve-spread holds for batched fields)', async () => {
      const { provider } = await setup(null)

      const { id } = await provider.allocateDeviceId({ addonId: 'ha', stableId: 'acc-preserve' })
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'acc-preserve',
        id,
        type: 'generic',
        name: 'acc-preserve',
        parentDeviceId: null,
        config: {},
      })
      await provider.applyInitialMeta({
        deviceId: id,
        type: DeviceType.Sensor,
        integrationId: 'int_p',
        linkDeviceId: 5,
        role: 'numeric-sensor',
      })

      // Re-register clobbers the row except for the preserved fields.
      await provider.registerDevice({
        addonId: 'ha',
        stableId: 'acc-preserve',
        id,
        type: DeviceType.Sensor,
        name: 'acc-preserve',
        parentDeviceId: null,
        config: {},
      })

      const info = await provider.getDevice({ deviceId: id })
      expect(info?.integrationId).toBe('int_p')
      expect(info?.linkDeviceId).toBe(5)
      expect(info?.role).toBe('numeric-sensor')
    })

    it('throws for an unknown deviceId', async () => {
      const { provider } = await setup(null)
      await expect(
        provider.applyInitialMeta({ deviceId: 99999, type: DeviceType.Sensor }),
      ).rejects.toThrow(/applyInitialMeta: unknown device id=99999/)
    })
  })

  // ── createDevice / adoptDevice forwarder integrationId stamp ────────────────

  /**
   * Build a setup where `waitForProvider('device-provider', …)` resolves to a
   * fake provider whose `createDevice` / `adoptDiscoveredDevice` implementations
   * call back into the device-manager provider to persist the device (mirroring
   * what a real addon provider does before returning the summary).
   */
  async function setupWithDeviceProvider(): Promise<{
    provider: IDeviceManagerProvider
    settings: ReturnType<typeof makeSettings>
    emitted: unknown[]
  }> {
    const addon = new DeviceManagerAddon()
    const settings = makeSettings()
    const { bus: eventBus, emitted } = makeEventBus()

    // Box so the fake provider closure can reference the DM provider
    // after it is initialised (avoids a circular-construction problem).
    const providerRef: { current: IDeviceManagerProvider | null } = { current: null }

    let fakeProviderStableIdSeq = 0

    const fakeDeviceProvider = {
      supportsManualCreation: vi.fn(async () => true),
      supportsDiscovery: vi.fn(async () => true),
      createDevice: vi.fn(
        async ({ type, config }: { type: string; config: Record<string, unknown> }) => {
          const stableId = `fake-created-${fakeProviderStableIdSeq++}`
          const { id } = await providerRef.current!.allocateDeviceId({
            addonId: 'provider-rtsp',
            stableId,
          })
          await providerRef.current!.registerDevice({
            addonId: 'provider-rtsp',
            stableId,
            id,
            type,
            name: stableId,
            parentDeviceId: null,
            config,
          })
          return {
            id,
            stableId,
            addonId: 'provider-rtsp',
            type,
            name: stableId,
            parentDeviceId: null,
            online: true,
            features: [],
            config,
          }
        },
      ),
      adoptDiscoveredDevice: vi.fn(
        async ({
          candidate,
        }: {
          candidate: {
            stableId: string
            type: string
            suggestedName: string
            prefilledConfig: Record<string, unknown>
          }
        }) => {
          const stableId = candidate.stableId
          const { id } = await providerRef.current!.allocateDeviceId({
            addonId: 'provider-onvif',
            stableId,
          })
          await providerRef.current!.registerDevice({
            addonId: 'provider-onvif',
            stableId,
            id,
            type: candidate.type,
            name: candidate.suggestedName,
            parentDeviceId: null,
            config: candidate.prefilledConfig,
          })
          return {
            id,
            stableId,
            addonId: 'provider-onvif',
            type: candidate.type,
            name: candidate.suggestedName,
            parentDeviceId: null,
            online: true,
            features: [],
            config: candidate.prefilledConfig,
          }
        },
      ),
    }

    const waitForProvider = vi.fn(async (_capName: string, addonId: string) => {
      if (addonId === 'provider-rtsp' || addonId === 'provider-onvif') return fakeDeviceProvider
      return null
    })

    const store = await makeSettingsStoreApi()
    const settingsStoreApi = store.api
    const records = await makeRecordsAccessForOwner('device-manager')
    const ctx = {
      api: { settingsStore: settingsStoreApi },
      id: 'device-manager',
      logger: makeLogger(),
      eventBus,
      addonConfig: {},
      dataDir: '/tmp',
      settings,
      records,
      kernel: {
        deviceRegistry: null,
        capabilityRegistry: {
          waitForProvider,
          getNativeProvider: vi.fn(() => null),
          unregisterAllNativeForDevice: vi.fn(),
          setStatusOverlay: vi.fn(),
        },
      },
    }

    const initResult = await addon.initialize(ctx as unknown as AddonContext)
    let providers: readonly ProviderRegistration[] | undefined
    if (Array.isArray(initResult)) providers = initResult
    else if (initResult) providers = initResult.providers
    const first = providers?.[0]
    if (!first) throw new Error('DeviceManagerAddon did not return provider registrations')

    const provider = first.provider as IDeviceManagerProvider
    providerRef.current = provider

    return { provider, settings, emitted }
  }

  const sampleCandidate = {
    stableId: 'onvif-cam-adopted',
    type: DeviceType.Camera,
    suggestedName: 'Adopted ONVIF Cam',
    prefilledConfig: { host: '192.168.10.50' },
  }

  describe('createDevice forwarder — integrationId stamp', () => {
    it('stamps integrationId on the new device meta when provided', async () => {
      const { provider } = await setupWithDeviceProvider()
      const summary = await provider.createDevice({
        addonId: 'provider-rtsp',
        type: DeviceType.Camera,
        config: { host: '1.2.3.4' },
        integrationId: 'int_0007',
      })
      const info = await provider.getDevice({ deviceId: summary.id })
      expect(info?.integrationId).toBe('int_0007')
    })

    it('does not set integrationId when omitted (back-compat)', async () => {
      const { provider } = await setupWithDeviceProvider()
      const summary = await provider.createDevice({
        addonId: 'provider-rtsp',
        type: DeviceType.Camera,
        config: { host: '1.2.3.4' },
      })
      const info = await provider.getDevice({ deviceId: summary.id })
      expect(info?.integrationId).toBeUndefined()
    })

    it('removeByIntegration cascades a forwarder-stamped device', async () => {
      const { provider } = await setupWithDeviceProvider()
      const summary = await provider.createDevice({
        addonId: 'provider-rtsp',
        type: DeviceType.Camera,
        config: { host: '1.2.3.4' },
        integrationId: 'int_0007',
      })
      const { removed } = await provider.removeByIntegration({ integrationId: 'int_0007' })
      expect(removed).toBe(1)
      expect(await provider.getDevice({ deviceId: summary.id })).toBeNull()
    })
  })

  describe('adoptDevice forwarder — integrationId stamp', () => {
    it('stamps integrationId on the adopted device meta when provided', async () => {
      const { provider } = await setupWithDeviceProvider()
      const summary = await provider.adoptDevice({
        addonId: 'provider-onvif',
        candidate: sampleCandidate,
        integrationId: 'int_0008',
      })
      const info = await provider.getDevice({ deviceId: summary.id })
      expect(info?.integrationId).toBe('int_0008')
    })

    it('does not set integrationId when omitted (back-compat)', async () => {
      const { provider } = await setupWithDeviceProvider()
      const summary = await provider.adoptDevice({
        addonId: 'provider-onvif',
        candidate: sampleCandidate,
      })
      const info = await provider.getDevice({ deviceId: summary.id })
      expect(info?.integrationId).toBeUndefined()
    })
  })

  // ── stamp-failure best-effort (createDevice: warn + still returns summary) ──

  describe('createDevice forwarder — stamp failure is best-effort', () => {
    it('still returns the device summary and calls logger.warn when the stamp write throws', async () => {
      const addon = new DeviceManagerAddon()
      const settings = makeSettings()
      const { bus: eventBus } = makeEventBus()
      const logger = makeLogger()

      const providerRef: { current: IDeviceManagerProvider | null } = { current: null }
      let fakeSeq = 0

      const fakeDeviceProvider = {
        supportsManualCreation: vi.fn(async () => true),
        supportsDiscovery: vi.fn(async () => false),
        createDevice: vi.fn(
          async ({ type, config }: { type: string; config: Record<string, unknown> }) => {
            const stableId = `fake-stamp-fail-${fakeSeq++}`
            const { id } = await providerRef.current!.allocateDeviceId({
              addonId: 'provider-rtsp',
              stableId,
            })
            await providerRef.current!.registerDevice({
              addonId: 'provider-rtsp',
              stableId,
              id,
              type,
              name: stableId,
              parentDeviceId: null,
              config,
            })
            return {
              id,
              stableId,
              addonId: 'provider-rtsp',
              type,
              name: stableId,
              parentDeviceId: null,
              online: true,
              features: [],
              config,
            }
          },
        ),
      }

      const waitForProvider = vi.fn(async (_capName: string, addonId: string) => {
        if (addonId === 'provider-rtsp') return fakeDeviceProvider
        return null
      })

      const store = await makeSettingsStoreApi()
      const settingsStoreApi = store.api
      const records = await makeRecordsAccessForOwner('device-manager')
      const ctx = {
        api: { settingsStore: settingsStoreApi },
        id: 'device-manager',
        logger,
        eventBus,
        addonConfig: {},
        dataDir: '/tmp',
        settings,
        records,
        kernel: {
          deviceRegistry: null,
          capabilityRegistry: {
            waitForProvider,
            getNativeProvider: vi.fn(() => null),
            unregisterAllNativeForDevice: vi.fn(),
            setStatusOverlay: vi.fn(),
          },
        },
      }

      const initResult = await addon.initialize(ctx as unknown as AddonContext)
      let providers: readonly ProviderRegistration[] | undefined
      if (Array.isArray(initResult)) providers = initResult
      else if (initResult) providers = initResult.providers
      const first = providers?.[0]
      if (!first) throw new Error('DeviceManagerAddon did not return provider registrations')

      const provider = first.provider as IDeviceManagerProvider
      providerRef.current = provider

      // Inject a failure on the stamp write: the row write that NAMES the
      // `integrationId` column (i.e. `stampIntegrationId`) throws. All other
      // writes — `allocateDeviceId`'s upsert, `registerDevice`'s registration
      // upsert — pass through normally.
      const realUpdateWhere = store.api.updateWhere.mutate
      store.api.updateWhere.mutate = async (
        input: Parameters<typeof realUpdateWhere>[0],
      ): Promise<Awaited<ReturnType<typeof realUpdateWhere>>> => {
        const data = input.data
        if (data !== null && typeof data === 'object' && 'integrationId' in data) {
          throw new Error('simulated stamp write failure')
        }
        return realUpdateWhere(input)
      }

      // createDevice MUST resolve (not throw) and return a valid summary.
      const summary = await provider.createDevice({
        addonId: 'provider-rtsp',
        type: DeviceType.Camera,
        config: { host: '5.6.7.8' },
        integrationId: 'int_fail_test',
      })
      expect(summary.id).toBeTypeOf('number')

      // The scoped logger warn must have been called with the stamp-failure message.
      expect(logger.warn).toHaveBeenCalledWith(
        'createDevice: integrationId stamp failed (device created)',
        expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
      )
    })
  })

  // The device-link suite lived here: `setDeviceLinks`, the `devicesWithLinks`
  // gate, the `rebuildLinkDependents` reverse-index, `resolveLinkedStatus`, the
  // read overlay on `getCapSlice`/`getSnapshot` and the dependent re-emission —
  // ~940 lines. Wiring was deleted on 2026-08-08 (0 links across 302 devices)
  // and the tests went with the mechanism rather than being left describing it.
  // `getWireableFields` survives below: it is the source picker a composition
  // recipe uses, and it outlived the tab that first needed it.

  // ── getWireableFields ────────────────────────────────────────────────────────

  describe('getWireableFields', () => {
    const VacuumStatus = z.object({
      state: z.string(),
      cleanWater: z
        .object({
          status: z.enum(['ok', 'low', 'full']).nullable(),
          level: z.number().nullable(),
        })
        .nullable(),
    })

    function makeRegistryStub() {
      return {
        // vacuum-control: wireable (has schema). device-ops: no schema → omitted.
        // snapshot: a wrapper cap WITH a schema → must be excluded (book-keeping fields).
        getNativeCapsForDevice: (_id: number) =>
          ['vacuum-control', 'device-ops', 'snapshot'] as string[],
        getNativeAddonId: (_cap: string, _id: number) => 'ha',
        getCapsWithDefaultWrapper: () => [] as string[],
        // `getBindings` step 0 asks this for the COLLECTION caps a device is
        // bound to. A stub that omits it reads as "no capabilities declared",
        // which is a different answer from "none are collections".
        listCapabilities: () =>
          [] as ReadonlyArray<{
            name: string
            mode: string
            providers: readonly string[]
            activeProvider: string | null
          }>,
        getDefaultWrapperForCap: (_cap: string) => null,
        // The addon installs the claimed-status overlay at init (D663, S3).
        setStatusOverlay: (_overlay: unknown) => {},
        getDefinition: (cap: string) => {
          if (cap === 'vacuum-control') return { status: { schema: VacuumStatus } }
          if (cap === 'snapshot')
            return { kind: 'wrapper', status: { schema: z.object({ lastCapturedAt: z.number() }) } }
          return undefined
        },
      }
    }

    it('returns wireable fields per cap that has a status schema, omitting schemaless caps', async () => {
      const addon = new DeviceManagerAddon()
      const settings = makeSettings()
      const { bus: eventBus } = makeEventBus()
      const store = await makeSettingsStoreApi()
      const settingsStoreApi = store.api
      const records = await makeRecordsAccessForOwner('device-manager')
      const ctx = {
        api: { settingsStore: settingsStoreApi },
        id: 'device-manager',
        logger: makeLogger(),
        eventBus,
        addonConfig: {},
        dataDir: '/tmp',
        settings,
        records,
        kernel: {
          deviceRegistry: null,
          capabilityRegistry: makeRegistryStub(),
          localNodeId: 'hub',
        },
      }

      const initResult = await addon.initialize(ctx as unknown as AddonContext)
      let providers: readonly ProviderRegistration[] | undefined
      if (Array.isArray(initResult)) providers = initResult
      else if (initResult) providers = initResult.providers

      const first = providers?.[0]
      if (!first) throw new Error('DeviceManagerAddon did not return provider registrations')

      const dm = first.provider as IDeviceManagerProvider

      const out = await dm.getWireableFields({ deviceId: 42 })
      const caps = Object.fromEntries(out.caps.map((c) => [c.cap, c]))

      // device-ops (no schema) + snapshot (wrapper cap) both omitted
      expect(Object.keys(caps)).toEqual(['vacuum-control'])

      const byPath = Object.fromEntries(caps['vacuum-control']!.fields.map((f) => [f.path, f]))

      expect(byPath['state']!.kind).toBe('string')
      expect(byPath['cleanWater.status']!.kind).toBe('enum')
      expect([...byPath['cleanWater.status']!.enumValues!]).toEqual(['ok', 'low', 'full'])
      expect(byPath['cleanWater.level']!.kind).toBe('number')
    })

    it('emits per-item fields (item:true) + the itemArray descriptor for an item-array cap', async () => {
      const addon = new DeviceManagerAddon()
      const settings = makeSettings()
      const { bus: eventBus } = makeEventBus()
      const registry = {
        getNativeCapsForDevice: (_id: number) => ['consumables'] as string[],
        getNativeAddonId: (_cap: string, _id: number) => 'ha',
        getCapsWithDefaultWrapper: () => [] as string[],
        // `getBindings` step 0 asks this for the COLLECTION caps a device is
        // bound to. A stub that omits it reads as "no capabilities declared",
        // which is a different answer from "none are collections".
        listCapabilities: () =>
          [] as ReadonlyArray<{
            name: string
            mode: string
            providers: readonly string[]
            activeProvider: string | null
          }>,
        getDefaultWrapperForCap: (_cap: string) => null,
        // The addon installs the claimed-status overlay at init (D663, S3).
        setStatusOverlay: (_overlay: unknown) => {},
        getDefinition: (cap: string) => (cap === 'consumables' ? consumablesCapability : undefined),
      }
      const store = await makeSettingsStoreApi()
      const settingsStoreApi = store.api
      const records = await makeRecordsAccessForOwner('device-manager')
      const ctx = {
        api: { settingsStore: settingsStoreApi },
        id: 'device-manager',
        logger: makeLogger(),
        eventBus,
        addonConfig: {},
        dataDir: '/tmp',
        settings,
        records,
        kernel: { deviceRegistry: null, capabilityRegistry: registry, localNodeId: 'hub' },
      }
      const initResult = await addon.initialize(ctx as unknown as AddonContext)
      const providers = Array.isArray(initResult) ? initResult : initResult?.providers
      const dmRegistration = providers?.[0]
      if (!dmRegistration) {
        throw new Error('DeviceManagerAddon did not return provider registrations')
      }
      const dm = dmRegistration.provider as IDeviceManagerProvider

      const out = await dm.getWireableFields({ deviceId: 42 })
      const consumables = out.caps.find((c) => c.cap === 'consumables')
      expect(consumables).toBeDefined()
      expect(consumables!.itemArray).toEqual({ path: 'items', keyField: 'key' })

      const byPath = Object.fromEntries(consumables!.fields.map((f) => [f.path, f]))
      // Scalar status field — NOT item-tagged.
      expect(byPath['lastChangedAt']).toMatchObject({ kind: 'number' })
      expect(byPath['lastChangedAt']!.item).toBeUndefined()
      // Per-item fields — tagged item:true; the keyField is excluded.
      expect(byPath['key']).toBeUndefined()
      expect(byPath['label']).toMatchObject({ kind: 'string', item: true })
      expect(byPath['level']).toMatchObject({ kind: 'number', item: true })
      expect(byPath['status']).toMatchObject({ kind: 'enum', item: true })
      expect([...(byPath['status']!.enumValues ?? [])]).toEqual([
        'ok',
        'low',
        'empty',
        'full',
        'replace',
      ])
    })

    it('includeSynthesizable unions in unbound status.empty caps matching the device type', async () => {
      const addon = new DeviceManagerAddon()
      const settings = makeSettings()
      const { bus: eventBus } = makeEventBus()
      const registry = {
        getNativeCapsForDevice: (_id: number) => [] as string[],
        getNativeAddonId: (_cap: string, _id: number) => null,
        getCapsWithDefaultWrapper: () => [] as string[],
        // `getBindings` step 0 asks this for the COLLECTION caps a device is
        // bound to. A stub that omits it reads as "no capabilities declared",
        // which is a different answer from "none are collections".
        listCapabilities: () =>
          [] as ReadonlyArray<{
            name: string
            mode: string
            providers: readonly string[]
            activeProvider: string | null
          }>,
        getDefaultWrapperForCap: (_cap: string) => null,
        // The addon installs the claimed-status overlay at init (D663, S3).
        setStatusOverlay: (_overlay: unknown) => {},
        getDefinition: (cap: string) => (cap === 'consumables' ? consumablesCapability : undefined),
      }
      const store = await makeSettingsStoreApi()
      const settingsStoreApi = store.api
      const records = await makeRecordsAccessForOwner('device-manager')
      const ctx = {
        api: { settingsStore: settingsStoreApi },
        id: 'device-manager',
        logger: makeLogger(),
        eventBus,
        addonConfig: {},
        dataDir: '/tmp',
        settings,
        records,
        kernel: { deviceRegistry: null, capabilityRegistry: registry, localNodeId: 'hub' },
      }
      const initResult = await addon.initialize(ctx as unknown as AddonContext)
      const providers = Array.isArray(initResult) ? initResult : initResult?.providers
      const dmRegistration = providers?.[0]
      if (!dmRegistration) {
        throw new Error('DeviceManagerAddon did not return provider registrations')
      }
      const dm = dmRegistration.provider as IDeviceManagerProvider

      const { id } = await dm.allocateDeviceId({ addonId: 'ha', stableId: 'vac' })
      await dm.registerDevice({
        addonId: 'ha',
        stableId: 'vac',
        id,
        type: 'vacuum',
        name: 'Vac',
        parentDeviceId: null,
        config: {},
      })

      // Default (no flag): no binding, no links → consumables NOT offered.
      const plain = await dm.getWireableFields({ deviceId: id })
      expect(plain.caps.find((c) => c.cap === 'consumables')).toBeUndefined()

      // With the flag: consumables (status.empty, deviceTypes ∋ vacuum) appears
      // with its item fields; battery (deviceTypes ∌ vacuum) does NOT.
      const out = await dm.getWireableFields({ deviceId: id, includeSynthesizable: true })
      const consumables = out.caps.find((c) => c.cap === 'consumables')
      expect(consumables).toBeDefined()
      expect(consumables!.itemArray).toEqual({ path: 'items', keyField: 'key' })
      expect(consumables!.fields.some((f) => f.path === 'level' && f.item === true)).toBe(true)
      expect(out.caps.find((c) => c.cap === 'battery')).toBeUndefined()
    })
  })

  /**
   * `writeDeviceRuntimeState` is a SYNCHRONOUS better-sqlite3 transaction on
   * hub-main's event loop. On the live hub (2026-08-08) a lag-triggered V8 CPU
   * profile caught six stalls and all six were blocked in exactly this call —
   * 1.9 s to 18.3 s each, with the main thread in state D and 0 ms of CPU, i.e.
   * waiting on disk. So the number of times this runs is a latency budget for
   * every request the hub serves, not an implementation detail.
   *
   * Polled providers (matter, dreame, hikvision, …) push a slice on every poll
   * tick, and most ticks carry values identical to the last one. The mirror
   * already detects that — `applySingleCapUpdate` returns early on a shallow
   * -equal slice, emitting no event — and the disk write was scheduled anyway
   * on the next line, so an unchanged poll cost a full DELETE+INSERT commit to
   * write a blob byte-identical to the one already on disk.
   */
  describe('runtime-state disk writes', () => {
    async function registerProbe(
      provider: IDeviceManagerProvider,
      stableId: string,
    ): Promise<number> {
      const { id } = await provider.allocateDeviceId({ addonId: 'home-assistant', stableId })
      await provider.registerDevice({
        addonId: 'home-assistant',
        stableId,
        id,
        type: 'sensor',
        name: stableId,
        parentDeviceId: null,
        config: {},
      })
      return id
    }

    /** Let the 1 s debounce fire and its async write settle. */
    async function flushDebounce(): Promise<void> {
      await vi.advanceTimersByTimeAsync(1_500)
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('does not re-write the runtime state when a poll repeats an identical slice', async () => {
      const { provider, deviceState, settings } = await setup(new DeviceRegistry())
      const id = await registerProbe(provider, 'poller-identical')
      const slice = { online: true, lastChangedAt: 1_000 }

      await deviceState.setCapSlice({ deviceId: id, capName: 'device-status', slice })
      await flushDebounce()
      expect(settings.writeDeviceRuntimeState).toHaveBeenCalledTimes(1)

      // Three more polls returning exactly what is already mirrored. Nothing
      // changed, so nothing may reach the disk.
      for (let i = 0; i < 3; i++) {
        await deviceState.setCapSlice({
          deviceId: id,
          capName: 'device-status',
          slice: { ...slice },
        })
        await flushDebounce()
      }
      expect(settings.writeDeviceRuntimeState).toHaveBeenCalledTimes(1)
    })

    it('still writes when the slice actually changes', async () => {
      const { provider, deviceState, settings } = await setup(new DeviceRegistry())
      const id = await registerProbe(provider, 'poller-changing')

      await deviceState.setCapSlice({
        deviceId: id,
        capName: 'device-status',
        slice: { online: true, lastChangedAt: 1_000 },
      })
      await flushDebounce()
      await deviceState.setCapSlice({
        deviceId: id,
        capName: 'device-status',
        slice: { online: false, lastChangedAt: 2_000 },
      })
      await flushDebounce()

      expect(settings.writeDeviceRuntimeState).toHaveBeenCalledTimes(2)
      expect(settings.writeDeviceRuntimeState).toHaveBeenLastCalledWith(id, {
        'device-status': { online: false, lastChangedAt: 2_000 },
      })
    })

    it('writes once per debounce window when a slice changes repeatedly inside it', async () => {
      const { provider, deviceState, settings } = await setup(new DeviceRegistry())
      const id = await registerProbe(provider, 'poller-bursty')

      for (let i = 1; i <= 5; i++) {
        await deviceState.setCapSlice({
          deviceId: id,
          capName: 'battery',
          slice: { percentage: i, lastFetchedAt: i },
        })
      }
      await flushDebounce()

      // The debounce is what makes a burst affordable; it must keep coalescing.
      expect(settings.writeDeviceRuntimeState).toHaveBeenCalledTimes(1)
      expect(settings.writeDeviceRuntimeState).toHaveBeenLastCalledWith(id, {
        battery: { percentage: 5, lastFetchedAt: 5 },
      })
    })
  })
})
