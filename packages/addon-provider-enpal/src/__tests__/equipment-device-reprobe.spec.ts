/**
 * The box as a Gateway device, on a stub device context (the one boundary a spec
 * fakes): the one action it registers, and what the link is built from.
 */
import {
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
  type IScopedLogger,
} from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnpalEquipmentDevice } from '../devices/enpal-equipment-device.js'
import { settingsToConnection } from '../config.js'
import { EnpalIntegrationManager } from '../enpal-integration-manager.js'
import { createSnapshot } from '../enpal-snapshot.js'
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

const SYSTEM_CONFIG = { equipment: 'impianto', specIds: [], integrationId: INT, system: 'enpal' }

function rig(persistedConfig: Record<string, unknown> = SYSTEM_CONFIG): {
  readonly ctx: DeviceContext
  readonly providers: Map<string, unknown>
} {
  const providers = new Map<string, unknown>()
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id: 7,
    stableId: `enpal:${INT}:impianto`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Container,
      name: 'Enpal box',
      location: null,
      disabled: false,
      addonId: 'provider-enpal',
      metadata: {},
    },
    persistedConfig,
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
    api: { deviceManager: {} },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as DeviceContext
  return { ctx, providers }
}

function publishBox(): EnpalIntegrationManager {
  const manager = new EnpalIntegrationManager({
    id: INT,
    name: 'Enpal box',
    connection: settingsToConnection({ host: '192.0.2.10', pagePort: 8080 }),
    tokenLocked: false,
    logger: quiet,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: () => undefined,
  })
  enpalConnections.set(INT, manager)
  return manager
}

afterEach(() => enpalConnections.clear())

describe('EnpalEquipmentDevice re-probes once the box answered', () => {
  it('on activation with no snapshot yet it does not re-probe', async () => {
    publishBox()
    const { ctx } = rig()
    const device = new EnpalEquipmentDevice(ctx)
    const reprobe = vi.spyOn(device, 'reprobe').mockResolvedValue(undefined)
    await device.onActivate()
    expect(reprobe).not.toHaveBeenCalled()
  })

  it('re-probes once, when the first snapshot lands', async () => {
    const manager = publishBox()
    const { ctx } = rig()
    const device = new EnpalEquipmentDevice(ctx)
    const reprobe = vi.spyOn(device, 'reprobe').mockResolvedValue(undefined)
    await device.onActivate()
    vi.spyOn(manager, 'getSnapshot').mockReturnValue(createSnapshot('influxdb', [], 1))
    enpalConnections.emitSnapshot(INT)
    enpalConnections.emitSnapshot(INT)
    expect(reprobe).toHaveBeenCalledTimes(1)
  })
})
