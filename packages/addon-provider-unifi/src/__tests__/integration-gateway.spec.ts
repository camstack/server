/**
 * A new UniFi integration produces the controller's Gateway, its infra Containers and its
 * client Presence devices as top-level SIBLINGS, with the connection (and its credentials,
 * keychain secrets) on the integration. The device context is the one boundary a spec
 * fakes; the registry, resolver, adopter and adoption provider are the real code.
 */
import {
  type DeviceConstructor,
  type DeviceContext,
  DeviceType,
  type IDevice,
  type IDeviceRuntimeState,
  type IScopedLogger,
  type InitialDeviceMeta,
  makeInMemoryRecords,
  secretTreeFromSchema,
} from '@camstack/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnifiProviderAddon } from '../addon.js'
import { buildConnectionFormSchema, connectionFromSettings, UNIFI_SYSTEM } from '../config.js'
import { UnifiFeatureDevice } from '../devices/unifi-feature-device.js'
import { UnifiGatewayDevice } from '../devices/unifi-gateway-device.js'
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
import { UNIFI_GATEWAY_ID } from '../unifi-discovery.js'
import { reconcileInfraFeatures } from '../unifi-feature-reconcile.js'
import { setIntegrationDevicesOnline } from '../unifi-integration-offline.js'
import { unifiControllers } from '../unifi-node-resolver.js'

const INT = 'int-1'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const SWITCH: UnifiInfraSnapshot = {
  id: 'sw1',
  name: 'marker-switch',
  model: 'USW-Lite-8-PoE',
  cpuPercent: 5,
  cpuTempC: 40,
  clients: 3,
  state: 'online',
  uptimeSec: 100,
  ports: [{ idx: 1, poeOn: true, poeCapable: true }],
  ledOn: true,
  online: true,
}
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
  }
}

afterEach(() => unifiControllers.clear())

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

async function harness() {
  const registry = new UnifiClientRegistry(quiet, {
    makeClient: () => fakeClient([SWITCH]),
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
    adoptGateway: async (input) => {
      const out = await adopter.adoptGateway(input)
      remember(out.deviceId, {
        system: UNIFI_SYSTEM,
        integrationId: INT,
        nativeId: UNIFI_GATEWAY_ID,
      })
      return out
    },
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

describe('UniFi integration: the controller is a Gateway, a sibling of its devices', () => {
  it('is an account-mode integration with the adoption cap, not a standalone hub', () => {
    const pkg: {
      camstack: { addons: Array<{ mode: string; capabilities: Array<{ name: string }> }> }
    } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'))
    const addon = pkg.camstack.addons[0]
    expect(addon?.mode).toBe('account')
    expect(addon?.capabilities.map((c) => c.name)).toContain('device-adoption')
  })

  it('has no Hub device class: the Gateway takes its place', () => {
    const classes = new InspectableAddon().classes()
    expect(classes[DeviceType.Hub]).toBeUndefined()
    expect(classes[DeviceType.Gateway]).toBe(UnifiGatewayDevice)
    expect(classes[DeviceType.Container]).toBe(UnifiInfraDevice)
  })

  it('serves the connection form from the instance, both credentials keychain secrets', async () => {
    const mem = makeInMemoryRecords('provider-unifi')
    await mem.records.declare(unifiRecordKinds)
    const instances = buildUnifiInstances(mem.records, { onChanged: async () => undefined })
    const schema = await instances.instanceFormSchema({ id: null })
    expect(unifiConnectionsEntryKind.declaration.secretPaths).toEqual(['apiKey', 'password'])
    expect(schema).toEqual(buildConnectionFormSchema())
    const tree = secretTreeFromSchema(schema)
    expect(tree.get('apiKey')).toEqual({ kind: 'leaf' })
    expect(tree.get('password')).toEqual({ kind: 'leaf' })
    const keys = schema.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? f.key : '')))
    expect(keys).not.toContain('name')
  })

  it('adopting everything creates the Gateway, the infra Container and the client as top-level siblings', async () => {
    const h = await harness()
    const out = await h.provider.adopt({
      integrationId: INT,
      childNativeIds: [UNIFI_GATEWAY_ID, 'infra:sw1', `client:${PHONE.mac}`],
    })
    expect(h.created.map((c) => [c.stableId, c.cls, c.parentDeviceId])).toEqual([
      [`unifi:${INT}:gateway`, UnifiGatewayDevice, null],
      [`unifi:${INT}:infra:sw1`, UnifiInfraDevice, null],
      [`unifi:${INT}:client:${PHONE.mac}`, UnifiFeatureDevice, null],
    ])
    expect(h.created.map((c) => c.meta?.type)).toEqual([
      DeviceType.Gateway,
      DeviceType.Container,
      DeviceType.Presence,
    ])
    expect(h.created.every((c) => c.meta?.integrationId === INT)).toBe(true)
    expect(h.created.every((c) => c.config['integrationId'] === INT)).toBe(true)
    expect(out.adopted).toHaveLength(3)
    // The marked switch reaches its Container with features derived from the live snapshot.
    expect(JSON.stringify(h.created[1]?.config['features'])).toContain('poe')
    expect(h.created[1]?.config['name']).toBe('marker-switch')
    expect(h.created[2]?.config['name']).toBe('marker-phone')
  })

  it('a retried adopt neither duplicates the Gateway nor an infra device', async () => {
    const h = await harness()
    await h.provider.adopt({ integrationId: INT, childNativeIds: [UNIFI_GATEWAY_ID, 'infra:sw1'] })
    await h.provider.adopt({ integrationId: INT, childNativeIds: [UNIFI_GATEWAY_ID, 'infra:sw1'] })
    expect(h.created).toHaveLength(2)
  })

  it('lists the Gateway first, then the infra and clients, all flat', async () => {
    const h = await harness()
    const page = await h.provider.listCandidates({ integrationId: INT, page: 1, pageSize: 50 })
    expect(page.candidates.map((c) => [c.childNativeId, c.type])).toEqual([
      [UNIFI_GATEWAY_ID, DeviceType.Gateway],
      ['infra:sw1', DeviceType.Container],
      [`client:${PHONE.mac}`, DeviceType.Presence],
    ])
    expect(page.candidates.every((c) => c.children === undefined)).toBe(true)
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
    const input = { reg, devices, addonId: 'provider-unifi', integrationId: INT, logger: quiet }
    expect(await reconcileInfraFeatures(input)).toBe(1)
    expect(JSON.stringify(apply.mock.calls[0])).toContain('poe')
    // A different integration is untouched.
    apply.mockClear()
    expect(await reconcileInfraFeatures({ ...input, integrationId: 'int-2' })).toBe(0)
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('UniFi devices on a stub device context', () => {
  function rig(
    config: Record<string, unknown>,
    type: DeviceType,
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
      eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
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
      api: {},
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as DeviceContext
    return { ctx, providers }
  }

  it('the Gateway is a Gateway carrying the controller UI link', () => {
    const { ctx, providers } = rig(
      { nativeId: UNIFI_GATEWAY_ID, integrationId: INT, system: UNIFI_SYSTEM },
      DeviceType.Gateway,
    )
    const device = new UnifiGatewayDevice(ctx)
    expect(device.type).toBe(DeviceType.Gateway)
    expect([...providers.keys()]).toContain('device-admin-link')
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
})
