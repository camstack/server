/**
 * The CCU box, built on a stub device context (the one boundary a spec has to
 * fake): what it registers, how it follows the integration's session, and what
 * it refuses to claim.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HomematicConfig } from '../config.js'
import { HomematicGatewayDevice } from '../devices/homematic-gateway-device.js'
import { homematicFacades } from '../homematic-facade-resolver.js'
import type { HmSessionInfo, HmSessionStatus } from '../homematic-integration-manager.js'
import { RecordingLogger } from './recording-logger.js'

const INT = 'int-1'

interface Rig {
  readonly ctx: DeviceContext
  readonly providers: Map<string, unknown>
  readonly logger: RecordingLogger
  readonly setMetadata: ReturnType<typeof vi.fn>
}

function rig(config: Record<string, unknown>): Rig {
  const providers = new Map<string, unknown>()
  const logger = new RecordingLogger()
  const setMetadata = vi.fn(async () => {})
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what this device reads.
  const ctx = {
    id: 7,
    stableId: `hm:${INT}:gateway`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Gateway,
      name: 'Casa CCU',
      location: null,
      disabled: false,
      addonId: 'provider-homematic',
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

const gatewayConfig = { integrationId: INT, system: 'homematic', nativeId: `${INT}:gateway` }

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

/** A session whose status the spec flips; it satisfies the resolver's session view structurally. */
class FakeSession {
  status: HmSessionStatus = 'connected'
  constructor(private readonly connection: Pick<HomematicConfig, 'host' | 'tls'>) {}
  getConnection(): HomematicConfig {
    return {
      host: this.connection.host,
      tls: this.connection.tls,
      enableHmipRf: true,
      enableBidcosRf: false,
      enableGroups: false,
      enableBidcosWired: false,
      callbackHost: '',
      callbackPort: 2128,
      username: '',
      password: '',
    }
  }
  getInfo(): HmSessionInfo {
    return {
      id: INT,
      name: 'Casa CCU',
      kind: 'homematic',
      status: this.status,
      info: {},
      lastCheckedAt: null,
      error: null,
    }
  }
}

function publish(connection: Pick<HomematicConfig, 'host' | 'tls'>): FakeSession {
  const session = new FakeSession(connection)
  homematicFacades.setSession(INT, session)
  return session
}

afterEach(() => {
  homematicFacades.clear()
})

describe('HomematicGatewayDevice', () => {
  it('is a Gateway that advertises the admin link and nothing the CCU cannot do', () => {
    const r = rig(gatewayConfig)
    const device = new HomematicGatewayDevice(r.ctx)
    expect(device.features).toEqual([])
    const caps = [...r.providers.keys()]
    expect(caps).toContain('device-admin-link')
    expect(caps).not.toContain('reboot')
    expect(caps).not.toContain('update')
  })

  it('links to the CCU WebUI over http or https per the integration, and to nothing while it is not running', async () => {
    const r = rig(gatewayConfig)
    new HomematicGatewayDevice(r.ctx)
    expect(
      await callCap(r.providers, 'device-admin-link', 'getAdminLink', { deviceId: 7 }),
    ).toBeNull()
    publish({ host: '192.168.10.40', tls: false })
    expect(
      await callCap(r.providers, 'device-admin-link', 'getAdminLink', { deviceId: 7 }),
    ).toMatchObject({ url: 'http://192.168.10.40/', host: '192.168.10.40', label: 'CCU WebUI' })
    publish({ host: '192.168.10.40', tls: true })
    expect(
      await callCap(r.providers, 'device-admin-link', 'getAdminLink', { deviceId: 7 }),
    ).toMatchObject({ url: 'https://192.168.10.40/' })
  })

  it('rejects an admin-link request aimed at another device', async () => {
    const r = rig(gatewayConfig)
    new HomematicGatewayDevice(r.ctx)
    publish({ host: '192.168.10.40', tls: false })
    await expect(
      callCap(r.providers, 'device-admin-link', 'getAdminLink', { deviceId: 99 }),
    ).rejects.toThrow(/mismatch/)
  })

  it('never puts the WebUI password in the link', async () => {
    const r = rig(gatewayConfig)
    new HomematicGatewayDevice(r.ctx)
    publish({ host: '192.168.10.40', tls: false })
    const link = await callCap(r.providers, 'device-admin-link', 'getAdminLink', { deviceId: 7 })
    expect(JSON.stringify(link)).not.toContain('secret')
  })

  it('follows the session and writes its host once', async () => {
    const r = rig(gatewayConfig)
    const device = new HomematicGatewayDevice(r.ctx)
    const ours = (): unknown[][] =>
      r.setMetadata.mock.calls.filter((c) => JSON.stringify(c).includes('eQ-3'))
    expect(device.online).toBe(false)
    const session = publish({ host: '192.168.10.40', tls: false })
    await device.onActivate()
    expect(device.online).toBe(true)
    expect(ours()).toEqual([
      [
        {
          deviceId: 7,
          patch: { manufacturer: 'eQ-3', model: 'CCU3 / RaspberryMatic', ip: '192.168.10.40' },
        },
      ],
    ])
    // a state change that altered nothing about the box writes nothing
    homematicFacades.emitSnapshot(INT)
    await Promise.resolve()
    expect(ours()).toHaveLength(1)
    // the session drops: the box reads offline, and the transition is logged on the device
    session.status = 'disconnected'
    homematicFacades.emitSnapshot(INT)
    await vi.waitFor(() => expect(device.online).toBe(false))
    expect(
      r.logger.lines.some(
        (l) => l.message === 'Homematic gateway offline' && l.tags['deviceId'] === 7,
      ),
    ).toBe(true)
    await device.removeDevice()
  })

  it('stops following the session once removed', async () => {
    const r = rig(gatewayConfig)
    const device = new HomematicGatewayDevice(r.ctx)
    const session = publish({ host: '192.168.10.40', tls: false })
    await device.onActivate()
    await device.removeDevice()
    session.status = 'disconnected'
    homematicFacades.emitSnapshot(INT)
    await Promise.resolve()
    expect(device.online).toBe(true)
  })
})
