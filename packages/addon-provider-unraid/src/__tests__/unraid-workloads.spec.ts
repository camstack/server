/**
 * Docker containers and VMs are candidates of the integration, like the server itself:
 * nothing is created until the operator adopts one, and each adopted one is its own
 * top-level device named after it. A list that could not be read removes nothing.
 */
import {
  type DeviceConstructor,
  type DeviceContext,
  DeviceRole,
  DeviceType,
  type IDeviceRuntimeState,
  type WorkloadOptions,
  type WorkloadStatus,
  type IDevice,
  type InitialDeviceMeta,
  type IScopedLogger,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsToConnection, UNRAID_SYSTEM } from '../config.js'
import { UnraidProviderAddon } from '../addon.js'
import { UnraidInstanceDevice } from '../devices/unraid-instance-device.js'
import { UnraidWorkloadDevice } from '../devices/unraid-workload-device.js'
import { buildUnraidAdoptionProvider } from '../unraid-adoption-provider.js'
import type {
  UnraidClientLike,
  UnraidContainerInfo,
  UnraidSnapshot,
} from '../unraid-client-contract.js'
import { buildUnraidDeviceAdopter } from '../unraid-device-adopter.js'
import {
  buildUnraidCandidates,
  UNRAID_GATEWAY_ID,
  UNRAID_INSTANCE_ID,
} from '../unraid-discovery.js'
import { reconcileInstanceEntities } from '../unraid-entity-reconcile.js'
import { UnraidIntegrationManager } from '../unraid-integration-manager.js'
import { unraidInstances } from '../unraid-node-resolver.js'
import { buildEntityIdentities } from '../unraid-mapping.js'

const INT = 'int-1'
const SERVER = '4b0175070bd2bdbc14112e80333b73341203a1e3197cc6c8a1b2c3d4e5f60718'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const container = (local: string, name: string): UnraidContainerInfo => ({
  id: `${SERVER}:${local}`,
  name,
  state: 'running',
  image: `${name}:latest`,
  autostart: true,
  updateAvailable: null,
  cpuPercent: 1,
  memPercent: 2,
})

function snapshot(over: Partial<UnraidSnapshot> = {}): UnraidSnapshot {
  return {
    array: {
      state: 'STARTED',
      capacityKb: { total: 1000, used: 400, free: 600 },
      parityCheck: null,
      disks: [],
    },
    cpu: { percent: 12, tempC: null, powerW: null },
    disks: [],
    dockers: [container('aaa', 'plex'), container('bbb', 'sonarr')],
    vms: [{ id: `${SERVER}:uuid-ccu`, name: 'CCU3', state: 'running' }],
    notifications: { activeCount: 0, latest: null },
    hostname: 'tower',
    ...over,
  }
}

describe('Unraid discovery: the server, each container and each VM', () => {
  it('lists the Gateway, the server, N containers and M VMs as separate candidates', () => {
    const candidates = buildUnraidCandidates({
      server: { name: 'Tower', online: true, hostname: 'tower' },
      dockers: snapshot().dockers,
      vms: snapshot().vms,
      adopted: new Map([['docker:plex', 42]]),
    })
    expect(candidates.map((c) => [c.childNativeId, c.name, c.type])).toEqual([
      [UNRAID_GATEWAY_ID, expect.any(String), DeviceType.Gateway],
      [UNRAID_INSTANCE_ID, 'Tower', DeviceType.Workload],
      ['docker:plex', 'plex', DeviceType.Workload],
      ['docker:sonarr', 'sonarr', DeviceType.Workload],
      ['vm:uuid-ccu', 'CCU3', DeviceType.Workload],
    ])
    expect(candidates.find((c) => c.childNativeId === 'docker:plex')?.adoptedDeviceId).toBe(42)
    expect(candidates.find((c) => c.childNativeId === 'vm:uuid-ccu')?.alreadyAdopted).toBe(false)
  })

  it('a list that could not be read proposes nothing new from it', () => {
    const candidates = buildUnraidCandidates({
      server: { name: 'Tower', online: true },
      dockers: null,
      vms: null,
      adopted: new Map(),
    })
    expect(candidates.map((c) => c.childNativeId)).toEqual([UNRAID_GATEWAY_ID, UNRAID_INSTANCE_ID])
  })

  it('container and VM entities are no longer children of the server', () => {
    const keys = buildEntityIdentities(snapshot()).map((i) => i.key)
    expect(keys.some((k) => k.includes('container'))).toBe(false)
    expect(keys.some((k) => k.startsWith('vm'))).toBe(false)
  })
})

interface Created {
  readonly stableId: string
  readonly cls: unknown
  readonly config: Record<string, unknown>
  readonly parentDeviceId: number | null | undefined
  readonly meta: InitialDeviceMeta | undefined
}

function adoptionHarness(current: UnraidSnapshot | null) {
  const created: Created[] = []
  const removed: number[] = []
  let next = 10
  const devices = {
    create: async <T extends IDevice>(
      stableId: string,
      cls: DeviceConstructor<T>,
      config: Record<string, unknown>,
      parentDeviceId?: number | null,
      meta?: InitialDeviceMeta,
    ): Promise<T> => {
      created.push({ stableId, cls, config, parentDeviceId, meta })
      return Object.assign(Object.create(cls.prototype), { id: next++ })
    },
    getChildren: async () => [],
  }
  const adopted = new Map<number, Record<string, unknown>>()
  const adopter = buildUnraidDeviceAdopter({ devices, getSnapshot: () => current })
  const record =
    (nativeId: string) =>
    <R extends { readonly deviceId: number }>(out: R): R => {
      adopted.set(out.deviceId, { system: UNRAID_SYSTEM, integrationId: INT, nativeId })
      return out
    }
  const provider = buildUnraidAdoptionProvider({
    getSnapshot: () => current,
    hasIntegration: (id) => id === INT,
    listIntegrations: () => [INT],
    integrationName: () => 'Tower',
    listAdopted: async () => [...adopted].map(([id, config]) => ({ id, config })),
    adoptGateway: async (input) => record(UNRAID_GATEWAY_ID)(await adopter.adoptGateway(input)),
    adoptInstance: async (input) => record(UNRAID_INSTANCE_ID)(await adopter.adoptInstance(input)),
    adoptWorkload: async (input) => record(input.nativeId)(await adopter.adoptWorkload(input)),
    childDeviceIds: async () => [],
    removeDevice: async (id) => void removed.push(id),
    findDeviceConfig: async () => null,
    logger: quiet,
  })
  return { provider, created, removed, adopted }
}

describe('Unraid adoption: a container or a VM is its own device', () => {
  it('adopting a container creates exactly that device, named after it, top-level', async () => {
    const { provider, created } = adoptionHarness(snapshot())
    const out = await provider.adopt({ integrationId: INT, childNativeIds: ['docker:sonarr'] })
    expect(out.adopted).toHaveLength(1)
    expect(created).toHaveLength(1)
    const [device] = created
    expect(device?.stableId).toBe(`unraid:${INT}:docker:sonarr`)
    expect(device?.cls).toBe(UnraidWorkloadDevice)
    expect(device?.parentDeviceId).toBeNull()
    expect(device?.meta).toMatchObject({
      type: DeviceType.Workload,
      role: DeviceRole.AppContainer,
      name: 'sonarr',
      integrationId: INT,
    })
    expect(device?.config).toMatchObject({
      nativeId: 'docker:sonarr',
      integrationId: INT,
      system: UNRAID_SYSTEM,
      workload: { kind: 'docker', name: 'sonarr' },
    })
  })

  it('adopting a VM creates that VM, keyed on its domain id, not the server prefix', async () => {
    const { provider, created } = adoptionHarness(snapshot())
    await provider.adopt({ integrationId: INT, childNativeIds: ['vm:uuid-ccu'] })
    expect(created.map((c) => [c.stableId, c.meta?.name, c.meta?.type, c.meta?.role])).toEqual([
      [`unraid:${INT}:vm:uuid-ccu`, 'CCU3', DeviceType.Workload, DeviceRole.Vm],
    ])
    expect(created[0]?.config['workload']).toEqual({ kind: 'vm', localId: 'uuid-ccu' })
  })

  it('adopting the server creates it as the workload host', async () => {
    const { provider, created } = adoptionHarness(snapshot())
    await provider.adopt({ integrationId: INT, childNativeIds: [UNRAID_INSTANCE_ID] })
    expect(created[0]?.cls).toBe(UnraidInstanceDevice)
    expect(created[0]?.meta).toMatchObject({ type: DeviceType.Workload, role: DeviceRole.Host })
  })

  it('a retried adopt is a no-op, and a name not on the server is refused', async () => {
    const { provider, created } = adoptionHarness(snapshot())
    await provider.adopt({ integrationId: INT, childNativeIds: ['docker:plex'] })
    await provider.adopt({ integrationId: INT, childNativeIds: ['docker:plex'] })
    expect(created).toHaveLength(1)
    await expect(
      provider.adopt({ integrationId: INT, childNativeIds: ['docker:gone'] }),
    ).rejects.toThrow()
  })
})

describe('Unraid: a failed docker read keeps the devices', () => {
  function fakeClient(dockerList: () => Promise<readonly UnraidContainerInfo[]>): UnraidClientLike {
    const done = async (): Promise<void> => undefined
    return {
      connect: done,
      disconnect: done,
      array: {
        get: async () => snapshot().array,
        setState: done,
        parity: { start: done, cancel: done },
      },
      docker: { list: dockerList, start: done, stop: done, pause: done, unpause: done },
      vms: {
        list: async () => [],
        start: done,
        stop: done,
        pause: done,
        resume: done,
        forceStop: done,
        reboot: done,
      },
      system: { cpu: async () => snapshot().cpu },
      notifications: { active: async () => snapshot().notifications },
    }
  }

  it('the docker list failing is unknown (null), and the rest of the poll lands', async () => {
    const manager = new UnraidIntegrationManager({
      id: INT,
      name: 'Tower',
      connection: settingsToConnection({ host: 'tower.example.com', apiKey: 'k' }),
      logger: quiet,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
      makeClient: () =>
        fakeClient(async () => {
          throw new Error('docker service stopped')
        }),
    })
    await manager.start()
    expect(manager.getSnapshot()?.dockers).toBeNull()
    expect(manager.getSnapshot()?.array.state).toBe('STARTED')
    await manager.stop()
  })

  it('an adopted container survives a poll whose docker list failed', async () => {
    const live = snapshot()
    const { provider, removed, adopted } = adoptionHarness(live)
    await provider.adopt({ integrationId: INT, childNativeIds: ['docker:plex'] })
    const failed = snapshot({ dockers: null, vms: null })
    // The server's own entities do not depend on the docker list: nothing to re-persist.
    const apply = vi.fn(async () => undefined)
    const changed = await reconcileInstanceEntities({
      reg: { getAllForAddon: () => [{ id: 5, parentDeviceId: null }] },
      devices: {
        loadConfig: async () => ({
          system: UNRAID_SYSTEM,
          integrationId: INT,
          nativeId: UNRAID_INSTANCE_ID,
          entities: buildEntityIdentities(live),
        }),
        applyDerivedSpec: apply,
      },
      addonId: 'provider-unraid',
      integrationId: INT,
      snapshot: failed,
      logger: quiet,
    })
    expect(changed).toBe(0)
    expect(apply).not.toHaveBeenCalled()
    expect(removed).toEqual([])
    expect([...adopted.values()].map((c) => c['nativeId'])).toEqual(['docker:plex'])
  })
})

interface WorkloadProviderView {
  getOptions(input: { deviceId: number }): Promise<WorkloadOptions>
  readonly start?: (input: { deviceId: number }) => Promise<void>
  readonly stop?: (input: { deviceId: number }) => Promise<void>
  readonly restart?: (input: { deviceId: number }) => Promise<void>
  readonly pause?: (input: { deviceId: number }) => Promise<void>
  readonly resume?: (input: { deviceId: number }) => Promise<void>
  readonly forceStop?: (input: { deviceId: number }) => Promise<void>
}

function isWorkloadProvider(value: unknown): value is WorkloadProviderView {
  return typeof value === 'object' && value !== null && 'getOptions' in value
}

/** A stub device context: only what the device reads. */
function rig(config: Record<string, unknown>, id: number) {
  const providers = new Map<string, unknown>()
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id,
    stableId: `unraid:${INT}:x`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Workload,
      name: 'w',
      location: null,
      disabled: false,
      addonId: 'provider-unraid',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }, provider: unknown) => {
      providers.set(cap.name, provider)
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {},
    logger: quiet,
  } as unknown as DeviceContext
  return { ctx, providers }
}

describe('Unraid workload devices serve the workload cap', () => {
  afterEach(() => unraidInstances.clear())

  async function live() {
    const done = async (): Promise<void> => undefined
    const calls: string[] = []
    const rec =
      (what: string) =>
      async (id: string): Promise<void> => {
        calls.push(`${what} ${id}`)
      }
    const client: UnraidClientLike = {
      connect: done,
      disconnect: done,
      array: {
        get: async () => snapshot().array,
        setState: done,
        parity: { start: done, cancel: done },
      },
      docker: {
        list: async () => snapshot().dockers ?? [],
        start: rec('docker.start'),
        stop: rec('docker.stop'),
        pause: rec('docker.pause'),
        unpause: rec('docker.unpause'),
      },
      vms: {
        list: async () => snapshot().vms ?? [],
        start: rec('vm.start'),
        stop: rec('vm.stop'),
        pause: rec('vm.pause'),
        resume: rec('vm.resume'),
        forceStop: rec('vm.forceStop'),
        reboot: rec('vm.reboot'),
      },
      system: { cpu: async () => snapshot().cpu },
      notifications: { active: async () => snapshot().notifications },
    }
    const manager = new UnraidIntegrationManager({
      id: INT,
      name: 'Tower',
      connection: settingsToConnection({ host: 'tower.example.com', apiKey: 'k' }),
      logger: quiet,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
      makeClient: () => client,
    })
    await manager.start()
    unraidInstances.set(INT, manager)
    return { calls, manager }
  }

  const SERVER_CONFIG = {
    instanceId: INT,
    integrationId: INT,
    nativeId: UNRAID_INSTANCE_ID,
    entities: [],
  }

  it('a container: state from the snapshot, the server as host, docker controls by live id, a power switch', async () => {
    const { calls, manager } = await live()
    await new UnraidInstanceDevice(rig(SERVER_CONFIG, 42).ctx).onActivate()
    const { ctx, providers } = rig(
      { nativeId: 'docker:plex', integrationId: INT, workload: { kind: 'docker', name: 'plex' } },
      50,
    )
    const device = new UnraidWorkloadDevice(ctx)
    await device.onActivate()
    const workload = providers.get('workload')
    if (!isWorkloadProvider(workload)) throw new Error('workload cap missing')
    expect(providers.has('switch')).toBe(true)
    const slice = device.runtimeState.getCapState<WorkloadStatus>('workload')
    expect(slice?.state).toBe('running')
    expect(slice?.hostDeviceId).toBe(42)
    expect(slice?.image).toBe('plex:latest')
    expect(workload.restart).toBeUndefined()
    expect(workload.forceStop).toBeUndefined()
    await workload.stop?.({ deviceId: 50 })
    await workload.pause?.({ deviceId: 50 })
    await workload.resume?.({ deviceId: 50 })
    expect(calls).toEqual([
      `docker.stop ${SERVER}:aaa`,
      `docker.pause ${SERVER}:aaa`,
      `docker.unpause ${SERVER}:aaa`,
    ])
    await manager.stop()
  })

  it('a VM: reboot is its restart, force stop is served', async () => {
    const { calls, manager } = await live()
    const { ctx, providers } = rig(
      {
        nativeId: 'vm:uuid-ccu',
        integrationId: INT,
        workload: { kind: 'vm', localId: 'uuid-ccu' },
      },
      51,
    )
    await new UnraidWorkloadDevice(ctx).onActivate()
    const workload = providers.get('workload')
    if (!isWorkloadProvider(workload)) throw new Error('workload cap missing')
    expect((await workload.getOptions({ deviceId: 51 })).supportsRestart).toBe(true)
    await workload.restart?.({ deviceId: 51 })
    await workload.forceStop?.({ deviceId: 51 })
    expect(calls).toEqual([`vm.reboot ${SERVER}:uuid-ccu`, `vm.forceStop ${SERVER}:uuid-ccu`])
    await manager.stop()
  })

  it('the server serves the workload cap as a host with no controls and no switch', async () => {
    const { manager } = await live()
    const { ctx, providers } = rig(SERVER_CONFIG, 42)
    const server = new UnraidInstanceDevice(ctx)
    await server.onActivate()
    expect(providers.has('workload')).toBe(true)
    expect(providers.has('switch')).toBe(false)
    const slice = server.runtimeState.getCapState<WorkloadStatus>('workload')
    expect(slice?.state).toBe('running')
    expect(slice?.resources.cpuPercent).toBe(12)
    await manager.stop()
  })

  it('a persisted workload row is rebuilt with the right class: the server vs a container', () => {
    class Inspectable extends UnraidProviderAddon {
      classFor(stableId: string) {
        return this.deviceClassForRow({ type: DeviceType.Workload, stableId })
      }
    }
    const addon = new Inspectable()
    expect(addon.classFor(`unraid:${INT}:${UNRAID_INSTANCE_ID}`)).toBe(UnraidInstanceDevice)
    expect(addon.classFor(`unraid:${INT}:docker:plex`)).toBe(UnraidWorkloadDevice)
    expect(addon.classFor(`unraid:${INT}:vm:uuid-ccu`)).toBe(UnraidWorkloadDevice)
  })
})
