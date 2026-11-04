/**
 * A new Unraid integration produces the server's Gateway and its instance Container as
 * SIBLINGS, with the connection (and the API key, a keychain secret) on the integration.
 * The device context is the one boundary a spec fakes; everything else is the real code.
 */
import {
  type DeviceContext,
  DeviceType,
  type DeviceConstructor,
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
import { UnraidProviderAddon } from '../addon.js'
import { buildConnectionFormSchema, connectionFromSettings, UNRAID_SYSTEM } from '../config.js'
import { UnraidGatewayDevice } from '../devices/unraid-gateway-device.js'
import { UnraidInstanceDevice } from '../devices/unraid-instance-device.js'
import { buildUnraidAdoptionProvider } from '../unraid-adoption-provider.js'
import { UnraidClientRegistry } from '../unraid-client-registry.js'
import {
  buildUnraidInstances,
  unraidConnectionsEntryKind,
  unraidRecordKinds,
} from '../unraid-instances.js'
import type { UnraidClientLike, UnraidSnapshot } from '../unraid-client-contract.js'
import { buildUnraidDeviceAdopter } from '../unraid-device-adopter.js'
import { UNRAID_GATEWAY_ID, UNRAID_INSTANCE_ID } from '../unraid-discovery.js'
import { reconcileInstanceEntities } from '../unraid-entity-reconcile.js'
import { setIntegrationDevicesOnline } from '../unraid-integration-offline.js'
import { unraidInstances } from '../unraid-node-resolver.js'

const INT = 'int-1'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

/** A snapshot with one docker container carrying a marked name. */
const SNAPSHOT: UnraidSnapshot = {
  array: {
    state: 'STARTED',
    capacityKb: { total: 1000, used: 400, free: 600 },
    parityCheck: null,
    disks: [],
  },
  cpu: { percent: 12, tempC: null, powerW: null },
  disks: [],
  dockers: [{ id: 'c1', name: 'marker-plex', running: true, cpuPercent: 1, memPercent: 2 }],
  notifications: { activeCount: 0, latest: null },
}

afterEach(() => unraidInstances.clear())

/** Exposes the protected surface a spec needs; adds nothing. */
class InspectableAddon extends UnraidProviderAddon {
  classes() {
    return this.deviceClasses
  }
  stableId(type: DeviceType, config: Record<string, unknown>) {
    return this.generateStableId(type, config)
  }
}

interface Created {
  readonly stableId: string
  readonly cls: unknown
  readonly config: Record<string, unknown>
  readonly parentDeviceId: number | null | undefined
  readonly meta: InitialDeviceMeta | undefined
}

function adoptionHarness() {
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
      // The kernel returns the built device; the adopter reads only its id.
      return Object.assign(Object.create(cls.prototype), { id: next++ })
    },
    getChildren: async () => [],
  }
  const adopted = new Map<number, Record<string, unknown>>()
  const adopter = buildUnraidDeviceAdopter({
    devices,
    getSnapshot: () => SNAPSHOT,
  })
  const provider = buildUnraidAdoptionProvider({
    getSnapshot: () => SNAPSHOT,
    hasIntegration: (id) => id === INT,
    listIntegrations: () => [INT],
    integrationName: () => 'Tower',
    listAdopted: async () => [...adopted].map(([id, config]) => ({ id, config })),
    adoptGateway: async (input) => {
      const out = await adopter.adoptGateway(input)
      adopted.set(out.deviceId, {
        system: UNRAID_SYSTEM,
        integrationId: INT,
        nativeId: UNRAID_GATEWAY_ID,
      })
      return out
    },
    adoptInstance: async (input) => {
      const out = await adopter.adoptInstance(input)
      adopted.set(out.deviceId, {
        system: UNRAID_SYSTEM,
        integrationId: INT,
        nativeId: UNRAID_INSTANCE_ID,
      })
      return out
    },
    childDeviceIds: async () => [],
    removeDevice: async () => undefined,
    findDeviceConfig: async () => null,
    logger: quiet,
  })
  return { provider, created }
}

describe('Unraid integration: the server is a Gateway, a sibling of its instance', () => {
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
    expect(classes[DeviceType.Gateway]).toBe(UnraidGatewayDevice)
    expect(classes[DeviceType.Container]).toBe(UnraidInstanceDevice)
  })

  it('serves the connection form from the instance, with the apiKey a keychain secret', async () => {
    const mem = makeInMemoryRecords('provider-unraid')
    await mem.records.declare(unraidRecordKinds)
    const instances = buildUnraidInstances(mem.records, { onChanged: async () => undefined })
    const schema = await instances.instanceFormSchema({ id: null })
    expect(schema).toEqual(buildConnectionFormSchema())
    expect(secretTreeFromSchema(schema).get('apiKey')).toEqual({ kind: 'leaf' })
    expect(unraidConnectionsEntryKind.declaration.secretPaths).toEqual(['apiKey'])
    // The server name is the integration's, not a form field.
    const keys = schema.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? f.key : '')))
    expect(keys).not.toContain('name')
  })

  it('adopting the candidates creates the Gateway and the instance as top-level siblings', async () => {
    const h = adoptionHarness()
    const out = await h.provider.adopt({
      integrationId: INT,
      childNativeIds: [UNRAID_GATEWAY_ID, UNRAID_INSTANCE_ID],
    })
    expect(h.created.map((c) => [c.stableId, c.cls, c.parentDeviceId])).toEqual([
      [`unraid:${INT}:gateway`, UnraidGatewayDevice, null],
      [`unraid:${INT}:instance`, UnraidInstanceDevice, null],
    ])
    expect(h.created.map((c) => c.meta?.type)).toEqual([DeviceType.Gateway, DeviceType.Container])
    expect(h.created.every((c) => c.meta?.integrationId === INT)).toBe(true)
    expect(out.adopted.map((a) => a.childNativeId)).toEqual([UNRAID_GATEWAY_ID, UNRAID_INSTANCE_ID])
    // The marked docker container reaches the instance's entity list.
    const entities = h.created[1]?.config['entities']
    expect(JSON.stringify(entities)).toContain('c1')
    expect(h.created[1]?.config['integrationId']).toBe(INT)
    expect(h.created[1]?.config['instanceId']).toBe(INT)
  })

  it('a retried adopt neither duplicates the Gateway nor the instance', async () => {
    const h = adoptionHarness()
    await h.provider.adopt({ integrationId: INT, childNativeIds: [UNRAID_GATEWAY_ID] })
    await h.provider.adopt({ integrationId: INT, childNativeIds: [UNRAID_GATEWAY_ID] })
    expect(h.created).toHaveLength(1)
  })

  it('lists the Gateway and the Container as siblings: neither nests the other', async () => {
    const h = adoptionHarness()
    const page = await h.provider.listCandidates({ integrationId: INT, page: 1, pageSize: 50 })
    expect(page.candidates.map((c) => [c.childNativeId, c.type])).toEqual([
      [UNRAID_GATEWAY_ID, DeviceType.Gateway],
      [UNRAID_INSTANCE_ID, DeviceType.Container],
    ])
    expect(page.candidates.every((c) => c.children === undefined)).toBe(true)
  })
})

describe('Unraid integration: the API key', () => {
  it('a key the keychain cannot serve reads as locked, never as an empty key to connect with', async () => {
    const read = connectionFromSettings({ host: 'tower.local' }, true)
    expect(read?.apiKeyLocked).toBe(true)

    const makeClient = vi.fn()
    const registry = new UnraidClientRegistry(quiet, {
      makeClient,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
    })
    expect(read).not.toBeNull()
    if (read === null) return
    await registry.upsert(INT, 'Tower', read.connection, read.apiKeyLocked)
    expect(makeClient).not.toHaveBeenCalled()
    await registry.shutdown()
  })

  it('a readable key reaches the client, and never a log line', async () => {
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
    const client: UnraidClientLike = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      array: {
        get: async () => SNAPSHOT.array,
        setState: async () => undefined,
        parity: { start: async () => undefined, cancel: async () => undefined },
      },
      docker: {
        list: async () => SNAPSHOT.dockers,
        start: async () => undefined,
        stop: async () => undefined,
      },
      system: { cpu: async () => SNAPSHOT.cpu },
      notifications: { active: async () => SNAPSHOT.notifications },
    }
    const registry = new UnraidClientRegistry(spy, {
      makeClient: (input) => {
        seen.push(input.apiKey)
        return client
      },
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
    })
    const read = connectionFromSettings({ host: 'tower.local', apiKey: 'sekrit-key-123' }, false)
    if (read === null) throw new Error('settings should parse')
    await registry.upsert(INT, 'Tower', read.connection, read.apiKeyLocked)
    expect(seen).toEqual(['sekrit-key-123'])
    expect(unraidInstances.getSnapshot(INT)).not.toBeNull()
    expect(logged.join('\n')).not.toContain('sekrit-key-123')
    await registry.shutdown()
  })
})

describe('Unraid integration: devices follow the integration', () => {
  it('goes offline and online with the integration, Gateway and entities alike', () => {
    const mk = (nativeId: string, integrationId: string) => {
      const state = { online: true }
      return {
        get online() {
          return state.online
        },
        config: {
          get: (key: string): unknown => ({ system: UNRAID_SYSTEM, integrationId, nativeId })[key],
        },
        markOnline: (v: boolean) => {
          state.online = v
        },
      }
    }
    const mine = [mk(UNRAID_GATEWAY_ID, INT), mk(UNRAID_INSTANCE_ID, INT)]
    const other = mk(UNRAID_GATEWAY_ID, 'int-2')
    expect(setIntegrationDevicesOnline([...mine, other], INT, false)).toBe(2)
    expect(mine.map((d) => d.online)).toEqual([false, false])
    expect(other.online).toBe(true)
  })

  it('re-persists the instance entities from the snapshot, and never prunes without one', async () => {
    const apply = vi.fn(async () => undefined)
    const devices = {
      loadConfig: async () => ({
        system: UNRAID_SYSTEM,
        integrationId: INT,
        nativeId: UNRAID_INSTANCE_ID,
        entities: [],
      }),
      applyDerivedSpec: apply,
    }
    const reg = { getAllForAddon: () => [{ id: 5, parentDeviceId: null }] }
    const base = { reg, devices, addonId: 'provider-unraid', integrationId: INT, logger: quiet }
    expect(await reconcileInstanceEntities({ ...base, snapshot: null })).toBe(0)
    expect(apply).not.toHaveBeenCalled()
    expect(await reconcileInstanceEntities({ ...base, snapshot: SNAPSHOT })).toBe(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(apply.mock.calls[0])).toContain('c1')
  })
})

describe('Unraid devices: the Gateway and the instance on a stub device context', () => {
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
      stableId: 'unraid:int-1:x',
      parentDeviceId: null,
      deviceMeta: {
        type,
        name: 'Tower',
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

  it('the Gateway is a Gateway carrying the WebGUI link', async () => {
    const { ctx, providers } = rig(
      { nativeId: UNRAID_GATEWAY_ID, integrationId: INT, system: UNRAID_SYSTEM },
      DeviceType.Gateway,
    )
    const device = new UnraidGatewayDevice(ctx)
    expect(device.type).toBe(DeviceType.Gateway)
    expect([...providers.keys()]).toContain('device-admin-link')
  })

  it('the instance spawns its entities as children linked to it, each following the integration', () => {
    const { ctx } = rig(
      {
        nativeId: UNRAID_INSTANCE_ID,
        instanceId: INT,
        integrationId: INT,
        system: UNRAID_SYSTEM,
        entities: [
          {
            key: 'container_marker-plex',
            name: 'marker-plex',
            kind: 'switch',
            capName: 'switch',
            deviceType: DeviceType.Switch,
            containerId: 'c1',
          },
        ],
      },
      DeviceType.Container,
    )
    const instance = new UnraidInstanceDevice(ctx)
    const specs = instance.getAccessoryChildren()
    expect(specs).toHaveLength(1)
    expect(specs[0]?.meta.linkDeviceId).toBe(instance.id)
    expect(specs[0]?.meta.integrationId).toBe(INT)
    expect(specs[0]?.config['integrationId']).toBe(INT)
    expect(specs[0]?.config['instanceId']).toBe(INT)
  })
})
