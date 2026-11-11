/**
 * D1033 — a Gree air conditioner is a climate device with the AC role; the
 * role travels on its registration and lands on a row that has none.
 */
import {
  type DeviceContext,
  DeviceRole,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { GreeAcDevice } from '../devices/gree-ac-device.js'

function stubContext(): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the
  // constructor reads (same boundary as the HomeCom climate-role spec).
  return {
    id: 21,
    stableId: 'gree-aabbcc-ac',
    parentDeviceId: 20,
    deviceMeta: {
      type: DeviceType.Climate,
      name: 'Living room AC',
      location: null,
      disabled: false,
      addonId: 'gree',
      metadata: {},
    },
    persistedConfig: { greeMac: 'aabbcc', connectionKey: 'k1', system: 'gree' },
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
    api: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as DeviceContext
}

describe('Gree AC role (D1033)', () => {
  it('is a climate device with the AC role', () => {
    const device = new GreeAcDevice(stubContext())
    expect(device.type).toBe(DeviceType.Climate)
    expect(device.role).toBe(DeviceRole.ClimateAc)
  })
})
