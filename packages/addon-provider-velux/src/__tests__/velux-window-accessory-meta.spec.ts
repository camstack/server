/**
 * The window container's accessory spec is what the kernel writes into the child's
 * meta row on EVERY spawn (restore included). A role only the child's constructor
 * knows never reaches the row, so the device page found no role for the rain sensor.
 *
 * Disarm: drop `role` from the rain spec's `meta` and this spec fails.
 */
import {
  type DeviceContext,
  DeviceRole,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { VeluxWindowDevice } from '../devices/velux-window-device.js'

/** The kernel's DeviceContext is far wider than the device reads: the one documented spec boundary. */
function makeCtx(): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  return {
    id: 5,
    stableId: 'velux:int:serial:AB',
    parentDeviceId: null,
    deviceMeta: {
      id: 5,
      stableId: 'velux:int:serial:AB',
      addonId: 'stub',
      type: DeviceType.Container,
      name: 'Window',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: {
      integrationId: 'int-1',
      system: 'velux',
      nodeId: 3,
      serial: 'AB',
      nativeId: 'n1',
    },
    initialRuntimeState: {},
    eventBus: {
      emit: () => {},
      subscribe: () => () => {},
      getRecent: () => [],
    },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child() {
        return this
      },
      withTags() {
        return this
      },
    },
    api: {},
  } as unknown as DeviceContext
}

describe('VeluxWindowDevice accessory children', () => {
  it('stamps the leak-sensor role on the rain sensor meta', () => {
    const specs = new VeluxWindowDevice(makeCtx()).getAccessoryChildren()
    const rain = specs.find((s) => s.stableIdSuffix === 'rain')
    expect(rain?.meta.type).toBe(DeviceType.Sensor)
    expect(rain?.meta.role).toBe(DeviceRole.LeakSensor)
  })
})
