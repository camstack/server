/**
 * #522 — the Enpal storage battery as a device, on a stub device context (the one
 * boundary a spec fakes): it is a battery-role SENSOR whose reading is the state of
 * charge, it never registers the `battery` cap, and a restored device retracts the
 * `battery` binding a previous incarnation left on the hub.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { EnpalSensorDevice } from '../devices/enpal-sensor-device.js'

const INT = 'int-1'

interface Rig {
  readonly ctx: DeviceContext
  readonly registered: string[]
  readonly unregistered: string[]
}

function rig(specId: string): Rig {
  const registered: string[] = []
  const unregistered: string[] = []
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id: 5693,
    stableId: `enpal:${INT}:impianto-${specId}`,
    parentDeviceId: 5684,
    deviceMeta: {
      type: DeviceType.Sensor,
      name: 'Battery',
      location: null,
      disabled: false,
      addonId: 'provider-enpal',
      metadata: {},
    },
    persistedConfig: { specId, integrationId: INT, system: 'enpal' },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
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
    unregisterNativeCap: vi.fn((capName: string) => {
      unregistered.push(capName)
    }),
    api: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as DeviceContext
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
    expect(device.runtimeState.getCapState('battery')).toBeUndefined()
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
