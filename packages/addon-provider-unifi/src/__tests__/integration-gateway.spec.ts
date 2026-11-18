/**
 * A new UniFi integration produces the controller's infra hosts (a console is the Host the
 * integration talks to; there is no Gateway, D1064) and its client Presence devices as
 * top-level SIBLINGS, with the connection (and its credentials,
 * keychain secrets) on the integration. The device context is the one boundary a spec
 * fakes; the registry, resolver, adopter and adoption provider are the real code.
 */
import {
  type DeviceConstructor,
  type DeviceContext,
  DeviceRole,
  DeviceType,
  type IDevice,
  type IDeviceRuntimeState,
  type IScopedLogger,
  type InitialDeviceMeta,
  type WorkloadOptions,
  type WorkloadStatus,
  makeInMemoryRecords,
  secretTreeFromSchema,
  type SwitchOptions,
  type SetIdentifiersInput,
} from '@camstack/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnifiProviderAddon } from '../addon.js'
import { buildConnectionFormSchema, connectionFromSettings, UNIFI_SYSTEM } from '../config.js'
import { UnifiFeatureDevice } from '../devices/unifi-feature-device.js'
import { UnifiInfraDevice } from '../devices/unifi-infra-device.js'
import { buildUnifiAdoptionProvider } from '../unifi-adoption-provider.js'
import { UnifiClientRegistry } from '../unifi-client-registry.js'
import {
  buildUnifiInstances,
  unifiConnectionsEntryKind,
  unifiRecordKinds,
} from '../unifi-instances.js'
import type {
  UnifiClientSnapshot,
  UnifiControllerClient,
  UnifiInfraSnapshot,
} from '../unifi-client-contract.js'
import { buildUnifiDeviceAdopter } from '../unifi-device-adopter.js'
import { reconcileInfraFeatures } from '../unifi-feature-reconcile.js'
import { setIntegrationDevicesOnline } from '../unifi-integration-offline.js'
import { UnifiControllerNotConnectedError, UnifiDeviceMismatchError } from '../unifi-errors.js'
import { unifiControllers } from '../unifi-node-resolver.js'
import { infraSnapshot, port } from './unifi-fixtures.js'

const INT = 'int-1'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const SWITCH: UnifiInfraSnapshot = infraSnapshot({
  id: 'sw1',
  name: 'marker-switch',
  model: 'USW-Lite-8-PoE',
  kind: 'switch',
  cpuPercent: 5,
  memoryPercent: null,
  cpuTempC: 40,
  clients: 3,
  uptimeSec: 100,
  ports: [port({ idx: 1 })],
  ledOn: true,
})
const CONSOLE: UnifiInfraSnapshot = infraSnapshot({
  id: 'udm',
  name: 'marker-console',
  model: 'UDM-Pro',
  kind: 'console',
})
const PHONE: UnifiClientSnapshot = {
  mac: 'aa:bb:cc:dd:ee:ff',
  hostname: 'marker-phone',
  ip: null,
  connected: true,
  online: true,
}

function fakeClient(infra: readonly UnifiInfraSnapshot[]): UnifiControllerClient {
  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    listInfraDevices: async () => infra,
    listClients: async () => [PHONE],
    getInfraDevice: () => null,
    getClient: () => null,
    setPortPoe: async () => undefined,
    restartDevice: async () => undefined,
    powerCyclePort: async () => undefined,
    setLed: async () => undefined,
    degradedError: () => null,
    onLiveChange: () => () => undefined,
  }
}

afterEach(() => unifiControllers.clear())

interface SwitchProvider {
  setState(input: { deviceId: number; on: boolean }): Promise<void>
}

interface WorkloadOptionsReader {
  getOptions(input: { deviceId: number }): Promise<WorkloadOptions>
}

function isWorkloadProvider(value: unknown): value is WorkloadOptionsReader {
  return typeof value === 'object' && value !== null && 'getOptions' in value
}

interface RestartableWorkload extends WorkloadOptionsReader {
  restart(input: { deviceId: number }): Promise<void>
}

function isRestartableWorkload(value: unknown): value is RestartableWorkload {
  return isWorkloadProvider(value) && 'restart' in value
}

function isSwitchProvider(value: unknown): value is SwitchProvider {
  return typeof value === 'object' && value !== null && 'setState' in value
}

interface PortSwitchProvider extends SwitchProvider {
  getOptions(input: { deviceId: number }): Promise<SwitchOptions>
  powerCycle?: (input: { deviceId: number }) => Promise<void>
}

function isPortSwitchProvider(value: unknown): value is PortSwitchProvider {
  return isSwitchProvider(value) && 'getOptions' in value
}

/** Exposes the protected surface a spec needs; adds nothing. */
class InspectableAddon extends UnifiProviderAddon {
  classes() {
    return this.deviceClasses
  }
}

interface Created {
  readonly stableId: string
  readonly cls: unknown
  readonly config: Record<string, unknown>
  readonly parentDeviceId: number | null | undefined
  readonly meta: InitialDeviceMeta | undefined
}

async function harness(infra: readonly UnifiInfraSnapshot[] = [SWITCH]) {
  const registry = new UnifiClientRegistry(quiet, {
    makeClient: () => fakeClient(infra),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: () => undefined,
  })
  const read = connectionFromSettings({ host: 'ctl.local', apiKey: 'k' }, false)
  if (read === null) throw new Error('settings should parse')
  await registry.upsert(INT, 'Home UDM', read.connection, read.credentialsLocked)

  const created: Created[] = []
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
  const adopter = buildUnifiDeviceAdopter({ devices })
  const remember = (id: number, config: Record<string, unknown>) => adopted.set(id, config)
  const provider = buildUnifiAdoptionProvider({
    hasIntegration: (id) => registry.has(id),
    listIntegrations: () => registry.list(),
    integrationName: () => 'Home UDM',
    listAdopted: async () => [...adopted].map(([id, config]) => ({ id, config })),
    adoptInfra: async (input) => {
      const out = await adopter.adoptInfra(input)
      remember(out.deviceId, {
        system: UNIFI_SYSTEM,
        integrationId: INT,
        infraNativeId: input.infraId,
      })
      return out
    },
    adoptClient: async (input) => {
      const out = await adopter.adoptClient(input)
      remember(out.deviceId, {
        system: UNIFI_SYSTEM,
        integrationId: INT,
        kind: 'presence',
        mac: input.mac,
      })
      return out
    },
    childDeviceIds: async () => [],
    removeDevice: async () => undefined,
    findDeviceConfig: async () => null,
    logger: quiet,
  })
  return { provider, created, registry }
}

describe('UniFi integration: the controller has no Gateway, its devices are siblings', () => {
  it('is an account-mode integration with the adoption cap, not a standalone hub', () => {
    const pkg: {
      camstack: {
        addons: Array<{ mode: string; capabilities: Array<{ name: string }> }>
      }
    } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'))
    const addon = pkg.camstack.addons[0]
    expect(addon?.mode).toBe('account')
    expect(addon?.capabilities.map((c) => c.name)).toContain('device-adoption')
  })

  it('has neither a hub nor a Gateway device class', () => {
    const classes = new InspectableAddon().classes()
    const keys: readonly string[] = Object.keys(classes)
    expect(keys).not.toContain('hub')
    expect(classes[DeviceType.Gateway]).toBeUndefined()
    expect(classes[DeviceType.Container]).toBe(UnifiInfraDevice)
    expect(classes[DeviceType.Workload]).toBe(UnifiInfraDevice)
  })

  it('serves the connection form from the instance, both credentials keychain secrets', async () => {
    const mem = makeInMemoryRecords('provider-unifi')
    await mem.records.declare(unifiRecordKinds)
    const instances = buildUnifiInstances(mem.records, {
      onChanged: async () => undefined,
      makeClient: () => {
        throw new Error('no client in this spec')
      },
      statusOf: () => null,
    })
    const schema = await instances.instanceFormSchema({ id: null })
    expect(unifiConnectionsEntryKind.declaration.secretPaths).toEqual(['apiKey', 'password'])
    expect(schema).toEqual(buildConnectionFormSchema())
    const tree = secretTreeFromSchema(schema)
    expect(tree.get('apiKey')).toEqual({ kind: 'leaf' })
    expect(tree.get('password')).toEqual({ kind: 'leaf' })
    const keys = schema.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? f.key : '')))
    expect(keys).not.toContain('name')
  })

  it('adopting everything creates the console Host, the infra host and the client as top-level siblings', async () => {
    const h = await harness([CONSOLE, SWITCH])
    const out = await h.provider.adopt({
      integrationId: INT,
      childNativeIds: ['infra:udm', 'infra:sw1', `client:${PHONE.mac}`],
    })
    expect(h.created.map((c) => [c.stableId, c.cls, c.parentDeviceId])).toEqual([
      [`unifi:${INT}:infra:udm`, UnifiInfraDevice, null],
      [`unifi:${INT}:infra:sw1`, UnifiInfraDevice, null],
      [`unifi:${INT}:client:${PHONE.mac}`, UnifiFeatureDevice, null],
    ])
    expect(h.created.map((c) => [c.meta?.type, c.meta?.role])).toEqual([
      [DeviceType.Workload, DeviceRole.Host],
      [DeviceType.Workload, DeviceRole.Host],
      [DeviceType.Presence, undefined],
    ])
    expect(h.created.every((c) => c.meta?.integrationId === INT)).toBe(true)
    expect(h.created.every((c) => c.config['integrationId'] === INT)).toBe(true)
    expect(out.adopted).toHaveLength(3)
    // The console Host carries the model its reboot is decided from.
    expect(h.created[0]?.config['model']).toBe('UDM-Pro')
    // The marked switch reaches its Container with features derived from the live snapshot.
    expect(JSON.stringify(h.created[1]?.config['features'])).toContain('"kind":"port"')
    expect(h.created[1]?.config['name']).toBe('marker-switch')
    expect(h.created[2]?.config['name']).toBe('marker-phone')
    // The old Gateway id is not a candidate any more: nothing is created for it.
    await expect(
      h.provider.adopt({ integrationId: INT, childNativeIds: ['gateway'] }),
    ).rejects.toThrow(/failed/)
    expect(h.created).toHaveLength(3)
  })

  it('a retried adopt does not duplicate an infra device', async () => {
    const h = await harness()
    await h.provider.adopt({
      integrationId: INT,
      childNativeIds: ['infra:sw1'],
    })
    await h.provider.adopt({
      integrationId: INT,
      childNativeIds: ['infra:sw1'],
    })
    expect(h.created).toHaveLength(1)
  })

  it('lists the infra and clients, all top-level, with no Gateway', async () => {
    const h = await harness()
    const page = await h.provider.listCandidates({
      integrationId: INT,
      page: 1,
      pageSize: 50,
    })
    expect(page.candidates.map((c) => [c.childNativeId, c.type])).toEqual([
      ['infra:sw1', DeviceType.Workload],
      [`client:${PHONE.mac}`, DeviceType.Presence],
    ])
    // Only the switch nests something: its PoE port, proposed as a port device under it.
    expect(page.candidates.map((c) => c.children?.map((p) => p.childNativeId))).toEqual([
      ['infra:sw1:port-1'],
      undefined,
    ])
  })
})

describe('UniFi integration: the credentials', () => {
  it('a credential the keychain cannot serve reads as locked, never as an empty one to connect with', async () => {
    const read = connectionFromSettings({ host: 'ctl.local', username: 'admin' }, true)
    expect(read?.credentialsLocked).toBe(true)
    if (read === null) throw new Error('settings should parse')

    const makeClient = vi.fn()
    const registry = new UnifiClientRegistry(quiet, {
      makeClient,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
    })
    await registry.upsert(INT, 'Home UDM', read.connection, read.credentialsLocked)
    expect(makeClient).not.toHaveBeenCalled()
    await registry.shutdown()
  })

  it('a readable credential reaches the client, and never a log line', async () => {
    const logged: string[] = []
    const spy: IScopedLogger = {
      debug: (m, c) => void logged.push(m + JSON.stringify(c ?? {})),
      info: (m, c) => void logged.push(m + JSON.stringify(c ?? {})),
      warn: (m, c) => void logged.push(m + JSON.stringify(c ?? {})),
      error: (m, c) => void logged.push(m + JSON.stringify(c ?? {})),
      child: () => spy,
      withTags: () => spy,
    }
    const seen: string[] = []
    const registry = new UnifiClientRegistry(spy, {
      makeClient: (input) => {
        seen.push(input.apiKey)
        return fakeClient([])
      },
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
    })
    const read = connectionFromSettings({ host: 'ctl.local', apiKey: 'sekrit-key-123' }, false)
    if (read === null) throw new Error('settings should parse')
    await registry.upsert(INT, 'Home UDM', read.connection, read.credentialsLocked)
    expect(seen).toEqual(['sekrit-key-123'])
    expect(unifiControllers.getManager(INT)?.status).toBe('connected')
    expect(logged.join('\n')).not.toContain('sekrit-key-123')
    await registry.shutdown()
  })
})

describe('UniFi integration: devices follow the integration', () => {
  it('goes offline and online with the integration, whatever the device kind', () => {
    const mk = (integrationId: string) => {
      const state = { online: true }
      return {
        get online() {
          return state.online
        },
        config: {
          get: (key: string): unknown => ({ system: UNIFI_SYSTEM, integrationId })[key],
        },
        markOnline: (v: boolean) => {
          state.online = v
        },
      }
    }
    const mine = [mk(INT), mk(INT), mk(INT)]
    const other = mk('int-2')
    expect(setIntegrationDevicesOnline([...mine, other], INT, false)).toBe(3)
    expect(other.online).toBe(true)
  })

  it('re-persists a top-level infra Container features from the snapshot, only when they changed', async () => {
    await harness()
    const apply = vi.fn(async () => undefined)
    const devices = {
      loadConfig: async () => ({
        system: UNIFI_SYSTEM,
        integrationId: INT,
        infraNativeId: 'sw1',
        features: [],
      }),
      applyDerivedSpec: apply,
    }
    const reg = { getAllForAddon: () => [{ id: 5, parentDeviceId: null }] }
    const input = {
      reg,
      devices,
      addonId: 'provider-unifi',
      integrationId: INT,
      logger: quiet,
    }
    expect(await reconcileInfraFeatures(input)).toBe(1)
    expect(JSON.stringify(apply.mock.calls[0])).toContain('"kind":"port"')
    // A different integration is untouched.
    apply.mockClear()
    expect(await reconcileInfraFeatures({ ...input, integrationId: 'int-2' })).toBe(0)
    expect(apply).not.toHaveBeenCalled()
  })

  it('a port table that did not answer never prunes the adopted PoE port children', async () => {
    // The device detail read failed: the snapshot carries no ports (planning#587).
    await harness([{ ...SWITCH, ports: [] }])
    const apply = vi.fn(async () => undefined)
    const persisted = [
      { kind: 'button', buttonAction: 'restart' },
      { kind: 'port', portIdx: 1, switchable: false },
      { kind: 'sensor', metric: 'cpu_utilization' },
      { kind: 'sensor', metric: 'cpu_temperature' },
      { kind: 'sensor', metric: 'clients' },
      { kind: 'sensor', metric: 'state' },
      { kind: 'sensor', metric: 'uptime' },
    ]
    const devices = {
      loadConfig: async () => ({
        system: UNIFI_SYSTEM,
        integrationId: INT,
        infraNativeId: 'sw1',
        features: persisted,
      }),
      applyDerivedSpec: apply,
    }
    const reg = { getAllForAddon: () => [{ id: 5, parentDeviceId: null }] }
    const input = {
      reg,
      devices,
      addonId: 'provider-unifi',
      integrationId: INT,
      logger: quiet,
    }
    expect(await reconcileInfraFeatures(input)).toBe(0)
    expect(apply).not.toHaveBeenCalled()
  })

  it('still retires the LED switch the client can never serve', async () => {
    await harness()
    const apply = vi.fn(async (_id: number, _spec: { config: { features: unknown } }) => undefined)
    const devices = {
      loadConfig: async () => ({
        system: UNIFI_SYSTEM,
        integrationId: INT,
        infraNativeId: 'sw1',
        features: [{ kind: 'switch', switchFeature: 'led' }],
      }),
      applyDerivedSpec: apply,
    }
    const reg = { getAllForAddon: () => [{ id: 5, parentDeviceId: null }] }
    const input = {
      reg,
      devices,
      addonId: 'provider-unifi',
      integrationId: INT,
      logger: quiet,
    }
    expect(await reconcileInfraFeatures(input)).toBe(1)
    expect(JSON.stringify(apply.mock.calls[0]?.[1])).not.toContain('led')
  })
})

describe('UniFi devices on a stub device context', () => {
  function rig(
    config: Record<string, unknown>,
    type: DeviceType,
    api: Record<string, unknown> = {},
  ): {
    readonly ctx: DeviceContext
    readonly providers: Map<string, unknown>
  } {
    const providers = new Map<string, unknown>()
    let runtime: IDeviceRuntimeState | null = null
    // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
    const ctx = {
      id: 7,
      stableId: 'unifi:int-1:x',
      parentDeviceId: null,
      deviceMeta: {
        type,
        name: 'Home UDM',
        location: null,
        disabled: false,
        addonId: 'provider-unifi',
        metadata: {},
      },
      persistedConfig: config,
      initialRuntimeState: {},
      eventBus: {
        emit: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        getRecent: vi.fn(() => []),
      },
      persistConfig: vi.fn(async () => {}),
      bindRuntimeState: (rs: IDeviceRuntimeState) => {
        runtime = rs
      },
      registerNativeCap: vi.fn(
        (cap: { name: string; runtimeState?: unknown }, provider: unknown) => {
          providers.set(cap.name, provider)
          if (cap.runtimeState && runtime) {
            runtime.installCapSchema(
              cap.name,
              cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
            )
          }
        },
      ),
      api,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as DeviceContext
    return { ctx, providers }
  }

  async function consoleHost(): Promise<{
    readonly host: UnifiInfraDevice
    readonly providers: Map<string, unknown>
  }> {
    const { ctx, providers } = rig(
      {
        integrationId: INT,
        infraNativeId: 'udm',
        model: 'UDM-Pro',
        system: UNIFI_SYSTEM,
      },
      DeviceType.Workload,
    )
    const host = new UnifiInfraDevice(ctx)
    await host.onActivate()
    return { host, providers }
  }

  it('a console Host restarts through workload.restart, which calls restartDevice', async () => {
    await harness([CONSOLE, SWITCH])
    const client = unifiControllers.getManager(INT)?.client
    if (client === null || client === undefined) throw new Error('client should run')
    const restartDevice = vi.spyOn(client, 'restartDevice')
    const { providers } = await consoleHost()
    expect([...providers.keys()]).toEqual(expect.arrayContaining(['workload', 'device-admin-link']))
    // One restart path on the Host: the workload card's, no separate reboot capability.
    expect(providers.has('reboot')).toBe(false)
    const workload = providers.get('workload')
    if (!isRestartableWorkload(workload)) throw new Error('workload.restart missing')
    expect((await workload.getOptions({ deviceId: 7 })).supportsRestart).toBe(true)
    await workload.restart({ deviceId: 7 })
    expect(restartDevice.mock.calls).toEqual([['udm']])
  })

  it('a console restart is refused, typed, when the controller is not connected', async () => {
    await harness([CONSOLE, SWITCH])
    const { providers } = await consoleHost()
    unifiControllers.set(INT, null)
    const workload = providers.get('workload')
    if (!isRestartableWorkload(workload)) throw new Error('workload.restart missing')
    await expect(workload.restart({ deviceId: 7 })).rejects.toBeInstanceOf(
      UnifiControllerNotConnectedError,
    )
  })

  it('a console restart for another deviceId is refused, typed, and restarts nothing', async () => {
    await harness([CONSOLE, SWITCH])
    const client = unifiControllers.getManager(INT)?.client
    if (client === null || client === undefined) throw new Error('client should run')
    const restartDevice = vi.spyOn(client, 'restartDevice')
    const { providers } = await consoleHost()
    const workload = providers.get('workload')
    if (!isRestartableWorkload(workload)) throw new Error('workload.restart missing')
    await expect(workload.restart({ deviceId: 8 })).rejects.toBeInstanceOf(UnifiDeviceMismatchError)
    expect(restartDevice).not.toHaveBeenCalled()
  })

  it('a switch Host stays as it was: no restart of its own', async () => {
    await harness()
    const { ctx, providers } = rig(
      {
        integrationId: INT,
        infraNativeId: 'sw1',
        model: 'USW-Lite-8-PoE',
        system: UNIFI_SYSTEM,
      },
      DeviceType.Workload,
    )
    await new UnifiInfraDevice(ctx).onActivate()
    expect(providers.has('reboot')).toBe(false)
    const workload = providers.get('workload')
    if (!isWorkloadProvider(workload)) throw new Error('workload cap missing')
    expect((await workload.getOptions({ deviceId: 7 })).supportsRestart).toBe(false)
    expect(isRestartableWorkload(workload)).toBe(false)
  })

  it('the infra Container spawns its features as children linked to it, each following the integration', () => {
    const { ctx } = rig(
      {
        integrationId: INT,
        infraNativeId: 'sw1',
        system: UNIFI_SYSTEM,
        features: [{ kind: 'switch', switchFeature: 'led' }],
      },
      DeviceType.Container,
    )
    const infra = new UnifiInfraDevice(ctx)
    const specs = infra.getAccessoryChildren()
    expect(specs).toHaveLength(1)
    expect(specs[0]?.meta.linkDeviceId).toBe(infra.id)
    expect(specs[0]?.meta.integrationId).toBe(INT)
    expect(specs[0]?.config['integrationId']).toBe(INT)
  })

  function hostRig(type: DeviceType) {
    return rig(
      {
        integrationId: INT,
        infraNativeId: 'sw1',
        system: UNIFI_SYSTEM,
        features: [],
      },
      type,
    )
  }

  it('a workload host serves the workload cap from the live snapshot, with no power switch', async () => {
    await harness()
    const { ctx, providers } = hostRig(DeviceType.Workload)
    const host = new UnifiInfraDevice(ctx)
    await host.onActivate()
    const workload = providers.get('workload')
    if (!isWorkloadProvider(workload)) throw new Error('workload cap missing')
    expect(providers.has('switch')).toBe(false)
    const options = await workload.getOptions({ deviceId: 7 })
    expect(options.supportsStart || options.supportsStop || options.supportsRestart).toBe(false)
    const slice = host.runtimeState.getCapState<WorkloadStatus>('workload')
    expect(slice?.state).toBe('running')
    expect(slice?.resources.cpuPercent).toBe(5)
    expect(slice?.resources.temperature).toBe(40)
  })

  it('an infra device adopted as a Container before the flip serves no workload cap', async () => {
    await harness()
    const { ctx, providers } = hostRig(DeviceType.Container)
    await new UnifiInfraDevice(ctx).onActivate()
    expect(providers.has('workload')).toBe(false)
  })

  function portRig(switchable: boolean) {
    return rig(
      {
        kind: 'port',
        integrationId: INT,
        infraNativeId: 'sw1',
        portIdx: 1,
        switchable,
        system: UNIFI_SYSTEM,
      },
      DeviceType.Switch,
    )
  }

  function attachedRig() {
    const mutate = vi.fn(async (_input: SetIdentifiersInput) => undefined)
    const { ctx } = rig(
      { kind: 'port', integrationId: INT, infraNativeId: 'sw1', portIdx: 1, system: UNIFI_SYSTEM },
      DeviceType.Switch,
      { deviceManager: { setAttachedIdentifiers: { mutate } } },
    )
    return { ctx, mutate }
  }

  it('a PoE port declares its wired client as ATTACHED once, and not again on an unchanged tick (D1063)', async () => {
    await harness([{ ...SWITCH, ports: [port({ idx: 1, clientMac: PHONE.mac })] }])
    const { ctx, mutate } = attachedRig()
    await new UnifiFeatureDevice(ctx).onActivate()
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      deviceId: 7,
      identifiers: { mac: [{ value: PHONE.mac }] },
      unread: ['ip'],
    })
    unifiControllers.emitSnapshot(INT)
    await new Promise((resolve) => setImmediate(resolve))
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('a client that leaves the port keeps the retained MAC, declared UNREAD — never as a fresh read (D1063, D49)', async () => {
    const infra: UnifiInfraSnapshot[] = [
      { ...SWITCH, ports: [port({ idx: 1, clientMac: PHONE.mac })] },
    ]
    await harness(infra)
    const { ctx, mutate } = attachedRig()
    await new UnifiFeatureDevice(ctx).onActivate()
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    infra[0] = { ...SWITCH, ports: [port({ idx: 1, clientMac: null })] }
    await unifiControllers.getManager(INT)?.poll()
    unifiControllers.emitSnapshot(INT)
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    const retained = mutate.mock.calls[1]?.[0]
    expect(retained?.identifiers?.mac?.map((m) => m.value)).toEqual([PHONE.mac])
    expect([...(retained?.unread ?? [])].sort()).toEqual(['ip', 'mac'])
  })

  it('a PoE port that never saw a client declares nothing attached', async () => {
    await harness()
    const { ctx, mutate } = attachedRig()
    await new UnifiFeatureDevice(ctx).onActivate()
    await new Promise((resolve) => setImmediate(resolve))
    expect(mutate).not.toHaveBeenCalled()
  })

  it('a PoE port without a local account is a switch that only power-cycles: no on/off', async () => {
    await harness()
    const client = unifiControllers.getManager(INT)?.client
    if (client === null || client === undefined) throw new Error('client should run')
    const setPortPoe = vi.spyOn(client, 'setPortPoe')
    const powerCyclePort = vi.spyOn(client, 'powerCyclePort')
    const { ctx, providers } = portRig(false)
    await new UnifiFeatureDevice(ctx).onActivate()
    const caps = [...providers.keys()]
    expect(caps).toEqual(expect.arrayContaining(['switch', 'power-meter', 'network-link']))
    expect(caps).not.toContain('reboot')
    expect(caps).not.toContain('button')
    const port = providers.get('switch')
    if (!isPortSwitchProvider(port)) throw new Error('switch cap missing')
    expect(await port.getOptions({ deviceId: 7 })).toEqual({
      supportsSetState: false,
      supportsPowerCycle: true,
    })
    await port.powerCycle?.({ deviceId: 7 })
    expect(powerCyclePort.mock.calls).toEqual([['sw1', 1]])
    await expect(port.setState({ deviceId: 7, on: false })).rejects.toThrow(/local account/)
    expect(setPortPoe).not.toHaveBeenCalled()
  })

  it('a switchable PoE port switches PoE through the client, and offers no power-cycle', async () => {
    await harness([{ ...SWITCH, poeSwitchable: true }])
    const client = unifiControllers.getManager(INT)?.client
    if (client === null || client === undefined) throw new Error('client should run')
    const setPortPoe = vi.spyOn(client, 'setPortPoe')
    const { ctx, providers } = portRig(true)
    await new UnifiFeatureDevice(ctx).onActivate()
    const toggle = providers.get('switch')
    if (!isSwitchProvider(toggle)) throw new Error('switch cap missing')
    expect(providers.has('reboot')).toBe(false)
    // It keeps off / wait / on for a forced restart: no native cycle is declared.
    if (!isPortSwitchProvider(toggle)) throw new Error('switch options missing')
    expect(await toggle.getOptions({ deviceId: 7 })).toEqual({
      supportsSetState: true,
      supportsPowerCycle: false,
    })
    expect(toggle.powerCycle).toBeUndefined()
    await toggle.setState({ deviceId: 7, on: false })
    await toggle.setState({ deviceId: 7, on: true })
    expect(setPortPoe.mock.calls).toEqual([
      ['sw1', 1, false],
      ['sw1', 1, true],
    ])
  })
})
