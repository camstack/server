/**
 * The library's own poll is off (the core is the only scheduler, D1062), and
 * MQTT pushes only TRANSITIONS: while it is down, the robot's status, battery
 * and errors would freeze unless the core read itself re-reads them.
 */
import { type Nodreame, VacuumDevice } from '@apocaliss92/nodedreame'
import {
  type DeviceContext,
  DeviceType,
  deviceStateRefreshCapability,
  type IDeviceRuntimeState,
} from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DreameVacuumDevice } from '../devices/dreame-vacuum-device.js'
import { dreameFacades } from '../dreame-gateway.js'

const BROKER = 'int_0010'
const DID = 'did-vac'

/**
 * A vacuum handle for `instanceof`: its state getters live behind private
 * library fields, so a prototype-only object answers them from `values`.
 */
function vacuumHandle(refreshFromCache: () => Promise<void>): VacuumDevice {
  const values: Readonly<Record<string | symbol, unknown>> = {
    deviceId: DID,
    refreshFromCache,
    refreshAiDetection: async () => {},
    getCurrentSignal: async () => null,
    getProperty: () => undefined,
    vacuumCapabilities: {},
    supportedSuctionLevels: [],
    supportedConsumables: [],
    refreshConsumables: async () => {},
    refreshCachedProperties: async () => [],
    refreshProperties: async () => [],
    errorCode: 0,
    status: 0,
    battery: 80,
    suction: 1,
    taskProgressPct: 0,
  }
  return new Proxy<VacuumDevice>(Object.create(VacuumDevice.prototype), {
    get: (_target, key) => values[key],
  })
}

function ctx(registerNativeCap: (cap: unknown, ...rest: unknown[]) => void): DeviceContext {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let runtimeState: IDeviceRuntimeState | null = null
  const context = {
    id: 200,
    stableId: `dreame:${DID}:vacuum`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Vacuum,
      name: 'Robot',
      location: null,
      disabled: false,
      addonId: 'provider-dreame',
      metadata: {},
    },
    persistedConfig: { dreameDeviceId: DID, brokerId: BROKER, model: 'dreame.vacuum.r2538z' },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeState = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }, ...rest: unknown[]) => {
      registerNativeCap(cap, ...rest)
      if (cap.runtimeState === undefined || runtimeState === null) return
      runtimeState.installCapSchema(
        cap.name,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- schema handed through by the test double
        cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
      )
    },
    unregisterNativeCap: vi.fn(),
    api: {},
    logger,
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- DeviceContext test double
  return context as unknown as DeviceContext
}

describe('vacuum core state refresh (D1062)', () => {
  afterEach(() => {
    dreameFacades.clear()
  })

  it('a core refresh re-reads the robot main state, so a dead MQTT does not freeze it', async () => {
    const refreshFromCache = vi.fn(async () => {})
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- facade test double: only `devices` is read
    dreameFacades.set(BROKER, { devices: [vacuumHandle(refreshFromCache)] } as unknown as Nodreame)
    const registerNativeCap = vi.fn()
    const device = new DreameVacuumDevice(ctx(registerNativeCap))
    await device.onActivate()

    const call = registerNativeCap.mock.calls.find((c) => c[0] === deviceStateRefreshCapability)
    expect(call).toBeDefined()
    refreshFromCache.mockClear()
    await call?.[1].refresh({ reason: 'schedule' })

    expect(refreshFromCache).toHaveBeenCalledTimes(1)
    await device.removeDevice()
  })
})
