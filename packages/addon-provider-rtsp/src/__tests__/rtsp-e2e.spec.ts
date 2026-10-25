/**
 * E2E integration test — RTSP Provider with Device Architecture v2
 *
 * Verifies:
 * 1. Addon initializes with a context that has `devices` wired
 * 2. createDevice() creates an RtspCamera and persists it to DB
 * 3. restoreDevices() recreates cameras from DB after a simulated restart
 * 4. Config updates work end-to-end (camera.config.set → DB)
 * 5. Restored camera has the updated config
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AddonContext, IScopedLogger, IEventBus, SavedDevice } from '@camstack/types'
import { DeviceType, streamCatalogCapability } from '@camstack/types'
import type { DeviceManagerApi, InferNativeProvider } from '@camstack/types'

import { DeviceRegistry, CapabilityRegistry, createBrokerDeviceManagerApi } from '@camstack/system'

import { RtspProviderAddon } from '../addon.js'
import { RtspCamera } from '../rtsp-camera.js'

// ─── Inline store implementations ────────────────────────────────────────────
// Plain in-memory fakes standing in for the framework's device/config stores.
// The addon itself persists via the storage cap, NOT a local database.

interface DeviceRow {
  id: number
  stableId: string
  type: string
  name: string
  parentDeviceId: number | null
}

// In-memory persistence backing — replaces the previous better-sqlite3
// `:memory:` DB (this addon does NOT use sqlite; storage goes through the
// framework's storage cap). Holding the rows on a shared instance lets a fresh
// DeviceStore/ConfigStore built on the SAME `db` (the simulated-restart case)
// read what the first instance wrote — exactly what a shared sqlite handle gave.
class InMemoryDb {
  readonly devices = new Map<string, DeviceRow & { addonId: string }>()
  readonly config = new Map<string, string>()
}

const deviceKey = (addonId: string, stableId: string): string => `${addonId}\0${stableId}`
const configKey = (addonId: string, stableId: string | null): string =>
  `${addonId}\0${stableId === null ? '\0__global__' : stableId}`

class DeviceStore {
  constructor(private readonly db: InMemoryDb) {}

  insert(
    addonId: string,
    device: {
      id: number
      stableId: string
      type: string
      name: string
      parentDeviceId: number | null
    },
  ): void {
    // Upsert keyed by (addonId, stableId), mirroring the production
    // device-manager idempotent restore. On conflict the original `id` is kept
    // (the old SQL `ON CONFLICT … DO UPDATE` left `id` untouched).
    const key = deviceKey(addonId, device.stableId)
    const existing = this.db.devices.get(key)
    this.db.devices.set(key, {
      id: existing?.id ?? device.id,
      addonId,
      stableId: device.stableId,
      type: device.type,
      name: device.name,
      parentDeviceId: device.parentDeviceId,
    })
  }

  listByAddon(addonId: string): readonly DeviceRow[] {
    return [...this.db.devices.values()]
      .filter((r) => r.addonId === addonId)
      .map(({ id, stableId, type, name, parentDeviceId }) => ({
        id,
        stableId,
        type,
        name,
        parentDeviceId,
      }))
  }

  remove(addonId: string, stableId: string): void {
    this.db.devices.delete(deviceKey(addonId, stableId))
  }
}

class ConfigStore {
  constructor(private readonly db: InMemoryDb) {}

  save(addonId: string, stableId: string | null, data: Record<string, unknown>): void {
    // Store a serialized copy (mirrors the old SQL JSON round-trip) so callers
    // can't mutate persisted state by reference.
    this.db.config.set(configKey(addonId, stableId), JSON.stringify(data))
  }

  load(addonId: string, stableId: string | null): Record<string, unknown> {
    const raw = this.db.config.get(configKey(addonId, stableId))
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  }

  remove(addonId: string, stableId: string | null): void {
    this.db.config.delete(configKey(addonId, stableId))
  }
}

// ─── DB setup ────────────────────────────────────────────────────────────────

function setupDb() {
  const db = new InMemoryDb()
  return {
    db,
    deviceStore: new DeviceStore(db),
    configStore: new ConfigStore(db),
  }
}

// ─── Logger / EventBus stubs ──────────────────────────────────────────────────

function makeLogger(prefix = 'test'): IScopedLogger {
  const logger: IScopedLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: (name: string) => makeLogger(`${prefix}:${name}`),
    withTags: () => makeLogger(prefix),
  }
  return logger
}

function makeEventBus(): IEventBus {
  return {
    emit: () => {},
    subscribe: () => ({ unsubscribe: () => {} }),
    getRecent: () => [],
  } as unknown as IEventBus
}

// ─── AddonContext factory ─────────────────────────────────────────────────────

// Shared fake kernel stream-probe wired off `probeFixtures` so every
// addon + device context in the suite hits the same metadata table.
// Matches the real `IKernelStreamProbe` contract from `@camstack/types`.
const fakeKernelStreamProbe: import('@camstack/types').IKernelStreamProbe = {
  probe: async (url) => probeFixtures.get(url) ?? {},
  probeField: async (_key, value) => {
    const url = String(value ?? '')
    const meta = probeFixtures.get(url)
    const labels: string[] = []
    if (meta?.width && meta?.height) labels.push(`${meta.width}\u00d7${meta.height}`)
    if (meta?.codec) labels.push(meta.codec.toUpperCase())
    return { status: 'ok' as const, labels: labels.length > 0 ? labels : ['Reachable'] }
  },
}

function makeAddonContext(
  addonId: string,
  devicesApi: DeviceManagerApi,
  api: import('@camstack/types').AddonApi,
): AddonContext {
  const registeredProviders: Record<string, unknown> = {}
  return {
    id: addonId,
    logger: makeLogger(addonId),
    eventBus: makeEventBus(),
    addonConfig: {},
    dataDir: '/tmp/test-rtsp',
    api,
    // Device v2 shape: `kernel.devices` is where providers reach the
    // DeviceManagerApi. The old top-level `devices` field is gone.
    kernel: {
      localNodeId: 'test-node',
      devices: devicesApi,
      streamProbe: fakeKernelStreamProbe,
    },
    registerProvider: (name: string, provider: unknown) => {
      registeredProviders[name] = provider
    },
    settings: undefined,
  } as unknown as AddonContext
}

// ─── DeviceManagerApi factory helper ─────────────────────────────────────────
// Builds a fully-wired DeviceManagerApi backed by `createBrokerDeviceManagerApi`
// with a fake API proxy that delegates persistence to the test's inline stores.
// This mirrors the production path where `ctx.api.deviceManager.*` reaches
// the `device-manager` capability addon on the hub.

/**
 * URL-keyed metadata fixtures the fake stream-probe tRPC returns. Tests
 * set entries via `setProbeMetadata(url, metadata)` before calling
 * `createDevice` so each URL receives a distinct resolution — the
 * profile-assignment branch is then asserted against real quality
 * classification from `classifyStreams`.
 */
const probeFixtures = new Map<
  string,
  { width?: number; height?: number; codec?: string; fps?: number }
>()

function setProbeMetadata(
  url: string,
  meta: { width?: number; height?: number; codec?: string; fps?: number },
): void {
  probeFixtures.set(url, meta)
}

function clearProbeFixtures(): void {
  probeFixtures.clear()
}

/**
 * The broker's retract, as a provider would reach it. Since D689 no path of
 * this provider may call it: removal is the broker's own `DeviceUnregistered`
 * path, and a stream the camera stopped offering leaves through the catalog.
 */
const retractCameraStream = vi.fn(async () => ({ success: true as const }))

function makeFakePersistenceApi(
  addonId: string,
  deviceStore: DeviceStore,
  configStore: ConfigStore,
): import('@camstack/types').AddonApi {
  const contextId = addonId
  let nextId = 1
  const allocated = new Map<string, number>()
  const idToStableId = new Map<number, string>()
  // Production kernel calls `setName` BEFORE `registerDevice` so the
  // operator-typed name reaches the persisted row instead of the
  // placeholder `name = stableId`. The fake doesn't insert a
  // placeholder row in `allocateDeviceId`, so we stash any
  // pre-register name here and apply it inside `registerDevice` /
  // surface via `loadMeta`.
  const pendingNameByStableId = new Map<string, string>()
  const resolveStableId = (input: Record<string, unknown>): string => {
    const stable = typeof input['stableId'] === 'string' ? input['stableId'] : null
    if (stable) return stable
    const id = typeof input['deviceId'] === 'number' ? input['deviceId'] : null
    if (id === null) throw new Error('fake persistence: missing deviceId/stableId in input')
    const mapped = idToStableId.get(id)
    if (!mapped) throw new Error(`fake persistence: no stableId registered for deviceId ${id}`)
    return mapped
  }
  return {
    deviceManager: new Proxy({} as Record<string, unknown>, {
      get(_t, method) {
        if (typeof method !== 'string') return undefined
        const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
          allocateDeviceId: (input) => {
            const stableId = input['stableId'] as string
            const existing = allocated.get(stableId)
            if (typeof existing === 'number') return { id: existing }
            const id = nextId++
            allocated.set(stableId, id)
            idToStableId.set(id, stableId)
            return { id }
          },
          registerDevice: (input) => {
            const id = input['id'] as number
            const stableId = input['stableId'] as string
            idToStableId.set(id, stableId)
            // Honour the pre-register `setName` if the kernel ran one
            // (createDevice flow). Otherwise fall back to the input
            // name (restore flow) or the stableId placeholder.
            const pendingName = pendingNameByStableId.get(stableId)
            const name = pendingName ?? (input['name'] as string | undefined) ?? stableId
            deviceStore.insert(contextId, {
              id,
              stableId,
              type: input['type'] as string,
              name,
              parentDeviceId: (input['parentDeviceId'] as number | null) ?? null,
            })
            // Production device-manager guards on `config: {}` so the
            // pre-persisted config (written via `persistConfig` BEFORE
            // construction) doesn't get clobbered. Mirror that here —
            // empty config means "I'm just registering identity, leave
            // the existing config row alone".
            const incomingConfig = (input['config'] ?? {}) as Record<string, unknown>
            if (Object.keys(incomingConfig).length > 0) {
              configStore.save(contextId, stableId, incomingConfig)
            }
          },
          removeDevice: (input) => {
            const stableId = resolveStableId(input)
            configStore.remove(contextId, stableId)
            deviceStore.remove(contextId, stableId)
          },
          // Production callers pass `{deviceId, data}`; legacy callers
          // pass `{stableId, data}`. Resolve either shape to a stableId
          // so the config row always lands on the same key the
          // creation path wrote.
          persistConfig: (input) => {
            const stableId = resolveStableId(input)
            configStore.save(contextId, stableId, (input['data'] ?? {}) as Record<string, unknown>)
          },
          listByAddon: () => deviceStore.listByAddon(contextId),
          listPersistedByAddon: () => deviceStore.listByAddon(contextId),
          // A device with no stored slices answers `{}`: a load that ANSWERED.
          // An unanswered load refuses the build (D677).
          loadRuntimeState: () => ({}),
          loadConfig: (input) => configStore.load(contextId, resolveStableId(input)),
          // Kernel pre-seeds operator-supplied meta (name / location)
          // BEFORE the device class constructor runs (see
          // `device-cap-proxy.ts` `create` flow). On the createDevice
          // path setName fires before registerDevice so we stash the
          // value and apply it inside registerDevice. On post-register
          // calls (rename via UI) we mutate the row directly.
          setName: (input) => {
            const stableId = resolveStableId(input)
            const name = (input['name'] as string | undefined) ?? stableId
            const existing = deviceStore.listByAddon(contextId).find((d) => d.stableId === stableId)
            if (existing) {
              // Post-register rename — UPDATE the row.
              deviceStore.insert(contextId, {
                id: existing.id,
                stableId,
                type: existing.type,
                name,
                parentDeviceId: existing.parentDeviceId,
              })
            } else {
              // Pre-register pre-seed — stash for the upcoming insert.
              pendingNameByStableId.set(stableId, name)
            }
          },
          // Location + disabled aren't part of this fake's schema (the
          // production Kernel reads them via separate columns we don't
          // model here). Tests don't assert on them — accept the call
          // and no-op so the kernel's pre-seed sequence completes.
          setLocation: () => {
            /* no-op for tests */
          },
          setDisabled: () => {
            /* no-op for tests */
          },
          loadMeta: (input) => {
            const stableId = resolveStableId(input)
            const row = deviceStore.listByAddon(contextId).find((d) => d.stableId === stableId)
            const stashed = pendingNameByStableId.get(stableId)
            return {
              type: row?.type ?? 'camera',
              name: row?.name ?? stashed ?? stableId,
              location: null,
              disabled: false,
            }
          },
        }
        const handler = handlers[method]
        return {
          mutate: async (input: unknown) => handler?.(input as Record<string, unknown>),
          query: async (input: unknown) => handler?.(input as Record<string, unknown>),
        }
      },
    }),
    streamBroker: { retractCameraStream: { mutate: retractCameraStream } },
    // Mirror the hub-hosted `stream-probe.router.ts`. Tests seed
    // resolution fixtures per-URL via `setProbeMetadata` — absent
    // URLs resolve to "reachable but no metadata" so the addon still
    // persists the user's input.
    streamProbe: {
      probe: {
        mutate: async (input: { url: string; force?: boolean }) => {
          const meta = probeFixtures.get(input.url) ?? {}
          return { ...meta, quality: 'high' as const }
        },
      },
      probeField: {
        mutate: async (input: { key: string; value: unknown }) => {
          const url = String(input.value ?? '')
          const meta = probeFixtures.get(url)
          const labels: string[] = []
          if (meta?.width && meta?.height) labels.push(`${meta.width}\u00d7${meta.height}`)
          if (meta?.codec) labels.push(meta.codec.toUpperCase())
          return { status: 'ok' as const, labels: labels.length > 0 ? labels : ['Reachable'] }
        },
      },
    },
  } as unknown as import('@camstack/types').AddonApi
}

function makeDevicesApi(
  addonId: string,
  registry: DeviceRegistry,
  deviceStore: DeviceStore,
  configStore: ConfigStore,
): {
  devicesApi: DeviceManagerApi
  api: import('@camstack/types').AddonApi
  capabilityRegistry: CapabilityRegistry
} {
  const fakeApi = makeFakePersistenceApi(addonId, deviceStore, configStore)
  const capabilityRegistry = new CapabilityRegistry(makeLogger('test-cap-registry'))
  const devicesApi = createBrokerDeviceManagerApi({
    api: fakeApi,
    addonId,
    nodeId: 'test-node',
    logger: makeLogger(addonId),
    eventBus: makeEventBus(),
    registry,
    capabilityRegistry,
    streamProbe: fakeKernelStreamProbe,
  })
  return { devicesApi, api: fakeApi, capabilityRegistry }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RTSP Provider — Device Architecture v2 E2E', () => {
  const ADDON_ID = 'provider-rtsp'

  afterEach(() => {
    clearProbeFixtures()
  })

  describe('1. Addon initialization', () => {
    it('initializes without error and registers as device-provider', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )

      const addon = new RtspProviderAddon()
      const ctx = makeAddonContext(ADDON_ID, devicesApi, fakeApi)

      const result = await addon.initialize(ctx)
      // BaseAddon normalizes the onInitialize return into { providers }.
      // The addon registers the `device-provider` capability, so we get
      // exactly one provider entry back.
      expect(result).toBeDefined()
    })
  })

  describe('2. createDevice()', () => {
    it('creates an RtspCamera and persists it to DB + registry', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )

      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: {
          name: 'Test Cam',
          streams: ['rtsp://10.0.0.1/stream'],
        },
      })

      // Camera should be in the runtime registry
      const allDevices = registry.getAllForAddon(ADDON_ID)
      expect(allDevices).toHaveLength(1)
      expect(allDevices[0]!.stableId).toBe(summary.stableId)

      // Camera should be persisted to DB
      const dbDevices = deviceStore.listByAddon(ADDON_ID)
      expect(dbDevices).toHaveLength(1)
      expect(dbDevices[0]!.stableId).toBe(summary.stableId)
      expect(dbDevices[0]!.name).toBe('Test Cam')
      expect(dbDevices[0]!.type).toBe(DeviceType.Camera)

      // Config should be persisted. `name` lives in the device-meta
      // row (asserted above on dbDevices), NOT in the config blob —
      // the post-meta-split architecture cleanly separates the two.
      const dbConfig = configStore.load(ADDON_ID, summary.stableId)
      expect((dbConfig['streams'] as Array<{ id: string; url: string }>)[0]!.url).toBe(
        'rtsp://10.0.0.1/stream',
      )
    })

    it('throws when given an unsupported device type', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )

      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      await expect(addon.createDevice({ type: DeviceType.Hub, config: {} })).rejects.toThrow(
        /does not support device type/,
      )
    })
  })

  describe('3. Config updates (camera.config.set)', () => {
    it('persists config changes to DB', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )

      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: {
          name: 'Test Cam',
          streams: ['rtsp://10.0.0.1/stream'],
        },
      })

      // Retrieve the actual RtspCamera instance from the registry
      const camera = registry.getById(summary.id) as RtspCamera

      // Modify a real config field. `name` is meta-only post-split,
      // so we exercise `snapshotUrl` instead — a regular schema key
      // that round-trips through `config.set` + persistConfig.
      await camera.config.set('snapshotUrl', 'http://10.0.0.1/snapshot.jpg')

      // In-memory config reflects change immediately
      expect(camera.config.get('snapshotUrl')).toBe('http://10.0.0.1/snapshot.jpg')

      // DB should reflect the change
      const dbConfig = configStore.load(ADDON_ID, camera.stableId)
      expect(dbConfig['snapshotUrl']).toBe('http://10.0.0.1/snapshot.jpg')
    })
  })

  describe('4. restoreDevices() — simulated server restart', () => {
    it('restores cameras from DB with updated config after restart', async () => {
      // ── Boot 1: create camera + modify config ─────────────────────────────
      const { db, deviceStore, configStore } = setupDb()

      const registry1 = new DeviceRegistry()
      const { devicesApi: devicesApi1, api: fakeApi1 } = makeDevicesApi(
        ADDON_ID,
        registry1,
        deviceStore,
        configStore,
      )

      const addon1 = new RtspProviderAddon()
      await addon1.initialize(makeAddonContext(ADDON_ID, devicesApi1, fakeApi1))

      const summary1 = await addon1.createDevice({
        type: DeviceType.Camera,
        config: {
          name: 'Test Cam',
          streams: ['rtsp://10.0.0.1/stream'],
        },
      })
      const camera1 = registry1.getById(summary1.id) as RtspCamera

      // Mutate a config value before "restart". `name` is meta-only
      // post-split — exercise `snapshotUrl` (real schema field) so
      // the round-trip through persistConfig is observable.
      await camera1.config.set('snapshotUrl', 'http://10.0.0.1/snap.jpg')
      expect(camera1.config.get('snapshotUrl')).toBe('http://10.0.0.1/snap.jpg')

      // ── Boot 2: new registry + factory, same DB ───────────────────────────
      const deviceStore2 = new DeviceStore(db)
      const configStore2 = new ConfigStore(db)
      const registry2 = new DeviceRegistry()
      const { devicesApi: devicesApi2, api: fakeApi2 } = makeDevicesApi(
        ADDON_ID,
        registry2,
        deviceStore2,
        configStore2,
      )

      const addon2 = new RtspProviderAddon()
      await addon2.initialize(makeAddonContext(ADDON_ID, devicesApi2, fakeApi2))

      // Build SavedDevice list from DB (as the kernel would at boot)
      const dbRows = deviceStore2.listByAddon(ADDON_ID)
      expect(dbRows).toHaveLength(1)

      const savedDevices: SavedDevice[] = dbRows.map((row) => ({
        id: row.id,
        stableId: row.stableId,
        type: row.type as DeviceType,
        name: row.name,
        location: null,
        disabled: false,
        parentDeviceId: row.parentDeviceId,
        config: configStore2.load(ADDON_ID, row.stableId),
      }))

      await addon2.restoreDevices!(savedDevices)

      // Registry should have the camera
      const allDevices = registry2.getAllForAddon(ADDON_ID)
      expect(allDevices).toHaveLength(1)

      const restoredCamera = registry2.getById(camera1.id) as RtspCamera
      expect(restoredCamera).not.toBeNull()

      // Updated config field should have survived the restart.
      expect(restoredCamera.config.get('snapshotUrl')).toBe('http://10.0.0.1/snap.jpg')
      // Other fields should survive too
      const streams = restoredCamera.config.get('streams')
      expect(streams[0]!.url).toBe('rtsp://10.0.0.1/stream')
    })

    it('is a no-op when savedDevices is empty', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )

      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      await expect(addon.restoreDevices!([])).resolves.toBeUndefined()
      expect(registry.getAllForAddon(ADDON_ID)).toHaveLength(0)
    })
  })

  describe('5. getChildCreationSchema()', () => {
    it('returns a ConfigUISchema with RTSP stream fields for Camera type', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )

      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      const schema = await addon.getChildCreationSchema({ type: DeviceType.Camera })
      expect(schema).not.toBeNull()
      expect(schema?.sections).toBeDefined()

      // Flatten all fields across sections and assert the critical keys exist
      const allKeys =
        schema?.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? f.key : null))) ?? []
      expect(allKeys).toContain('name')
      // Phase 3: single `streams` probe field rendered as a multiple
      // array with min=1 / max=3 — replaces the old
      // mainStreamUrl / subStreamUrl / thirdStreamUrl triple. The
      // backend probes each URL via the kernel stream-probe and
      // auto-assigns (high/mid/low) profiles by resolution.
      expect(allKeys).toContain('streams')
      expect(allKeys).toContain('snapshotUrl')
      expect(allKeys).toContain('username')
      expect(allKeys).toContain('password')

      const streamsField = schema!.sections
        .flatMap((s) => s.fields)
        .find(
          (f): f is typeof f & { key: string; type: string; multiple?: unknown } =>
            'key' in f && f.key === 'streams',
        )
      expect(streamsField?.type).toBe('probe')
      expect(streamsField?.multiple).toMatchObject({ min: 1, max: 3 })
    })

    it('returns null for unsupported device types', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )

      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      const schema = await addon.getChildCreationSchema({ type: DeviceType.Hub })
      expect(schema).toBeNull()
    })
  })

  // ── Phase 3: kernel probe + auto-assign (N=1/2/3) ───────────────────

  describe('6. Stream profile auto-assignment (N=1/2/3)', () => {
    it('N=1: single stream → [high]', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      setProbeMetadata('rtsp://cam/main', { width: 1920, height: 1080, codec: 'h264' })

      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: { name: 'One-stream cam', streams: ['rtsp://cam/main'] },
      })

      const dbConfig = configStore.load(ADDON_ID, summary.stableId)
      const streams = dbConfig['streams'] as Array<{
        id: string
        url: string
        profileHint?: string
      }>
      expect(streams).toHaveLength(1)
      expect(streams[0]!.id).toBe('stream-1')
      expect(streams[0]!.url).toBe('rtsp://cam/main')
      // classifyStreams of a single entry returns { quality: 'high' }
      expect(streams[0]!.profileHint).toBe('high')
    })

    it('N=2: resolution-sorted → [high, low] (mid skipped by classifyStreams)', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      // Deliberately pass the LOW resolution first so the test
      // verifies the backend sorts by pixels, not by input order.
      setProbeMetadata('rtsp://cam/sub', { width: 640, height: 360, codec: 'h264' })
      setProbeMetadata('rtsp://cam/main', { width: 1920, height: 1080, codec: 'h264' })

      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: {
          name: 'Two-stream cam',
          streams: ['rtsp://cam/sub', 'rtsp://cam/main'],
        },
      })

      const dbConfig = configStore.load(ADDON_ID, summary.stableId)
      const streams = dbConfig['streams'] as Array<{
        id: string
        url: string
        profileHint?: string
      }>
      const byHint: Record<string, string> = Object.fromEntries(
        streams.map((s) => [s.profileHint ?? '', s.url]),
      )
      expect(byHint['high']).toBe('rtsp://cam/main')
      expect(byHint['low']).toBe('rtsp://cam/sub')
      expect(byHint['mid']).toBeUndefined()
      // Input slot order is preserved in the id.
      expect(streams.map((s) => s.id)).toEqual(['stream-1', 'stream-2'])
    })

    it('N=3: resolution-sorted → [high, mid, low]', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      // Mix input order: 720p first, then 4K, then 360p.
      setProbeMetadata('rtsp://cam/sub', { width: 1280, height: 720, codec: 'h264' })
      setProbeMetadata('rtsp://cam/main', { width: 3840, height: 2160, codec: 'h265' })
      setProbeMetadata('rtsp://cam/third', { width: 640, height: 360, codec: 'h264' })

      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: {
          name: 'Three-stream cam',
          streams: ['rtsp://cam/sub', 'rtsp://cam/main', 'rtsp://cam/third'],
        },
      })

      const dbConfig = configStore.load(ADDON_ID, summary.stableId)
      const streams = dbConfig['streams'] as Array<{
        id: string
        url: string
        profileHint?: string
      }>
      const byHint: Record<string, string> = Object.fromEntries(
        streams.map((s) => [s.profileHint ?? '', s.url]),
      )
      expect(byHint['high']).toBe('rtsp://cam/main')
      expect(byHint['mid']).toBe('rtsp://cam/sub')
      expect(byHint['low']).toBe('rtsp://cam/third')
    })

    it('rejects zero URLs', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      await expect(
        addon.createDevice({
          type: DeviceType.Camera,
          config: { name: 'No-stream cam', streams: [] },
        }),
      ).rejects.toThrow(/At least one RTSP stream URL is required/)
    })

    it('rejects more than 3 URLs', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      await expect(
        addon.createDevice({
          type: DeviceType.Camera,
          config: {
            name: 'Over-limit cam',
            streams: ['rtsp://a', 'rtsp://b', 'rtsp://c', 'rtsp://d'],
          },
        }),
      ).rejects.toThrow(/At most 3 RTSP stream URLs/)
    })

    it('URL that fails to probe still gets a profile label (insertion-order fallback)', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      // Only the first URL has metadata; the second has none (probe
      // returns an empty shape) so classifyStreams treats it as
      // pixelCount=0 and assigns it the lower tier.
      setProbeMetadata('rtsp://cam/main', { width: 1920, height: 1080, codec: 'h264' })
      // 'rtsp://cam/unknown' — no setProbeMetadata → empty metadata

      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: {
          name: 'Partial-probe cam',
          streams: ['rtsp://cam/main', 'rtsp://cam/unknown'],
        },
      })

      const dbConfig = configStore.load(ADDON_ID, summary.stableId)
      const streams = dbConfig['streams'] as Array<{
        id: string
        url: string
        profileHint?: string
      }>
      const byHint: Record<string, string> = Object.fromEntries(
        streams.map((s) => [s.profileHint ?? '', s.url]),
      )
      expect(byHint['high']).toBe('rtsp://cam/main')
      expect(byHint['low']).toBe('rtsp://cam/unknown')
    })
  })

  // ── Phase 3 (continued): edit path re-probes and re-classifies ──────

  describe('7. applySettingsPatch — edit form re-probes + re-classifies', () => {
    it('swapping a URL re-probes and reassigns profiles by resolution', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      setProbeMetadata('rtsp://cam/main', { width: 1920, height: 1080, codec: 'h264' })
      setProbeMetadata('rtsp://cam/sub', { width: 640, height: 360, codec: 'h264' })
      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: { name: 'Edit cam', streams: ['rtsp://cam/main', 'rtsp://cam/sub'] },
      })
      const camera = registry.getById(summary.id) as RtspCamera
      expect(camera).not.toBeNull()

      // Operator swaps the high-res URL for a different one at 4K, and
      // keeps the sub-stream URL. On save we expect the new URL to be
      // classified as `high` via ffprobe resolution — NOT by input
      // position (we deliberately put the 4K URL second).
      setProbeMetadata('rtsp://cam/main-4k', { width: 3840, height: 2160, codec: 'h265' })
      await camera.applySettingsPatch({
        streams: ['rtsp://cam/sub', 'rtsp://cam/main-4k'],
      })

      const dbConfig = configStore.load(ADDON_ID, camera.stableId)
      const streams = dbConfig['streams'] as Array<{
        id: string
        url: string
        profileHint?: string
      }>
      const byHint: Record<string, string> = Object.fromEntries(
        streams.map((s) => [s.profileHint ?? '', s.url]),
      )
      expect(byHint['high']).toBe('rtsp://cam/main-4k')
      expect(byHint['low']).toBe('rtsp://cam/sub')
      expect(byHint['mid']).toBeUndefined()
    })

    it('adding a 3rd stream promotes it into the mid slot via resolution ranking', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      setProbeMetadata('rtsp://cam/main', { width: 1920, height: 1080, codec: 'h264' })
      setProbeMetadata('rtsp://cam/sub', { width: 640, height: 360, codec: 'h264' })
      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: { name: 'Growing cam', streams: ['rtsp://cam/main', 'rtsp://cam/sub'] },
      })
      const camera = registry.getById(summary.id) as RtspCamera

      setProbeMetadata('rtsp://cam/mid-stream', { width: 1280, height: 720, codec: 'h264' })
      await camera.applySettingsPatch({
        streams: ['rtsp://cam/main', 'rtsp://cam/mid-stream', 'rtsp://cam/sub'],
      })

      const dbConfig = configStore.load(ADDON_ID, camera.stableId)
      const streams = dbConfig['streams'] as Array<{
        id: string
        url: string
        profileHint?: string
      }>
      const byHint: Record<string, string> = Object.fromEntries(
        streams.map((s) => [s.profileHint ?? '', s.url]),
      )
      expect(byHint['high']).toBe('rtsp://cam/main')
      expect(byHint['mid']).toBe('rtsp://cam/mid-stream')
      expect(byHint['low']).toBe('rtsp://cam/sub')
    })

    it('clearing every slot keeps the existing streams (zod min-1 invariant)', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      setProbeMetadata('rtsp://cam/main', { width: 1920, height: 1080, codec: 'h264' })
      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: { name: 'Cleared cam', streams: ['rtsp://cam/main'] },
      })
      const camera = registry.getById(summary.id) as RtspCamera

      await camera.applySettingsPatch({ streams: [] })

      const dbConfig = configStore.load(ADDON_ID, camera.stableId)
      const streams = dbConfig['streams'] as Array<{
        id: string
        url: string
        profileHint?: string
      }>
      expect(streams).toHaveLength(1)
      expect(streams[0]!.url).toBe('rtsp://cam/main')
      expect(streams[0]!.profileHint).toBe('high')
    })

    it('getSettingsUISchema surfaces stored URLs in input-slot order inside a `streams` array', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      setProbeMetadata('rtsp://cam/main', { width: 1920, height: 1080, codec: 'h264' })
      setProbeMetadata('rtsp://cam/mid-stream', { width: 1280, height: 720, codec: 'h264' })
      setProbeMetadata('rtsp://cam/sub', { width: 640, height: 360, codec: 'h264' })
      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: {
          name: 'Three-stream cam',
          // Input order is preserved in the slot id (stream-1/2/3).
          // The broker decides profile mapping separately from the
          // form order — the UI just shows slots as entered.
          streams: ['rtsp://cam/mid-stream', 'rtsp://cam/sub', 'rtsp://cam/main'],
        },
      })
      const camera = registry.getById(summary.id) as RtspCamera

      const schema = camera.getSettingsUISchema()
      const streamsField = schema.sections
        .flatMap((s) => s.fields)
        .find(
          (f): f is typeof f & { key: string; value: unknown } => 'key' in f && f.key === 'streams',
        )
      expect(streamsField).toBeDefined()
      expect(streamsField?.value).toEqual([
        'rtsp://cam/mid-stream',
        'rtsp://cam/sub',
        'rtsp://cam/main',
      ])
    })
  })

  // ── Legacy migration — {label, url} shape upgraded to {id, url, profileHint} ──

  describe('8. Legacy {label,url} migration', () => {
    it('constructor detects legacy shape and rewrites to {id, url, profileHint}', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      // Seed a persisted camera row with the LEGACY shape. Post-split,
      // restoreDevices reads config from the DB via loadConfig — the
      // SavedDevice arg only carries identity. Pre-persist both
      // surfaces (deviceStore + configStore) here.
      const legacyConfig = {
        streams: [
          { label: 'high', url: 'rtsp://legacy/main' },
          { label: 'low', url: 'rtsp://legacy/sub' },
        ],
        snapshotUrl: '',
        username: '',
        password: '',
      }
      deviceStore.insert(ADDON_ID, {
        id: 9001,
        stableId: 'rtsp-legacy',
        type: DeviceType.Camera,
        name: 'Legacy Cam',
        parentDeviceId: null,
      })
      configStore.save(ADDON_ID, 'rtsp-legacy', legacyConfig)
      const legacy: SavedDevice = {
        id: 9001,
        stableId: 'rtsp-legacy',
        type: DeviceType.Camera,
        name: 'Legacy Cam',
        location: null,
        disabled: false,
        parentDeviceId: null,
        config: legacyConfig,
      }
      await addon.restoreDevices!([legacy])

      // Allow the fire-and-forget setAll to land.
      await new Promise((r) => setTimeout(r, 20))

      const persisted = configStore.load(ADDON_ID, 'rtsp-legacy')
      const streams = persisted['streams'] as Array<{
        id: string
        url: string
        profileHint?: string
      }>
      expect(streams).toHaveLength(2)
      expect(streams[0]!.id).toBe('stream-1')
      expect(streams[0]!.url).toBe('rtsp://legacy/main')
      expect(streams[0]!.profileHint).toBe('high')
      expect(streams[1]!.id).toBe('stream-2')
      expect(streams[1]!.url).toBe('rtsp://legacy/sub')
      expect(streams[1]!.profileHint).toBe('low')
    })

    it('already-migrated streams ({id, url}) are left untouched', async () => {
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api: fakeApi } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, fakeApi))

      // Pre-persist (post-split: restoreDevices reads from DB).
      const modernConfig = {
        streams: [{ id: 'stream-1', url: 'rtsp://modern/main', profileHint: 'high' }],
        snapshotUrl: '',
        username: '',
        password: '',
      }
      deviceStore.insert(ADDON_ID, {
        id: 9002,
        stableId: 'rtsp-modern',
        type: DeviceType.Camera,
        name: 'Modern Cam',
        parentDeviceId: null,
      })
      configStore.save(ADDON_ID, 'rtsp-modern', modernConfig)
      const already: SavedDevice = {
        id: 9002,
        stableId: 'rtsp-modern',
        type: DeviceType.Camera,
        name: 'Modern Cam',
        location: null,
        disabled: false,
        parentDeviceId: null,
        config: modernConfig,
      }
      await addon.restoreDevices!([already])
      await new Promise((r) => setTimeout(r, 20))

      const persisted = configStore.load(ADDON_ID, 'rtsp-modern')
      const streams = persisted['streams'] as Array<{
        id: string
        url: string
        profileHint?: string
      }>
      expect(streams).toHaveLength(1)
      expect(streams[0]).toEqual({ id: 'stream-1', url: 'rtsp://modern/main', profileHint: 'high' })
    })
  })

  // ── D689: a runner that stops is not a camera that left ─────────────

  describe('9. Teardown and rebuild never retract from the broker (D689)', () => {
    type CatalogProvider = InferNativeProvider<typeof streamCatalogCapability>

    async function bootWithCamera(urls: readonly string[]): Promise<{
      readonly addon: RtspProviderAddon
      readonly registry: DeviceRegistry
      readonly deviceStore: DeviceStore
      readonly catalogOf: (deviceId: number) => Promise<readonly string[] | null>
      readonly deviceId: number
      readonly stableId: string
    }> {
      retractCameraStream.mockClear()
      const { deviceStore, configStore } = setupDb()
      const registry = new DeviceRegistry()
      const { devicesApi, api, capabilityRegistry } = makeDevicesApi(
        ADDON_ID,
        registry,
        deviceStore,
        configStore,
      )
      const addon = new RtspProviderAddon()
      await addon.initialize(makeAddonContext(ADDON_ID, devicesApi, api))
      const summary = await addon.createDevice({
        type: DeviceType.Camera,
        config: { name: 'Porch', streams: urls },
      })
      const catalogOf = async (deviceId: number): Promise<readonly string[] | null> => {
        const provider = capabilityRegistry.getNativeProvider<CatalogProvider>(
          streamCatalogCapability.name,
          deviceId,
        )
        if (!provider) return null
        return (await provider.getCatalog({ deviceId })).map((d) => d.camStreamId)
      }
      return {
        addon,
        registry,
        deviceStore,
        catalogOf,
        deviceId: summary.id,
        stableId: summary.stableId,
      }
    }

    it('a runner stop decommissions the camera and leaves its streams to the broker', async () => {
      const h = await bootWithCamera(['rtsp://porch/main', 'rtsp://porch/sub'])
      expect(await h.catalogOf(h.deviceId)).toEqual(['stream-1', 'stream-2'])

      // `BaseDeviceProvider.onShutdown` → kernel decommission → removeDevice().
      await h.addon.shutdown()

      expect(h.registry.getAllForAddon(ADDON_ID)).toHaveLength(0)
      // The camera is still in the fleet — a stop is not a removal.
      expect(h.deviceStore.listByAddon(ADDON_ID)).toHaveLength(1)
      // The broker dials the CAMERA; the runner is not on the byte path.
      expect(retractCameraStream).not.toHaveBeenCalled()
    })

    it('a rebuild (reloadDevice) retracts nothing and the new instance serves the same catalog', async () => {
      const h = await bootWithCamera(['rtsp://porch/main', 'rtsp://porch/sub'])

      await h.addon.reloadDevice({ stableId: h.stableId })

      expect(retractCameraStream).not.toHaveBeenCalled()
      expect(await h.catalogOf(h.deviceId)).toEqual(['stream-1', 'stream-2'])
    })

    it('an edit that drops a stream reaches the broker through the catalog, not a retract', async () => {
      const h = await bootWithCamera(['rtsp://porch/main', 'rtsp://porch/sub'])
      const camera = h.registry.getById(h.deviceId)
      if (!(camera instanceof RtspCamera)) throw new Error('registered device is not an RtspCamera')

      await camera.applySettingsPatch({ streams: ['rtsp://porch/main'] })

      // The broker's reconcile sees `stream-2` gone and retracts it once a
      // second pull agrees (D689) — the provider does not reach around it.
      expect(await h.catalogOf(h.deviceId)).toEqual(['stream-1'])
      expect(retractCameraStream).not.toHaveBeenCalled()
    })
  })
})
