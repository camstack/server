/**
 * #522 — the Enpal storage battery as a device, on a typed fake device context
 * (the one boundary a spec fakes): it is a battery-role SENSOR whose reading is
 * the state of charge, it never registers the `battery` cap, and a restored
 * device retracts the `battery` binding a previous incarnation left on the hub.
 */
import {
  type AddonApi,
  type CapabilityDefinition,
  type DeviceContext,
  type DeviceManagerApi,
  DeviceType,
  type IDeviceRuntimeState,
  type IEventBus,
  type IScopedLogger,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { EnpalSensorDevice } from '../devices/enpal-sensor-device.js'

const INT = 'int-1'
const DEVICE_ID = 5693
const PARENT_ID = 5684

/**
 * TYPE BOUNDARY — `AddonApi` is the GENERATED tRPC client of every capability
 * (the same documented boundary as system's `typed-addon-context.ts`). The
 * sensor device calls no router; the base device only probes
 * `api.deviceManager?.setMetadata` to persist its source info, best effort.
 * This client serves no router at all, exactly as a hub that answers none.
 */
function noRoutersApi(): AddonApi {
  const handler: ProxyHandler<object> = { get: () => undefined }
  return new Proxy({}, handler) as unknown as AddonApi
}

function refuse(name: string): never {
  throw new Error(`sensor-device spec: ctx.devices.${name} is not stubbed`)
}

/** The kernel's device factory, which a leaf sensor never reaches: every method refuses. */
const REFUSING_DEVICES: DeviceManagerApi = {
  create: async () => refuse('create'),
  allocateDeviceId: async () => refuse('allocateDeviceId'),
  createContext: () => refuse('createContext'),
  loadConfig: async () => refuse('loadConfig'),
  persistInitialConfig: async () => refuse('persistInitialConfig'),
  setName: async () => refuse('setName'),
  setLocation: async () => refuse('setLocation'),
  setDisabled: async () => refuse('setDisabled'),
  register: async () => refuse('register'),
  remove: async () => refuse('remove'),
  decommission: async () => refuse('decommission'),
  applyDerivedSpec: async () => refuse('applyDerivedSpec'),
  getAll: async () => refuse('getAll'),
  getChildren: async () => refuse('getChildren'),
}

const SILENT_BUS: IEventBus = {
  emit: () => undefined,
  subscribe: () => () => undefined,
  getRecent: () => [],
}

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Rig {
  readonly ctx: DeviceContext
  /** Cap names the device registered, in order. */
  readonly registered: string[]
  /** Cap names the device retracted from the hub. */
  readonly unregistered: string[]
}

function rig(specId: string): Rig {
  const registered: string[] = []
  const unregistered: string[] = []
  let runtime: IDeviceRuntimeState | null = null
  const ctx: DeviceContext = {
    id: DEVICE_ID,
    stableId: `enpal:${INT}:impianto-${specId}`,
    parentDeviceId: PARENT_ID,
    logger: silentLogger(),
    api: noRoutersApi(),
    eventBus: SILENT_BUS,
    persistConfig: async () => undefined,
    initialRuntimeState: {},
    persistedConfig: { specId, integrationId: INT, system: 'enpal' },
    deviceMeta: {
      id: DEVICE_ID,
      stableId: `enpal:${INT}:impianto-${specId}`,
      addonId: 'provider-enpal',
      type: DeviceType.Sensor,
      name: 'Battery',
      location: null,
      disabled: false,
      parentDeviceId: PARENT_ID,
      metadata: null,
    },
    fetchDevice: async () => refuse('fetchDevice'),
    bindRuntimeState: (state) => {
      runtime = state
    },
    devices: REFUSING_DEVICES,
    registerNativeCap<TCap extends CapabilityDefinition>(cap: TCap): void {
      registered.push(cap.name)
      const schema = cap.runtimeState
      if (schema !== undefined && runtime !== null) runtime.installCapSchema(cap.name, schema)
    },
    unregisterNativeCap(capName: string): void {
      unregistered.push(capName)
    },
  }
  return { ctx, registered, unregistered }
}

describe('#522 — the storage battery is a sensor reading, not the battery cap', () => {
  it('registers numeric-sensor and power-meter, never battery, and retracts a stale battery binding', async () => {
    const { ctx, registered, unregistered } = rig('battery')
    const device = new EnpalSensorDevice(ctx)
    await device.onActivate()
    expect(registered).toEqual(expect.arrayContaining(['numeric-sensor', 'power-meter']))
    expect(registered).not.toContain('battery')
    expect(unregistered).toEqual(['battery'])
    // What the hub can read off the device: no battery slice.
    expect(device.runtimeState.getCapState('battery')).toBeUndefined()
    // …and the reading is a percentage, so the battery-sensor role renders it as a charge.
    expect(device.sourceInfo.quantity).toBe('percentage')
    await device.removeDevice()
  })

  it('a device of another kind retracts nothing', async () => {
    const { ctx, unregistered } = rig('battery-health')
    const device = new EnpalSensorDevice(ctx)
    await device.onActivate()
    expect(unregistered).toEqual([])
    await device.removeDevice()
  })
})
