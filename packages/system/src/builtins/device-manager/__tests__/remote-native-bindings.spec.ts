/**
 * Cross-process native-cap mirroring tests.
 *
 * Workers emit `device.bindings-changed` with `reason: 'native-registered'`
 * (and symmetric `native-unregistered` on removal). The hub's
 * DeviceManagerAddon subscribes to those events and mirrors them into
 * `remoteNativeCaps` so `getBindings` returns a unified view regardless of
 * which process owns the IDevice.
 */

import { DeviceRegistry } from '@camstack/system'
import {
  type AddonContext,
  EventCategory,
  type EventFilter,
  type IClusterBroker,
  type IEventBus,
  type IScopedLogger,
  type SystemEvent,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

interface ClusterTestHarness {
  readonly broker: IClusterBroker
  readonly emitNodeDisconnected: (nodeId: string) => void
  readonly emitNodeConnected: (nodeId: string) => void
  readonly registerNativeService: (
    nodeId: string,
    addonId: string,
    capName: string,
    deviceIds: readonly number[],
  ) => void
}

function makeCluster(): ClusterTestHarness {
  const busHandlers: Map<string, Array<(payload: { node: { id: string } }) => void>> = new Map()
  const services: Array<{ name: string; nodeID: string }> = []
  const serviceDevices: Map<string, readonly number[]> = new Map()
  const broker = {
    nodeID: 'hub',
    call: async <T = unknown>(action: string, params?: { grouping?: boolean }): Promise<T> => {
      // Moleculer's `$node.services` internal action. Faithful to the real
      // shape: only `grouping:false` yields per-(service,node) entries
      // carrying `nodeID` — the production call MUST pass it.
      if (action === '$node.services') {
        const perNode = params?.grouping === false
        return services.map((s) => (perNode ? s : { name: s.name })) as unknown as T
      }
      // Match `<addonId>.native-provider.<cap>.$listDeviceIds`.
      if (action.endsWith('.$listDeviceIds')) {
        const svcName = action.slice(0, -'.$listDeviceIds'.length)
        return (serviceDevices.get(svcName) ?? []) as unknown as T
      }
      return {} as T
    },
    waitForServices: async () => undefined,
    localBus: {
      on: (event: string, handler: (payload: { node: { id: string } }) => void) => {
        const list = busHandlers.get(event) ?? []
        list.push(handler)
        busHandlers.set(event, list)
      },
    },
  }
  const emitNodeDisconnected = (nodeId: string): void => {
    for (const h of busHandlers.get('$node.disconnected') ?? []) h({ node: { id: nodeId } })
  }
  const emitNodeConnected = (nodeId: string): void => {
    for (const h of busHandlers.get('$node.connected') ?? []) h({ node: { id: nodeId } })
  }
  const registerNativeService = (
    nodeId: string,
    addonId: string,
    capName: string,
    deviceIds: readonly number[],
  ): void => {
    const name = `${addonId}.native-provider.${capName}`
    services.push({ name, nodeID: nodeId })
    serviceDevices.set(name, deviceIds)
  }
  return {
    broker: broker as unknown as IClusterBroker,
    emitNodeDisconnected,
    emitNodeConnected,
    registerNativeService,
  }
}

async function setupAddon(
  cluster: ClusterTestHarness,
  eventHandlers: HandlerEntry[],
): Promise<DeviceManagerAddon> {
  const addon = new DeviceManagerAddon()
  const { api: settingsStoreApi } = await makeSettingsStoreApi()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: settingsStoreApi },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: makeEventBus(eventHandlers),
    addonConfig: {},
    dataDir: '/tmp',
    settings: makeSettings(),
    records,
    kernel: {
      deviceRegistry: new DeviceRegistry(),
      localNodeId: 'hub',
      cluster: { broker: cluster.broker },
    },
  }
  await addon.initialize(ctx as unknown as AddonContext)
  return addon
}

function emitRemoteBindingEvent(
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

describe('device-manager remote native-cap mirroring', () => {
  let cluster: ClusterTestHarness
  let handlers: HandlerEntry[]
  let addon: DeviceManagerAddon

  beforeEach(async () => {
    cluster = makeCluster()
    handlers = []
    addon = await setupAddon(cluster, handlers)
  })

  const RTSP_CAM_01 = 1
  const RTSP_CAM_02 = 2
  const ONVIF_CAM_09 = 9

  it('surfaces remote natives in getBindings after native-registered', async () => {
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    emitRemoteBindingEvent(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'snapshot',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'worker-rtsp-1',
    })

    const binding = await addon.getBindings({ deviceId: RTSP_CAM_01 })
    expect(binding.entries).toHaveLength(1)
    expect(binding.entries[0]).toMatchObject({
      capName: 'snapshot',
      kind: 'native',
      providerAddonId: 'provider-rtsp',
      nativeAddonId: 'provider-rtsp',
      providerNodeId: 'worker-rtsp-1',
    })
  })

  it('ignores events sourced from the local node (already in capabilityRegistry)', async () => {
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    emitRemoteBindingEvent(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'snapshot',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'hub',
    })

    const binding = await addon.getBindings({ deviceId: RTSP_CAM_01 })
    expect(binding.entries).toHaveLength(0)
  })

  it('drops the entry on native-unregistered', async () => {
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    emitRemoteBindingEvent(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'snapshot',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'worker-rtsp-1',
    })
    emitRemoteBindingEvent(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'snapshot',
      reason: 'native-unregistered',
      addonId: 'provider-rtsp',
      nodeId: 'worker-rtsp-1',
    })

    const binding = await addon.getBindings({ deviceId: RTSP_CAM_01 })
    expect(binding.entries).toHaveLength(0)
  })

  it("native-unregistered by ANOTHER addon never erases the entry (D663: the composer's ungraft vs the HA native); the owner's own unregister does", async () => {
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    const FEEDER = 50
    emitRemoteBindingEvent(bus, {
      deviceId: FEEDER,
      capName: 'battery',
      reason: 'native-registered',
      addonId: 'provider-homeassistant',
      nodeId: 'hub/provider-homeassistant',
    })
    emitRemoteBindingEvent(bus, {
      deviceId: FEEDER,
      capName: 'battery',
      reason: 'native-unregistered',
      addonId: 'composer',
      nodeId: 'hub/composer',
    })
    const kept = await addon.getBindings({ deviceId: FEEDER })
    expect(kept.entries).toHaveLength(1)
    expect(kept.entries[0]).toMatchObject({
      capName: 'battery',
      nativeAddonId: 'provider-homeassistant',
    })
    emitRemoteBindingEvent(bus, {
      deviceId: FEEDER,
      capName: 'battery',
      reason: 'native-unregistered',
      addonId: 'provider-homeassistant',
      nodeId: 'hub/provider-homeassistant',
    })
    expect((await addon.getBindings({ deviceId: FEEDER })).entries).toHaveLength(0)
  })

  it('native always wins (D663, I-2): a graft registered over a native leaves the native entry intact', async () => {
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    const FEEDER = 50
    const register = (addonId: string, nodeId: string) =>
      emitRemoteBindingEvent(bus, {
        deviceId: FEEDER,
        capName: 'battery',
        reason: 'native-registered',
        addonId,
        nodeId,
      })
    register('provider-homeassistant', 'hub/provider-homeassistant')
    register('composer', 'hub/composer')
    const [entry] = (await addon.getBindings({ deviceId: FEEDER })).entries
    expect(entry).toMatchObject({ capName: 'battery', nativeAddonId: 'provider-homeassistant' })
  })

  it('a native registered AFTER a graft replaces the graft entry', async () => {
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    const FEEDER = 50
    emitRemoteBindingEvent(bus, {
      deviceId: FEEDER,
      capName: 'battery',
      reason: 'native-registered',
      addonId: 'composer',
      nodeId: 'hub/composer',
    })
    emitRemoteBindingEvent(bus, {
      deviceId: FEEDER,
      capName: 'battery',
      reason: 'native-registered',
      addonId: 'provider-homeassistant',
      nodeId: 'hub/provider-homeassistant',
    })
    const [entry] = (await addon.getBindings({ deviceId: FEEDER })).entries
    expect(entry).toMatchObject({ capName: 'battery', nativeAddonId: 'provider-homeassistant' })
  })

  it('purges every remote entry when the owning node disconnects', async () => {
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    emitRemoteBindingEvent(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'snapshot',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'worker-rtsp-1',
    })
    emitRemoteBindingEvent(bus, {
      deviceId: RTSP_CAM_02,
      capName: 'snapshot',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'worker-rtsp-1',
    })
    emitRemoteBindingEvent(bus, {
      deviceId: ONVIF_CAM_09,
      capName: 'snapshot',
      reason: 'native-registered',
      addonId: 'provider-onvif',
      nodeId: 'worker-onvif-1',
    })

    cluster.emitNodeDisconnected('worker-rtsp-1')

    expect(await addon.getBindings({ deviceId: RTSP_CAM_01 })).toMatchObject({ entries: [] })
    expect(await addon.getBindings({ deviceId: RTSP_CAM_02 })).toMatchObject({ entries: [] })
    // Onvif worker entry still there — different node
    const onvif = await addon.getBindings({ deviceId: ONVIF_CAM_09 })
    expect(onvif.entries).toHaveLength(1)
    const onvifEntry = onvif.entries[0]
    if (!onvifEntry) throw new Error('expected onvif entry')
    expect(onvifEntry.providerNodeId).toBe('worker-onvif-1')
  })

  it('normalizes a hub-local child runner node id to the routable parent (hub)', async () => {
    // A hub-local addon child runs in its own addon-runner with the composite
    // node id `${parentNodeId}/${runnerId}` (addon-runner.ts) e.g.
    // 'hub/provider-reolink'. That composite is an IDENTITY, not a routable
    // pin: the CapRouteResolver reaches such a child only THROUGH its parent
    // (nodeId='hub' → hub-local-uds). DeviceProxy pins `providerNodeId` on
    // every cap call, so the binding MUST expose the routable parent, not the
    // composite — otherwise the call resolves to remote-moleculer → no-provider
    // and widget caps (motion-zones, privacy-mask) render "doesn't expose".
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    emitRemoteBindingEvent(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'motion-zones',
      reason: 'native-registered',
      addonId: 'provider-reolink',
      nodeId: 'hub/provider-reolink',
    })

    const binding = await addon.getBindings({ deviceId: RTSP_CAM_01 })
    const entry = binding.entries.find((e) => e.capName === 'motion-zones')
    if (!entry) throw new Error('expected motion-zones entry')
    expect(entry.providerNodeId).toBe('hub')
  })

  it('normalizes an agent child runner node id to the routable agent node', async () => {
    // Same rule for an agent-hosted native: 'dev-agent-0/provider-reolink'
    // routes via agent-child-forward to the agent node 'dev-agent-0'.
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    emitRemoteBindingEvent(bus, {
      deviceId: RTSP_CAM_02,
      capName: 'motion-zones',
      reason: 'native-registered',
      addonId: 'provider-reolink',
      nodeId: 'dev-agent-0/provider-reolink',
    })

    const binding = await addon.getBindings({ deviceId: RTSP_CAM_02 })
    const entry = binding.entries.find((e) => e.capName === 'motion-zones')
    if (!entry) throw new Error('expected motion-zones entry')
    expect(entry.providerNodeId).toBe('dev-agent-0')
  })

  it('remote native survives a second native-registered event (idempotent)', async () => {
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    emitRemoteBindingEvent(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'snapshot',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'worker-rtsp-1',
    })
    // Re-emit (e.g. worker restart replaying its caps) — should overwrite not duplicate
    emitRemoteBindingEvent(bus, {
      deviceId: RTSP_CAM_01,
      capName: 'snapshot',
      reason: 'native-registered',
      addonId: 'provider-rtsp',
      nodeId: 'worker-rtsp-2',
    })

    const binding = await addon.getBindings({ deviceId: RTSP_CAM_01 })
    expect(binding.entries).toHaveLength(1)
    const entry = binding.entries[0]
    if (!entry) throw new Error('expected one entry')
    expect(entry.providerNodeId).toBe('worker-rtsp-2')
  })

  it('surfaces remote natives from handshake-fed registry when push event was lost (D3 replacement for $node.connected pull)', async () => {
    // Task 13: the $node.connected pull sweep (`syncWorkerNativeCaps`) has
    // been removed. Recovery for lost push events now comes from the D3
    // re-handshake: after device restore, the worker sends $hub.registerNode
    // with nativeCaps, and `ctx.kernel.listClusterNativeCaps()` returns them
    // synchronously. This test verifies that `getBindings` step 4 falls
    // through to that accessor when `remoteNativeCaps` is empty.
    const clusterCaps = [
      {
        nodeId: 'hub/provider-reolink',
        addonId: 'provider-reolink',
        capName: 'snapshot',
        deviceId: RTSP_CAM_01,
      },
      {
        nodeId: 'hub/provider-reolink',
        addonId: 'provider-reolink',
        capName: 'snapshot',
        deviceId: RTSP_CAM_02,
      },
      {
        nodeId: 'hub/provider-reolink',
        addonId: 'provider-reolink',
        capName: 'intercom',
        deviceId: RTSP_CAM_01,
      },
    ]
    // Create a new addon with listClusterNativeCaps wired in.
    const addonWithCluster = new DeviceManagerAddon()
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    const { api: settingsStoreApi } = await makeSettingsStoreApi()
    const records2 = await makeRecordsAccessForOwner('device-manager')
    const ctx2 = {
      api: { settingsStore: settingsStoreApi },
      id: 'device-manager',
      logger: makeLogger(),
      eventBus: bus,
      addonConfig: {},
      dataDir: '/tmp',
      settings: makeSettings(),
      records: records2,
      kernel: {
        deviceRegistry: new DeviceRegistry(),
        localNodeId: 'hub',
        cluster: { broker: cluster.broker },
        // D3: inject the handshake-fed registry view.
        listClusterNativeCaps: () => clusterCaps,
      },
    }
    await addonWithCluster.initialize(ctx2 as unknown as AddonContext)

    // No push events fired — remoteNativeCaps is empty.
    // getBindings falls through to listClusterNativeCaps for step 4.
    const cam1 = await addonWithCluster.getBindings({ deviceId: RTSP_CAM_01 })
    const cam2 = await addonWithCluster.getBindings({ deviceId: RTSP_CAM_02 })

    const cam1Caps = cam1.entries
      .filter((e) => e.kind === 'native')
      .map((e) => e.capName)
      .toSorted()
    expect(cam1Caps).toEqual(['intercom', 'snapshot'])
    const cam2Caps = cam2.entries
      .filter((e) => e.kind === 'native')
      .map((e) => e.capName)
      .toSorted()
    expect(cam2Caps).toEqual(['snapshot'])
  })
})
