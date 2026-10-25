/**
 * `resolveNativeCapOwnerSync` — synchronous lookup backing the hub's
 * native-cap bridge. Returns the owning addon+node for a `(capName,
 * deviceId)` pair ONLY when a native provider has actually been
 * published. Used by `CapabilityRegistry.setNativeFallback` in
 * `addon-registry.service.ts`: the hub synthesizes a cross-process
 * Moleculer proxy only when this resolver returns a concrete owner.
 *
 * Regression guard: the previous `resolveDeviceOwnerSync`-based
 * fallback returned the device-class owner regardless of whether that
 * addon implemented the cap, so callers hit a non-existent Moleculer
 * service at runtime (`Service '<owner>.native-provider.<cap>.<m>' is
 * not found`). This suite pins the per-(cap, device) semantics.
 */

import { CapabilityRegistry, DeviceRegistry } from '@camstack/system'
import {
  type AddonContext,
  type AddonInitResult,
  EventCategory,
  type EventFilter,
  type IClusterBroker,
  type IEventBus,
  type IScopedLogger,
  type ProviderRegistration,
  type SystemEvent,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi, seedDeviceRow } from './settings-store-api.js'

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

interface HandlerEntry {
  readonly pattern: string
  readonly handler: (event: SystemEvent) => void
}

function makeEventBus(handlers: HandlerEntry[]): IEventBus {
  return {
    emit: vi.fn((event: SystemEvent) => {
      for (const { pattern, handler } of handlers) {
        if (event.category === pattern) handler(event)
      }
    }),
    subscribe: vi.fn((filter: EventFilter | string, handler: (event: SystemEvent) => void) => {
      const pattern =
        typeof filter === 'string'
          ? filter
          : typeof filter.category === 'string'
            ? filter.category
            : String(filter.category ?? '*')
      const entry: HandlerEntry = { pattern, handler }
      handlers.push(entry)
      return () => {
        const idx = handlers.indexOf(entry)
        if (idx >= 0) handlers.splice(idx, 1)
      }
    }),
    getRecent: vi.fn(() => []),
  } as unknown as IEventBus
}

function makeSettings() {
  const addonStore: Record<string, unknown> = {}
  const deviceStores: Record<number, Record<string, unknown>> = {}
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore: vi.fn(async (id: number) => ({ ...deviceStores[id] })),
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
  }
}

type BusHandler = (payload: { node: { id: string } }) => void

interface ClusterBusHandlers {
  readonly nodeConnected: BusHandler[]
  readonly nodeDisconnected: BusHandler[]
}

/**
 * Describes the `*.native-provider.*` services a (simulated) forked
 * worker exposes — retained to keep the `makeCluster` mock functional
 * for tests that still use it (e.g. "$node.connected seed ignores root nodes").
 */
interface WorkerNativeFixture {
  readonly nodeId: string
  readonly services: ReadonlyArray<{ readonly name: string; readonly deviceIds: readonly number[] }>
}

/** Entry shape for the handshake-fed `listClusterNativeCaps` injection. */
interface ClusterNativeCapEntry {
  readonly nodeId: string
  readonly addonId: string
  readonly capName: string
  readonly deviceId: number
}

function makeCluster(
  busHandlers?: ClusterBusHandlers,
  worker?: WorkerNativeFixture,
): IClusterBroker {
  const LIST_SUFFIX = '.$listDeviceIds'
  const broker = {
    nodeID: 'hub',
    call: async <T = unknown>(action: string, params?: { grouping?: boolean }): Promise<T> => {
      // Faithful to Moleculer's `$node.services`: only `grouping:false`
      // yields per-(service,node) entries carrying `nodeID`. If the
      // production call ever drops `grouping:false`, the entries lose
      // `nodeID` and the nodeID-keyed filter fails — caught by the tests.
      if (action === '$node.services') {
        const perNode = params?.grouping === false
        return (worker
          ? worker.services.map((s) =>
              perNode ? { name: s.name, nodeID: worker.nodeId } : { name: s.name },
            )
          : []) as unknown as T
      }
      if (worker && action.endsWith(LIST_SUFFIX)) {
        const svcName = action.slice(0, -LIST_SUFFIX.length)
        const svc = worker.services.find((s) => s.name === svcName)
        return (svc ? [...svc.deviceIds] : []) as unknown as T
      }
      return {} as T
    },
    waitForServices: async () => undefined,
    localBus: {
      on: (eventName: string, handler: BusHandler) => {
        if (!busHandlers) return
        if (eventName === '$node.connected') busHandlers.nodeConnected.push(handler)
        else if (eventName === '$node.disconnected') busHandlers.nodeDisconnected.push(handler)
      },
    },
  }
  return broker as unknown as IClusterBroker
}

interface ResolverProvider {
  resolveNativeCapOwnerSync: (
    capName: string,
    deviceId: number,
  ) => { addonId: string; nodeId: string } | null
  resolveDeviceOwnerSync: (deviceId: number) => string | null
}

async function setupAddon(
  handlers: HandlerEntry[],
  opts: {
    persistedDevices?: ReadonlyArray<{
      addonId: string
      stableId: string
      id: number
      name?: string
    }>
    worker?: WorkerNativeFixture
    /**
     * D3 handshake-fed native caps injected via `ctx.kernel.listClusterNativeCaps`.
     * Replaces the pull-based `syncWorkerNativeCaps` as the recovery source for
     * push events lost in the Moleculer transport handshake window.
     */
    clusterNativeCaps?: ReadonlyArray<ClusterNativeCapEntry>
  } = {},
): Promise<{
  addon: DeviceManagerAddon
  registry: CapabilityRegistry
  provider: ResolverProvider
  bus: IEventBus
  busHandlers: ClusterBusHandlers
}> {
  const addon = new DeviceManagerAddon()
  const registry = new CapabilityRegistry(makeLogger())
  const bus = makeEventBus(handlers)
  const busHandlers: ClusterBusHandlers = { nodeConnected: [], nodeDisconnected: [] }
  const settings = makeSettings()
  const clusterNativeCaps = opts.clusterNativeCaps ?? []
  const store = await makeSettingsStoreApi()
  const settingsStoreApi = store.api
  // Seeded BEFORE `initialize`: the addon warms `idToAddonId` from the ledger
  // at boot, so a device written afterwards would not be an owned device as far
  // as the sync resolvers are concerned.
  for (const d of opts.persistedDevices ?? []) {
    await seedDeviceRow(store, {
      deviceId: d.id,
      type: 'camera',
      addonId: d.addonId,
      stableId: d.stableId,
      ...(d.name !== undefined ? { name: d.name } : {}),
    })
  }
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
    kernel: {
      deviceRegistry: new DeviceRegistry(),
      localNodeId: 'hub',
      cluster: { broker: makeCluster(busHandlers, opts.worker) },
      capabilityRegistry: registry,
      // D3: handshake-fed registry — mirrors what MoleculerService.listClusterNativeCaps()
      // returns after each $hub.registerNode re-handshake (post device restore).
      listClusterNativeCaps: () => clusterNativeCaps,
    },
  }
  const result = (await addon.initialize(ctx as unknown as AddonContext)) as
    | AddonInitResult
    | undefined
  const registrations: readonly ProviderRegistration[] = result?.providers ?? []
  const first = registrations[0]
  if (!first) throw new Error('device-manager addon returned no provider registrations')
  const provider = first.provider as ResolverProvider
  return { addon, registry, provider, bus, busHandlers }
}

function emitRemoteBinding(
  bus: IEventBus,
  payload: {
    deviceId: number
    capName: string
    reason: 'native-registered' | 'native-unregistered'
    addonId: string
    nodeId: string
  },
): void {
  bus.emit({
    id: 'evt-' + Math.random().toString(36).slice(2),
    timestamp: new Date(),
    source: { type: 'device', id: payload.deviceId },
    category: EventCategory.DeviceBindingsChanged,
    data: payload,
  })
}

describe('device-manager resolveNativeCapOwnerSync', () => {
  let handlers: HandlerEntry[]

  beforeEach(() => {
    handlers = []
  })

  const RTSP_CAM_01 = 1
  const ONVIF_CAM_02 = 2

  it('returns null when no native provider has been published for (cap, device)', async () => {
    const { provider } = await setupAddon(handlers)
    expect(provider.resolveNativeCapOwnerSync('snapshot', RTSP_CAM_01)).toBeNull()
  })

  it('does NOT confuse device ownership with cap ownership', async () => {
    // Register the device under an owner, but do NOT publish the snapshot cap.
    // Legacy behaviour: resolveDeviceOwnerSync would return 'provider-rtsp' and
    // a naive fallback would synthesize a phantom snapshot proxy. The
    // cap-aware resolver must return null.
    const { provider, bus } = await setupAddon(handlers)
    // Register device-ops as a remote native (the only cap provider-rtsp
    // actually publishes for a basic RTSP camera). Snapshot is NOT registered.
    emitRemoteBinding(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'device-ops',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })

    expect(provider.resolveNativeCapOwnerSync('device-ops', RTSP_CAM_01)).toEqual({
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
    expect(provider.resolveNativeCapOwnerSync('snapshot', RTSP_CAM_01)).toBeNull()
    // resolveDeviceOwnerSync (persistence-owner path) stays unchanged by the
    // new resolver — the two helpers answer different questions.
    expect(provider.resolveDeviceOwnerSync(RTSP_CAM_01)).toBeNull()
  })

  it('returns hub-local owner when the cap is registered in-process', async () => {
    const { provider, registry } = await setupAddon(handlers)
    registry.registerNativeProvider('snapshot', ONVIF_CAM_02, 'provider-onvif', {})
    expect(provider.resolveNativeCapOwnerSync('snapshot', ONVIF_CAM_02)).toEqual({
      addonId: 'provider-onvif',
      nodeId: 'hub',
    })
  })

  it('returns remote-worker owner when the cap is published via DeviceBindingsChanged', async () => {
    const { provider, bus } = await setupAddon(handlers)
    emitRemoteBinding(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'snapshot',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
    expect(provider.resolveNativeCapOwnerSync('snapshot', RTSP_CAM_01)).toEqual({
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
  })

  it('drops the entry on native-unregistered', async () => {
    const { provider, bus } = await setupAddon(handlers)
    emitRemoteBinding(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'snapshot',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
    emitRemoteBinding(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'snapshot',
      reason: 'native-unregistered',
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
    expect(provider.resolveNativeCapOwnerSync('snapshot', RTSP_CAM_01)).toBeNull()
  })

  // D3 regression guard: when `DeviceBindingsChanged native-registered`
  // broadcasts are lost in the Moleculer transport handshake window, the
  // handshake-fed `HubNodeRegistry` (via `ctx.kernel.listClusterNativeCaps`)
  // is the reliable fallback. The previous pull-based `syncWorkerNativeCaps`
  // (triggered by `$node.connected`) has been removed in Task 13; this test
  // verifies the replacement.
  it('resolves from handshake-fed registry when push event was lost ($node.connected recovery replaced by D3)', async () => {
    const { provider } = await setupAddon(handlers, {
      persistedDevices: [{ addonId: 'provider-rtsp', stableId: 'hall', id: RTSP_CAM_01 }],
      // Simulate the state after the D3 re-handshake: the hub's HubNodeRegistry
      // is already populated with the worker's native caps (because the worker
      // sent `$hub.registerNode` with nativeCaps after device restore), but the
      // push `DeviceBindingsChanged` event was lost in the transport window.
      clusterNativeCaps: [
        {
          nodeId: 'hub/provider-rtsp',
          addonId: 'provider-rtsp',
          capName: 'device-ops',
          deviceId: RTSP_CAM_01,
        },
      ],
    })
    // No push event arrived — `remoteNativeCaps` is empty.
    // But the handshake-fed registry has the entry → resolver returns it.
    expect(provider.resolveNativeCapOwnerSync('device-ops', RTSP_CAM_01)).toEqual({
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
    // Caps the handshake did not include stay unresolved.
    expect(provider.resolveNativeCapOwnerSync('snapshot', RTSP_CAM_01)).toBeNull()
  })

  it('$node.connected seed ignores root nodes (no slash in id)', async () => {
    const { provider, busHandlers } = await setupAddon(handlers, {
      persistedDevices: [{ addonId: 'provider-rtsp', stableId: 'hall', id: RTSP_CAM_01 }],
    })
    for (const h of busHandlers.nodeConnected) h({ node: { id: 'hub' } })
    for (const h of busHandlers.nodeConnected) h({ node: { id: 'agent-0' } })
    expect(provider.resolveNativeCapOwnerSync('device-ops', RTSP_CAM_01)).toBeNull()
  })

  it('$node.connected seed does not shadow a hub-local native registration', async () => {
    const { provider, registry, busHandlers } = await setupAddon(handlers, {
      persistedDevices: [{ addonId: 'provider-rtsp', stableId: 'hall', id: RTSP_CAM_01 }],
    })
    // Hub-local registration wins — seed must not overwrite it.
    registry.registerNativeProvider('device-ops', RTSP_CAM_01, 'provider-rtsp-hub-local', {})
    for (const h of busHandlers.nodeConnected) h({ node: { id: 'hub/provider-rtsp' } })
    expect(provider.resolveNativeCapOwnerSync('device-ops', RTSP_CAM_01)).toEqual({
      addonId: 'provider-rtsp-hub-local',
      nodeId: 'hub',
    })
  })

  it('a late-arriving native-registered event overwrites the $node.connected seed', async () => {
    const { provider, bus, busHandlers } = await setupAddon(handlers, {
      persistedDevices: [{ addonId: 'provider-rtsp', stableId: 'hall', id: RTSP_CAM_01 }],
    })
    for (const h of busHandlers.nodeConnected) h({ node: { id: 'hub/provider-rtsp' } })
    // Now the real event fires with the authoritative payload. The resolver
    // already returns the seeded equivalent, but this guards against the
    // reverse: a real event with a DIFFERENT nodeId (e.g. after re-fork)
    // must win over the stale seed.
    emitRemoteBinding(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'device-ops',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp-worker-2',
    })
    expect(provider.resolveNativeCapOwnerSync('device-ops', RTSP_CAM_01)).toEqual({
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp-worker-2',
    })
  })

  // D3 regression guard: after `restartAddon`, the respawned worker's
  // `registerNativeCap` re-broadcasts may be lost in the post-restart
  // transport handshake window. The D3 re-handshake (fired after device
  // restore completes) populates `HubNodeRegistry` reliably. Task 13
  // removes the `addon.restarted`-driven pull sweep; this test verifies the
  // handshake-fed fallback path works instead.
  it('recovers native caps from handshake-fed registry after re-registration broadcasts were lost (restartAddon scenario)', async () => {
    // The worker restarted: `native-unregistered` broadcast arrived (clearing push
    // cache), but the respawn's `native-registered` re-broadcasts were lost —
    // push cache is empty. The D3 re-handshake has already populated
    // `HubNodeRegistry` (clusterNativeCaps). The resolver falls through to it.
    const { provider, bus } = await setupAddon(handlers, {
      persistedDevices: [{ addonId: 'provider-rtsp', stableId: 'hall', id: RTSP_CAM_01 }],
      clusterNativeCaps: [
        {
          nodeId: 'hub/provider-rtsp',
          addonId: 'provider-rtsp',
          capName: 'device-ops',
          deviceId: RTSP_CAM_01,
        },
        {
          nodeId: 'hub/provider-rtsp',
          addonId: 'provider-rtsp',
          capName: 'switch',
          deviceId: RTSP_CAM_01,
        },
      ],
    })
    // Simulate the push-fed cap arriving then being removed by unregistered
    // (push cache ends up empty for switch on this device).
    emitRemoteBinding(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'switch',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
    emitRemoteBinding(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'switch',
      reason: 'native-unregistered',
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
    // Push cache is empty for `switch`. But the D3 re-handshake populated the
    // registry → the fallback resolves it synchronously (no async poll).
    expect(provider.resolveNativeCapOwnerSync('switch', RTSP_CAM_01)).toEqual({
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
    expect(provider.resolveNativeCapOwnerSync('device-ops', RTSP_CAM_01)).toEqual({
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
  })

  it('handshake-fed registry is the reliable fallback for broadcast-loss on addon restart', async () => {
    // Fully isolated test: no push events at all — only handshake-fed data.
    // Verifies the fallback path in isolation.
    const { provider } = await setupAddon(handlers, {
      persistedDevices: [{ addonId: 'provider-rtsp', stableId: 'hall', id: RTSP_CAM_01 }],
      clusterNativeCaps: [
        {
          nodeId: 'hub/provider-rtsp',
          addonId: 'provider-rtsp',
          capName: 'device-ops',
          deviceId: RTSP_CAM_01,
        },
        {
          nodeId: 'hub/provider-rtsp',
          addonId: 'provider-rtsp',
          capName: 'switch',
          deviceId: RTSP_CAM_01,
        },
      ],
    })
    // Push cache is empty (no DeviceBindingsChanged events fired), but the
    // handshake-fed registry has both caps → resolver returns the correct owner.
    expect(provider.resolveNativeCapOwnerSync('switch', RTSP_CAM_01)).toEqual({
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
    expect(provider.resolveNativeCapOwnerSync('device-ops', RTSP_CAM_01)).toEqual({
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp',
    })
    // Caps not in the registry stay unresolved.
    expect(provider.resolveNativeCapOwnerSync('snapshot', RTSP_CAM_01)).toBeNull()
  })

  it('push-fed entry wins over handshake-fed when both are present', async () => {
    // The push-fed cache gets a different nodeId (e.g. after re-fork) — it
    // must win over the stale handshake-fed registry entry.
    const { provider, bus } = await setupAddon(handlers, {
      clusterNativeCaps: [
        {
          nodeId: 'hub/provider-rtsp-old',
          addonId: 'provider-rtsp',
          capName: 'device-ops',
          deviceId: RTSP_CAM_01,
        },
      ],
    })
    // Push event with newer nodeId arrives.
    emitRemoteBinding(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'device-ops',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp-new',
    })
    // Push wins.
    expect(provider.resolveNativeCapOwnerSync('device-ops', RTSP_CAM_01)).toEqual({
      addonId: 'provider-rtsp',
      nodeId: 'hub/provider-rtsp-new',
    })
  })
})
