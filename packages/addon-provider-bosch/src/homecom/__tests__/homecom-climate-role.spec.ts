/**
 * D1033 — a HomeCom heating circuit is a climate device with the heat-pump
 * circuit role; the role travels on its registration and lands on a row that
 * has none (the hub never replaces a role already set).
 */
import {
  type DeviceContext,
  DeviceRole,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { HomeComClimateDevice } from '../devices/homecom-climate-device.js'

function stubContext(): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the
  // constructor reads (same boundary as homecom-heat-pump-device.spec.ts).
  return {
    id: 11,
    stableId: 'bosch-homecom:int-1:hc1',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Climate,
      name: 'Heating circuit 1',
      location: null,
      disabled: false,
      addonId: 'bosch-homecom',
      metadata: {},
    },
    persistedConfig: { nativeId: 'hc:1', brokerId: 'int-1', circuitId: 'hc1', system: 'homecom' },
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

describe('HomeCom heating circuit role (D1033)', () => {
  it('is a climate device with the heat-pump circuit role', () => {
    const device = new HomeComClimateDevice(stubContext())
    expect(device.type).toBe(DeviceType.Climate)
    expect(device.role).toBe(DeviceRole.ClimateHeatPumpCircuit)
  })
})
