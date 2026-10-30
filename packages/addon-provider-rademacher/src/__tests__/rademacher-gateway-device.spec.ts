/**
 * The hub box, built on a stub device context (the one boundary a spec has to
 * fake): what it registers, how it follows the integration's session, and what
 * it refuses to claim.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RademacherCoverDevice } from '../devices/rademacher-cover-device.js'
import { RademacherGatewayDevice } from '../devices/rademacher-gateway-device.js'
import { RademacherIntegrationManager } from '../rademacher-integration-manager.js'
import { rademacherSessions } from '../rademacher-session-resolver.js'
import { FakeHubClient, FakeHubGateway, IDENTITY, makeCover } from './fake-hub.js'
import { RecordingLogger } from './recording-logger.js'

const INT = 'int-1'

interface Rig {
  readonly ctx: DeviceContext
  readonly providers: Map<string, unknown>
  readonly logger: RecordingLogger
  readonly setMetadata: ReturnType<typeof vi.fn>
}

function rig(config: Record<string, unknown>, type: DeviceType): Rig {
  const providers = new Map<string, unknown>()
  const logger = new RecordingLogger()
  const setMetadata = vi.fn(async () => {})
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what these devices read.
  const ctx = {
    id: 7,
    stableId: `rademacher:${INT}:gateway`,
    parentDeviceId: null,
    deviceMeta: {
      type,
      name: 'Casa',
      location: null,
      disabled: false,
      addonId: 'provider-rademacher',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: { getChildren: vi.fn(async () => []) },
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
    api: { deviceManager: { setMetadata: { mutate: setMetadata } } },
    logger,
  } as unknown as DeviceContext
  return { ctx, providers, logger, setMetadata }
}

const gatewayConfig = { integrationId: INT, system: 'rademacher', nativeId: `${INT}:gateway` }

async function callCap(
  providers: Map<string, unknown>,
  cap: string,
  method: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const fn: unknown = Reflect.get(providers.get(cap) ?? {}, method)
  if (typeof fn !== 'function') throw new Error(`no ${cap}.${method} registered`)
  return fn(input)
}

const hubGateway = new FakeHubGateway()

async function publish(
  connection: { basePath?: string; pollIntervalMs?: number } = {},
): Promise<RademacherIntegrationManager> {
  const client = new FakeHubClient([makeCover(hubGateway, '7', 'Salotto')])
  const manager = new RademacherIntegrationManager({
    id: INT,
    name: 'Casa',
    connection: {
      host: IDENTITY.host,
      password: 'secret-pw',
      basePath: connection.basePath ?? '',
      pollIntervalMs: connection.pollIntervalMs ?? 30_000,
    },
    logger: new RecordingLogger(),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: (id) => rademacherSessions.emitSnapshot(id),
    makeClient: () => client,
  })
  rademacherSessions.set(INT, manager)
  await manager.start()
  return manager
}

const managers: RademacherIntegrationManager[] = []

afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop()
  rademacherSessions.clear()
  hubGateway.failing = false
})

describe('RademacherGatewayDevice', () => {
  it('is a Gateway that advertises the admin link and nothing the hub cannot do', () => {
    const r = rig(gatewayConfig, DeviceType.Gateway)
    const device = new RademacherGatewayDevice(r.ctx)
    expect(device.features).toEqual([])
    const caps = [...r.providers.keys()]
    expect(caps).toContain('device-admin-link')
    expect(caps).not.toContain('reboot')
    expect(caps).not.toContain('update')
  })

  it('links to the hub web page from the integration host and base path, and to nothing while it is not running', async () => {
    const r = rig(gatewayConfig, DeviceType.Gateway)
    new RademacherGatewayDevice(r.ctx)
    expect(
      await callCap(r.providers, 'device-admin-link', 'getAdminLink', { deviceId: 7 }),
    ).toBeNull()
    managers.push(await publish({ basePath: '/hp' }))
    const link = await callCap(r.providers, 'device-admin-link', 'getAdminLink', { deviceId: 7 })
    expect(link).toMatchObject({ url: 'http://192.168.10.50/hp/', host: '192.168.10.50' })
    // The password is the integration's secret: it never travels in the link.
    expect(JSON.stringify(link)).not.toContain('secret-pw')
  })

  it('rejects an admin-link request aimed at another device', async () => {
    const r = rig(gatewayConfig, DeviceType.Gateway)
    new RademacherGatewayDevice(r.ctx)
    managers.push(await publish())
    await expect(
      callCap(r.providers, 'device-admin-link', 'getAdminLink', { deviceId: 99 }),
    ).rejects.toThrow(/mismatch/)
  })

  it('follows the session and writes its model, firmware, MAC and host once', async () => {
    const r = rig(gatewayConfig, DeviceType.Gateway)
    const device = new RademacherGatewayDevice(r.ctx)
    const ours = (): unknown[][] =>
      r.setMetadata.mock.calls.filter((c) => JSON.stringify(c).includes('Rademacher'))
    expect(device.online).toBe(false)
    managers.push(await publish())
    await device.onActivate()
    expect(device.online).toBe(true)
    expect(ours()).toHaveLength(1)
    expect(ours()[0]).toEqual([
      {
        deviceId: 7,
        patch: {
          manufacturer: 'Rademacher',
          model: 'HomePilot',
          ip: '192.168.10.50',
          firmware: '5.5.1',
          mac: 'AABBCCDDEEFF',
        },
      },
    ])
    // a poll that changed nothing writes nothing
    rademacherSessions.emitSnapshot(INT)
    await Promise.resolve()
    expect(ours()).toHaveLength(1)
    // the session ends: the box reads offline
    await managers[0]?.stop()
    rademacherSessions.emitSnapshot(INT)
    await vi.waitFor(() => expect(device.online).toBe(false))
    await device.removeDevice()
  })
})

describe('RademacherCoverDevice', () => {
  it('reads its shutter from the integration session, not from a parent hub', async () => {
    const r = rig(
      {
        integrationId: INT,
        system: 'rademacher',
        nativeId: `${INT}:cover:7`,
        did: '7',
        invertPosition: false,
        supportsPosition: true,
        supportsTilt: false,
      },
      DeviceType.Cover,
    )
    const cover = new RademacherCoverDevice(r.ctx)
    expect(cover.online).toBe(false)
    managers.push(await publish())
    await cover.onActivate()
    expect(cover.online).toBe(true)
    await cover.removeDevice()
  })
})
