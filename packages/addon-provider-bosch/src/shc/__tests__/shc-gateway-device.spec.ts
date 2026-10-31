/**
 * The controller box as a Gateway device, on a stub device context (the one
 * boundary a spec fakes): what it registers and how it follows the session.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { ShcGatewayDevice } from '../devices/shc-gateway-device.js'
import { shcConnections } from '../shc-gateway.js'
import type { ShcClient } from '../shc-client.js'

function rig(): { readonly ctx: DeviceContext; readonly registered: string[] } {
  const registered: string[] = []
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id: 9,
    stableId: 'bosch-shc:int-1:int-1:controller',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Gateway,
      name: 'Bosch SHC',
      location: null,
      disabled: false,
      addonId: 'bosch-shc',
      metadata: {},
    },
    persistedConfig: {
      shcDeviceId: 'int-1:controller',
      brokerId: 'int-1',
      system: 'bosch-shc',
      integrationId: 'int-1',
    },
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
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      registered.push(cap.name)
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
  return { ctx, registered }
}

describe('ShcGatewayDevice', () => {
  it('is a Gateway that registers no action the controller cannot perform', async () => {
    const { ctx, registered } = rig()
    const device = new ShcGatewayDevice(ctx)
    await device.onActivate()
    expect(device.type).toBe(DeviceType.Gateway)
    expect(registered).not.toContain('reboot')
    expect(registered).not.toContain('device-admin-link')
    expect(registered).not.toContain('device-update')
  })

  it('starts online only while the integration has a live session', () => {
    expect(new ShcGatewayDevice(rig().ctx).online).toBe(false)
    const client = { close: vi.fn() } as unknown as ShcClient
    shcConnections.set('int-1', { devices: [], client })
    expect(new ShcGatewayDevice(rig().ctx).online).toBe(true)
    shcConnections.set('int-1', null)
  })
})
