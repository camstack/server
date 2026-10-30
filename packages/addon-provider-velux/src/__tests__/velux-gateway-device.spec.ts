/**
 * The gateway box and the window container, built on a stub device context (the
 * one boundary a spec has to fake): what they register, how they follow the
 * integration's session, and what the reboot action does.
 */
import {
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VeluxGatewayDevice } from '../devices/velux-gateway-device.js'
import { VeluxWindowDevice } from '../devices/velux-window-device.js'
import type { VeluxGatewayClient } from '../velux-client-contract.js'
import { veluxGateways, type VeluxNodeSource } from '../velux-node-resolver.js'
import { RecordingLogger } from './recording-logger.js'

const INT = 'int-7f3a'

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
    stableId: `velux:${INT}:gateway`,
    parentDeviceId: null,
    deviceMeta: {
      type,
      name: 'Casa KLF',
      location: null,
      disabled: false,
      addonId: 'provider-velux',
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

function gatewayConfig(): Record<string, unknown> {
  return { integrationId: INT, system: 'velux', nativeId: `${INT}:gateway` }
}

/** Call `method` on the provider the device registered for `cap`. */
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

class StubClient {
  rebooted = 0
  async reboot(): Promise<void> {
    this.rebooted += 1
  }
}

function publish(
  source: Partial<Omit<VeluxNodeSource, 'client'>> & { client: StubClient | null },
): StubClient | null {
  const client = source.client
  const full: VeluxNodeSource = {
    getNodes: () => [],
    getNode: () => null,
    getConnection: () => ({ host: '192.168.20.65', password: 'secret' }),
    status: 'connected',
    firmware: '0.2.0.0.71.0',
    ...source,
    // The stub implements only what the gateway device calls on a client.
    client: client as unknown as VeluxGatewayClient | null,
  }
  veluxGateways.set(INT, full)
  return client
}

afterEach(() => {
  veluxGateways.clear()
})

describe('VeluxGatewayDevice', () => {
  it('is a Gateway that advertises reboot and the admin link, and nothing it cannot do', () => {
    const r = rig(gatewayConfig(), DeviceType.Gateway)
    const device = new VeluxGatewayDevice(r.ctx)
    expect(device.features).toEqual([DeviceFeature.Rebootable])
    const caps = [...r.providers.keys()]
    expect(caps).toContain('reboot')
    expect(caps).toContain('device-admin-link')
    expect(caps).not.toContain('update')
  })

  it('reboots the gateway through the live session', async () => {
    const r = rig(gatewayConfig(), DeviceType.Gateway)
    new VeluxGatewayDevice(r.ctx)
    const client = publish({ client: new StubClient() })
    await expect(callCap(r.providers, 'reboot', 'reboot', { deviceId: 7 })).resolves.toEqual({
      success: true,
    })
    expect(client?.rebooted).toBe(1)
  })

  it('refuses to reboot with no live session, and says so on the record', async () => {
    const r = rig(gatewayConfig(), DeviceType.Gateway)
    new VeluxGatewayDevice(r.ctx)
    publish({ client: null, status: 'disconnected' })
    await expect(callCap(r.providers, 'reboot', 'reboot', { deviceId: 7 })).rejects.toThrow(
      /session is down/,
    )
    const line = r.logger.lines.find((l) => l.message.includes('reboot refused'))
    expect(line?.level).toBe('warn')
    expect(line?.tags['deviceId']).toBe(7)
  })

  it('rejects a reboot aimed at another device', async () => {
    const r = rig(gatewayConfig(), DeviceType.Gateway)
    new VeluxGatewayDevice(r.ctx)
    publish({ client: new StubClient() })
    await expect(callCap(r.providers, 'reboot', 'reboot', { deviceId: 99 })).rejects.toThrow(
      /mismatch/,
    )
  })

  it('links to the unit web page from the integration host, and to nothing while it is not running', async () => {
    const r = rig(gatewayConfig(), DeviceType.Gateway)
    new VeluxGatewayDevice(r.ctx)
    expect(
      await callCap(r.providers, 'device-admin-link', 'getAdminLink', { deviceId: 7 }),
    ).toBeNull()
    publish({ client: null })
    const link = await callCap(r.providers, 'device-admin-link', 'getAdminLink', { deviceId: 7 })
    expect(link).toMatchObject({ url: 'https://192.168.20.65/', host: '192.168.20.65' })
  })

  it('follows the session and writes its firmware and host once', async () => {
    const r = rig(gatewayConfig(), DeviceType.Gateway)
    const device = new VeluxGatewayDevice(r.ctx)
    // the base class also writes sourceInfo through setMetadata; count only the gateway's patch
    const ours = (): unknown[][] =>
      r.setMetadata.mock.calls.filter((c) => JSON.stringify(c).includes('KLF-200'))
    expect(device.online).toBe(false)
    publish({ client: new StubClient() })
    await device.onActivate()
    expect(device.online).toBe(true)
    expect(ours()).toHaveLength(1)
    expect(ours()[0]).toEqual([
      {
        deviceId: 7,
        patch: {
          manufacturer: 'Velux',
          model: 'KLF-200',
          ip: '192.168.20.65',
          firmware: '0.2.0.0.71.0',
        },
      },
    ])
    // a push that changed nothing writes nothing
    veluxGateways.emitSnapshot(INT)
    await Promise.resolve()
    expect(ours()).toHaveLength(1)
    // the session ends: the box reads offline
    publish({ client: null, status: 'disconnected' })
    veluxGateways.emitSnapshot(INT)
    await vi.waitFor(() => expect(device.online).toBe(false))
    await device.removeDevice()
  })
})

describe('VeluxWindowDevice', () => {
  it('groups the window cover and its rain sensor, both on the window node', () => {
    const r = rig(
      {
        integrationId: INT,
        system: 'velux',
        nativeId: `${INT}:serial:aa01`,
        nodeId: 3,
        serial: 'aa01',
        coverClass: 'window',
      },
      DeviceType.Container,
    )
    const window = new VeluxWindowDevice(r.ctx)
    const children = window.getAccessoryChildren()
    expect(children.map((c) => [c.stableIdSuffix, c.meta.type, c.meta.name])).toEqual([
      ['cover', DeviceType.Cover, 'Casa KLF'],
      ['rain', DeviceType.Sensor, 'Casa KLF rain'],
    ])
    for (const child of children) {
      expect(child.meta.linkDeviceId).toBe(7)
      expect(child.config).toMatchObject({
        integrationId: INT,
        system: 'velux',
        nodeId: 3,
        serial: 'aa01',
      })
    }
  })
})
