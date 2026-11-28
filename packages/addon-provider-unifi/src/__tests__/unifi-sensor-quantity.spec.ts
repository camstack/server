/**
 * A UniFi numeric sensor child declares its quantity on `SourceInfo` (D944), and does so on every
 * construction, so a device adopted before the quantity existed picks it up on restore.
 */
import {
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
  type IScopedLogger,
} from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import { UnifiFeatureDevice } from '../devices/unifi-feature-device.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

function rig(metric: string, storedSourceInfo: Record<string, unknown>) {
  const setMetadata = vi.fn(async () => undefined)
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id: 5884,
    stableId: 'unifi:u1:sensor:d1:uptime',
    parentDeviceId: 5876,
    deviceMeta: {
      type: DeviceType.Sensor,
      name: 'Uptime',
      location: null,
      disabled: false,
      addonId: 'provider-unifi',
      metadata: { sourceInfo: storedSourceInfo },
    },
    persistedConfig: { kind: 'sensor', integrationId: 'u1', infraNativeId: 'd1', metric },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: { deviceManager: { setMetadata: { mutate: setMetadata } } },
    logger: quiet,
  } as unknown as DeviceContext
  return { ctx, setMetadata }
}

const STALE = { id: 'u1:d1:sensor:uptime', system: 'unifi', raw: { marker: 'kept' } }

describe('UnifiFeatureDevice sensor quantity', () => {
  it('an existing uptime sensor is updated to duration on restore, keeping what it had', async () => {
    const { ctx, setMetadata } = rig('uptime', STALE)
    const device = new UnifiFeatureDevice(ctx)
    await vi.waitFor(() => expect(setMetadata).toHaveBeenCalled())
    expect(device.sourceInfo.quantity).toBe('duration')
    expect(device.sourceInfo.raw).toEqual({ marker: 'kept' })
  })

  it('cpu utilisation is a percentage, clients a count', async () => {
    const cpu = new UnifiFeatureDevice(rig('cpu_utilization', STALE).ctx)
    const clients = new UnifiFeatureDevice(rig('clients', STALE).ctx)
    await vi.waitFor(() => expect(cpu.sourceInfo.quantity).toBe('percentage'))
    await vi.waitFor(() => expect(clients.sourceInfo.quantity).toBe('count'))
  })
})
