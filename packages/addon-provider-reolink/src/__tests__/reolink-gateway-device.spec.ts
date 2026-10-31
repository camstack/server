/**
 * The hub as a Gateway device, on a stub device context (the one boundary a spec
 * fakes): the actions it registers, what reboot really calls, and the admin link.
 */
import {
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReolinkGatewayDevice } from '../reolink-gateway-device.js'
import { type HubSessionHandle, reolinkHubSessions } from '../reolink-hub-session.js'

const INT = 'int-1'

function rig(): { readonly ctx: DeviceContext; readonly providers: Map<string, unknown> } {
  const providers = new Map<string, unknown>()
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id: 7,
    stableId: `provider-reolink:${INT}:gateway`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Gateway,
      name: 'Home Hub',
      location: null,
      disabled: false,
      addonId: 'provider-reolink',
      metadata: {},
    },
    persistedConfig: { integrationId: INT, nativeId: `${INT}:gateway` },
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

async function call(
  providers: Map<string, unknown>,
  cap: string,
  method: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const provider = providers.get(cap)
  if (typeof provider !== 'object' || provider === null) throw new Error(`no provider for ${cap}`)
  const fn: unknown = Reflect.get(provider, method)
  if (typeof fn !== 'function') throw new Error(`no ${method} on ${cap}`)
  return await fn.call(provider, input)
}

function publish(reboot: () => Promise<void>): void {
  const handle: HubSessionHandle = {
    isOnline: true,
    reboot,
    getApi: async () => {
      throw new Error('the gateway never reads the api directly')
    },
    relayEndpoint: () => ({ host: '10.0.0.5', username: 'admin', password: 'pw', port: 554 }),
  }
  reolinkHubSessions.set(INT, handle)
}

afterEach(() => {
  reolinkHubSessions.clear()
})

describe('ReolinkGatewayDevice', () => {
  it('is a Gateway advertised as rebootable, with reboot and the admin link', async () => {
    const { ctx, providers } = rig()
    const device = new ReolinkGatewayDevice(ctx)
    await device.onActivate()
    expect(device.type).toBe(DeviceType.Gateway)
    expect(device.features).toContain(DeviceFeature.Rebootable)
    expect([...providers.keys()]).toEqual(expect.arrayContaining(['reboot', 'device-admin-link']))
  })

  it('reboot calls the hub api reboot, and refuses while there is no session', async () => {
    const { ctx, providers } = rig()
    new ReolinkGatewayDevice(ctx)
    await expect(call(providers, 'reboot', 'reboot', { deviceId: 7 })).rejects.toThrow(/session/)
    const reboot = vi.fn(async () => {})
    publish(reboot)
    await expect(call(providers, 'reboot', 'reboot', { deviceId: 7 })).resolves.toEqual({
      success: true,
    })
    expect(reboot).toHaveBeenCalledTimes(1)
  })

  it('builds the admin link from the hub host and carries no credentials', async () => {
    const { ctx, providers } = rig()
    new ReolinkGatewayDevice(ctx)
    expect(await call(providers, 'device-admin-link', 'getAdminLink', { deviceId: 7 })).toBeNull()
    publish(async () => {})
    const link = await call(providers, 'device-admin-link', 'getAdminLink', { deviceId: 7 })
    expect(link).toMatchObject({ url: 'https://10.0.0.5/', host: '10.0.0.5' })
    expect(JSON.stringify(link)).not.toContain('pw')
  })
})
