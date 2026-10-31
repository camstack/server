/**
 * The box as a Gateway device, on a stub device context (the one boundary a spec
 * fakes): the one action it registers, and what the link is built from.
 */
import {
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  type IDeviceRuntimeState,
  type IScopedLogger,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnpalGatewayDevice } from '../devices/enpal-gateway-device.js'
import { settingsToConnection } from '../config.js'
import { EnpalIntegrationManager } from '../enpal-integration-manager.js'
import { enpalConnections } from '../enpal-resolver.js'

const INT = 'int-1'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

function rig(): { readonly ctx: DeviceContext; readonly providers: Map<string, unknown> } {
  const providers = new Map<string, unknown>()
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id: 7,
    stableId: `enpal:${INT}:box`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Gateway,
      name: 'Enpal box',
      location: null,
      disabled: false,
      addonId: 'provider-enpal',
      metadata: {},
    },
    persistedConfig: { equipment: 'box', integrationId: INT, system: 'enpal' },
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
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as DeviceContext
  return { ctx, providers }
}

async function getLink(providers: Map<string, unknown>): Promise<unknown> {
  const provider = providers.get('device-admin-link')
  if (typeof provider !== 'object' || provider === null) throw new Error('no admin link provider')
  const fn: unknown = Reflect.get(provider, 'getAdminLink')
  if (typeof fn !== 'function') throw new Error('no getAdminLink')
  return await fn.call(provider, { deviceId: 7 })
}

function publishBox(host: string, pagePort: number): void {
  // A real manager that was never started: the device reads only its connection.
  enpalConnections.set(
    INT,
    new EnpalIntegrationManager({
      id: INT,
      name: 'Enpal box',
      connection: settingsToConnection({ host, pagePort }),
      tokenLocked: false,
      logger: quiet,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
    }),
  )
}

afterEach(() => enpalConnections.clear())

describe('EnpalGatewayDevice', () => {
  it('is a Gateway with the admin link only: the box has no reboot or update', async () => {
    const { ctx, providers } = rig()
    const device = new EnpalGatewayDevice(ctx)
    await device.onActivate()
    expect(device.type).toBe(DeviceType.Gateway)
    expect(device.features).not.toContain(DeviceFeature.Rebootable)
    expect(providers.has('device-admin-link')).toBe(true)
    expect(providers.has('reboot')).toBe(false)
  })

  it('links to the local device page of the box, and to nothing while it is not running', async () => {
    const { ctx, providers } = rig()
    new EnpalGatewayDevice(ctx)
    expect(await getLink(providers)).toBeNull()
    publishBox('192.0.2.10', 8080)
    expect(await getLink(providers)).toMatchObject({
      url: 'http://192.0.2.10:8080/deviceMessages',
      host: '192.0.2.10',
    })
  })
})
