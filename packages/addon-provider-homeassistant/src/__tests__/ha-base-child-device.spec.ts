import { describe, it, expect, vi } from 'vitest'
import {
  DeviceType,
  type IDeviceRuntimeState,
  type ControlStatus,
  type TemperatureSensorStatus,
  type LockControlStatus,
} from '@camstack/types'
import { HaCoverDevice } from '../devices/ha-cover-device.js'
import { HaNumericSensorDevice } from '../devices/ha-numeric-sensor-device.js'
import { HaControlDevice } from '../devices/ha-control-device.js'
import { precisionFromStep } from '../devices/ha-control-device.js'
import { HaLockDevice } from '../devices/ha-lock-device.js'

interface BrokerApiStubs {
  subscribeMutate: ReturnType<typeof vi.fn>
  unsubscribeMutate: ReturnType<typeof vi.fn>
}

function stubDeviceManager(setMetadataMutate: ReturnType<typeof vi.fn> = vi.fn(async () => {})) {
  return {
    registerDevice: { mutate: vi.fn(async () => ({})) },
    setMetadata: { mutate: setMetadataMutate },
  }
}

interface CoverDeviceResult {
  names: string[]
  device: HaCoverDevice
}

/** Build a DeviceContext stub, instantiate HaCoverDevice, return the cap
 *  names it registered, the device instance, and broker API stubs for assertion. */
function registeredFor(
  config: Record<string, unknown>,
  brokerStubs?: BrokerApiStubs,
): CoverDeviceResult {
  const names: string[] = []
  let runtimeStateRef: IDeviceRuntimeState | null = null

  const subscribeMutate =
    brokerStubs?.subscribeMutate ?? vi.fn(async () => ({ subscriptionId: 'sub-1' }))
  const unsubscribeMutate = brokerStubs?.unsubscribeMutate ?? vi.fn(async () => {})

  const ctx = {
    id: 7,
    stableId: 'ha:test:7',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Cover,
      name: 'Test Cover',
      location: null,
      disabled: false,
      addonId: 'ha',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 1),
      createContext: vi.fn(() => null),
      register: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      decommission: vi.fn(async () => {}),
      getAll: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
    },
    // Mirror the real kernel: install the cap's runtime-state schema
    // onto the device's runtime state when present. Without this,
    // BaseDevice's auto-seed of `device-status` throws.
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      names.push(cap.name)
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      broker: {
        publish: { mutate: vi.fn() },
        subscribe: { mutate: subscribeMutate },
        unsubscribe: { mutate: unsubscribeMutate },
      },
      deviceManager: stubDeviceManager(),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as import('@camstack/types').DeviceContext
  const device = new HaCoverDevice(ctx)
  return { names, device }
}

/** Build a DeviceContext stub and instantiate HaNumericSensorDevice, returning the device instance. */
function instantiateNumericSensor(config: Record<string, unknown>): HaNumericSensorDevice {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const setMetadataMutate = vi.fn(async () => {})

  const ctx = {
    id: 8,
    stableId: 'ha:test:8',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Sensor,
      name: 'Test Sensor',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 1),
      createContext: vi.fn(() => null),
      register: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      decommission: vi.fn(async () => {}),
      getAll: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
    },
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      broker: {
        publish: { mutate: vi.fn() },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-sensor-1' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
      },
      deviceManager: stubDeviceManager(setMetadataMutate),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as import('@camstack/types').DeviceContext

  return new HaNumericSensorDevice(ctx)
}

/** Build a DeviceContext for a HaCoverDevice, exposing the broker subscribe stub
 *  and the device instance so callers can invoke onActivate() and assert. */
function makeCoverWithBrokerStubs(config: Record<string, unknown>): {
  device: HaCoverDevice
  subscribeMutate: ReturnType<typeof vi.fn>
  unsubscribeMutate: ReturnType<typeof vi.fn>
} {
  const subscribeMutate = vi.fn(async () => ({ subscriptionId: 'sub-cover-42' }))
  const unsubscribeMutate = vi.fn(async () => {})
  const { device } = registeredFor(config, { subscribeMutate, unsubscribeMutate })
  return { device, subscribeMutate, unsubscribeMutate }
}

describe('HaBaseChildDevice broker subscription', () => {
  it('does NOT call broker.subscribe before onActivate', async () => {
    const { subscribeMutate } = makeCoverWithBrokerStubs({
      brokerId: 'ha_001',
      entityId: 'cover.tapparella_camera_da_letto',
      capabilities: ['cover'],
    })
    // Flush any pending microtasks that could arise from construction.
    await Promise.resolve()
    // Subscribe must NOT have been called yet — caps are not all registered
    // until the subclass constructor finishes, which precedes onActivate.
    expect(subscribeMutate).not.toHaveBeenCalled()
  })

  it('calls broker.subscribe with the entity entityIds filter in/after onActivate', async () => {
    const { device, subscribeMutate } = makeCoverWithBrokerStubs({
      brokerId: 'ha_001',
      entityId: 'cover.tapparella_camera_da_letto',
      capabilities: ['cover'],
    })
    await device.onActivate()
    expect(subscribeMutate).toHaveBeenCalledWith({
      brokerId: 'ha_001',
      filter: { entityIds: ['cover.tapparella_camera_da_letto'] },
    })
  })
})

describe('HaBaseChildDevice parent-mode', () => {
  it('registers accessories cap when childDeviceIds present', () => {
    const { names } = registeredFor({
      brokerId: 'b1',
      entityId: 'cover.lr',
      capabilities: ['cover'],
      childDeviceIds: [11, 12],
    })
    expect(names).toContain('cover')
    expect(names).toContain('accessories')
  })
  it('does NOT register accessories for a plain child', () => {
    const { names } = registeredFor({
      brokerId: 'b1',
      entityId: 'cover.lr',
      capabilities: ['cover'],
    })
    expect(names).toContain('cover')
    expect(names).not.toContain('accessories')
  })
})

describe('HaBaseChildDevice sourceInfo', () => {
  it('publishes identity-only sourceInfo (entityId + system, no unit/deviceClass)', async () => {
    // sourceInfo is now identity-only. unit/deviceClass are NOT stored here —
    // unit flows live via the numeric-sensor slice; deviceClass is only an
    // input to ha-domain-mapping → role and is not persisted.
    const dev = instantiateNumericSensor({
      brokerId: 'b1',
      entityId: 'sensor.t',
      capabilities: ['temperature-sensor'],
      unitOfMeasurement: 'celsius',
      deviceClass: 'temperature',
    })
    await Promise.resolve() // let the fire-and-forget updateSourceInfo settle
    expect(dev.sourceInfo.id).toBe('sensor.t')
    expect(dev.sourceInfo.system).toBe('homeassistant')
    expect((dev.sourceInfo as Record<string, unknown>)['unit']).toBeUndefined()
    expect((dev.sourceInfo as Record<string, unknown>)['deviceClass']).toBeUndefined()
  })
})

describe('HaNumericSensorDevice handleStatePush — unit in slice', () => {
  it('populates unit + precision in the numeric-sensor slice from state attributes on push', () => {
    // This test verifies that the live unit flows through the slice, not sourceInfo.
    // We drive handleStatePush indirectly via the event bus, then read the
    // cap status through runtimeState.
    let runtimeStateRef: IDeviceRuntimeState | null = null
    let eventHandler: ((event: { data: unknown }) => void) | null = null
    const setMetadataMutate = vi.fn(async () => {})

    const ctx = {
      id: 42,
      stableId: 'ha:test:42',
      parentDeviceId: null,
      deviceMeta: {
        type: DeviceType.Sensor,
        name: 'Signal Sensor',
        location: null,
        disabled: false,
        addonId: 'homeassistant',
        metadata: {},
      },
      persistedConfig: {
        brokerId: 'b1',
        entityId: 'sensor.signal',
        capabilities: ['numeric-sensor'],
      },
      initialRuntimeState: {},
      eventBus: {
        emit: vi.fn(),
        subscribe: vi.fn((_filter: unknown, handler: (event: { data: unknown }) => void) => {
          eventHandler = handler
          return () => {}
        }),
        getRecent: vi.fn(() => []),
      },
      persistConfig: vi.fn(async () => {}),
      fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
      devices: {
        create: vi.fn(async () => null),
        allocateDeviceId: vi.fn(async () => 1),
        createContext: vi.fn(() => null),
        register: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        decommission: vi.fn(async () => {}),
        getAll: vi.fn(async () => []),
        getChildren: vi.fn(async () => []),
      },
      bindRuntimeState: (rs: IDeviceRuntimeState) => {
        runtimeStateRef = rs
      },
      registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
        if (cap.runtimeState && runtimeStateRef) {
          runtimeStateRef.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      }),
      api: {
        broker: {
          publish: { mutate: vi.fn() },
          subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-1' })) },
          unsubscribe: { mutate: vi.fn(async () => {}) },
        },
        deviceManager: stubDeviceManager(setMetadataMutate),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
        withTags: vi.fn(),
      },
    } as unknown as import('@camstack/types').DeviceContext

    const device = new HaNumericSensorDevice(ctx)

    // Simulate a state push via the event bus (mimics HA broker message)
    expect(eventHandler).not.toBeNull()
    const statePayload = {
      state: '-85',
      last_updated: new Date().toISOString(),
      attributes: {
        unit_of_measurement: 'dBm',
        suggested_display_precision: 0,
        friendly_name: 'Signal Strength',
      },
    }
    eventHandler!({
      data: {
        brokerId: 'b1',
        key: 'sensor.signal',
        payload: statePayload,
      },
    })

    // The numeric-sensor slice should now carry unit + precision
    const slice = device.runtimeState.getCapState<Record<string, unknown>>('numeric-sensor')
    expect(slice?.['value']).toBe(-85)
    expect(slice?.['unit']).toBe('dBm')
    expect(slice?.['precision']).toBe(0)
  })
})

/** Build a DeviceContext stub and instantiate HaControlDevice. */
function instantiateControlDevice(config: Record<string, unknown>): HaControlDevice {
  let runtimeStateRef: IDeviceRuntimeState | null = null

  const ctx = {
    id: 9,
    stableId: 'ha:test:9',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Control,
      name: 'Test Control',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 1),
      createContext: vi.fn(() => null),
      register: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      decommission: vi.fn(async () => {}),
      getAll: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
    },
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      broker: {
        publish: { mutate: vi.fn() },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-ctrl-1' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
      },
      deviceManager: stubDeviceManager(),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as import('@camstack/types').DeviceContext

  return new HaControlDevice(ctx)
}

describe('HaNumericSensorDevice handleStatePush — typed sensor precision', () => {
  it('populates precision in the temperature-sensor slice when suggested_display_precision is present', () => {
    let runtimeStateRef: IDeviceRuntimeState | null = null
    let eventHandler: ((event: { data: unknown }) => void) | null = null
    const setMetadataMutate = vi.fn(async () => {})

    const ctx = {
      id: 43,
      stableId: 'ha:test:43',
      parentDeviceId: null,
      deviceMeta: {
        type: DeviceType.Sensor,
        name: 'Temp Sensor',
        location: null,
        disabled: false,
        addonId: 'homeassistant',
        metadata: {},
      },
      persistedConfig: {
        brokerId: 'b1',
        entityId: 'sensor.temperature',
        capabilities: ['temperature-sensor'],
      },
      initialRuntimeState: {},
      eventBus: {
        emit: vi.fn(),
        subscribe: vi.fn((_filter: unknown, handler: (event: { data: unknown }) => void) => {
          eventHandler = handler
          return () => {}
        }),
        getRecent: vi.fn(() => []),
      },
      persistConfig: vi.fn(async () => {}),
      fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
      devices: {
        create: vi.fn(async () => null),
        allocateDeviceId: vi.fn(async () => 1),
        createContext: vi.fn(() => null),
        register: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        decommission: vi.fn(async () => {}),
        getAll: vi.fn(async () => []),
        getChildren: vi.fn(async () => []),
      },
      bindRuntimeState: (rs: IDeviceRuntimeState) => {
        runtimeStateRef = rs
      },
      registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
        if (cap.runtimeState && runtimeStateRef) {
          runtimeStateRef.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      }),
      api: {
        broker: {
          publish: { mutate: vi.fn() },
          subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-temp-1' })) },
          unsubscribe: { mutate: vi.fn(async () => {}) },
        },
        deviceManager: stubDeviceManager(setMetadataMutate),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
        withTags: vi.fn(),
      },
    } as unknown as import('@camstack/types').DeviceContext

    const device = new HaNumericSensorDevice(ctx)

    expect(eventHandler).not.toBeNull()
    const statePayload = {
      state: '24.567',
      last_updated: new Date().toISOString(),
      attributes: {
        unit_of_measurement: '°C',
        suggested_display_precision: 1,
        friendly_name: 'Living Room Temperature',
      },
    }
    eventHandler!({
      data: {
        brokerId: 'b1',
        key: 'sensor.temperature',
        payload: statePayload,
      },
    })

    const slice = device.runtimeState.getCapState<TemperatureSensorStatus>('temperature-sensor')
    expect(slice?.celsius).toBeCloseTo(24.567)
    expect(slice?.precision).toBe(1)
  })

  it('leaves precision absent in the temperature-sensor slice when suggested_display_precision is not in attributes', () => {
    let runtimeStateRef: IDeviceRuntimeState | null = null
    let eventHandler: ((event: { data: unknown }) => void) | null = null

    const ctx = {
      id: 44,
      stableId: 'ha:test:44',
      parentDeviceId: null,
      deviceMeta: {
        type: DeviceType.Sensor,
        name: 'Temp Sensor 2',
        location: null,
        disabled: false,
        addonId: 'homeassistant',
        metadata: {},
      },
      persistedConfig: {
        brokerId: 'b1',
        entityId: 'sensor.temperature2',
        capabilities: ['temperature-sensor'],
      },
      initialRuntimeState: {},
      eventBus: {
        emit: vi.fn(),
        subscribe: vi.fn((_filter: unknown, handler: (event: { data: unknown }) => void) => {
          eventHandler = handler
          return () => {}
        }),
        getRecent: vi.fn(() => []),
      },
      persistConfig: vi.fn(async () => {}),
      fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
      devices: {
        create: vi.fn(async () => null),
        allocateDeviceId: vi.fn(async () => 1),
        createContext: vi.fn(() => null),
        register: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        decommission: vi.fn(async () => {}),
        getAll: vi.fn(async () => []),
        getChildren: vi.fn(async () => []),
      },
      bindRuntimeState: (rs: IDeviceRuntimeState) => {
        runtimeStateRef = rs
      },
      registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
        if (cap.runtimeState && runtimeStateRef) {
          runtimeStateRef.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      }),
      api: {
        broker: {
          publish: { mutate: vi.fn() },
          subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-temp-2' })) },
          unsubscribe: { mutate: vi.fn(async () => {}) },
        },
        deviceManager: stubDeviceManager(),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
        withTags: vi.fn(),
      },
    } as unknown as import('@camstack/types').DeviceContext

    const device = new HaNumericSensorDevice(ctx)

    expect(eventHandler).not.toBeNull()
    eventHandler!({
      data: {
        brokerId: 'b1',
        key: 'sensor.temperature2',
        payload: {
          state: '22.0',
          last_updated: new Date().toISOString(),
          attributes: { friendly_name: 'Outside Temp' },
        },
      },
    })

    const slice = device.runtimeState.getCapState<TemperatureSensorStatus>('temperature-sensor')
    expect(slice?.celsius).toBeCloseTo(22.0)
    expect(slice?.precision).toBeUndefined()
  })
})

describe('precisionFromStep', () => {
  it('returns 1 for step=0.5', () => {
    expect(precisionFromStep(0.5)).toBe(1)
  })

  it('returns 1 for step=0.1', () => {
    expect(precisionFromStep(0.1)).toBe(1)
  })

  it('returns 2 for step=0.01', () => {
    expect(precisionFromStep(0.01)).toBe(2)
  })

  it('returns 0 for step=1 (integer step)', () => {
    expect(precisionFromStep(1)).toBe(0)
  })

  it('returns 0 for step=5 (integer step)', () => {
    expect(precisionFromStep(5)).toBe(0)
  })

  it('returns undefined for step=undefined', () => {
    expect(precisionFromStep(undefined)).toBeUndefined()
  })

  it('returns undefined for step=0 (invalid)', () => {
    expect(precisionFromStep(0)).toBeUndefined()
  })
})

describe('HaControlDevice — numeric slice precision', () => {
  it('populates precision from suggested_display_precision on state push', () => {
    let runtimeStateRef: IDeviceRuntimeState | null = null
    let eventHandler: ((event: { data: unknown }) => void) | null = null

    const ctx = {
      id: 10,
      stableId: 'ha:test:10',
      parentDeviceId: null,
      deviceMeta: {
        type: DeviceType.Control,
        name: 'Temp Control',
        location: null,
        disabled: false,
        addonId: 'homeassistant',
        metadata: {},
      },
      persistedConfig: {
        brokerId: 'b1',
        entityId: 'number.setpoint',
        capabilities: ['control'],
        role: 'numeric-control',
      },
      initialRuntimeState: {},
      eventBus: {
        emit: vi.fn(),
        subscribe: vi.fn((_filter: unknown, handler: (event: { data: unknown }) => void) => {
          eventHandler = handler
          return () => {}
        }),
        getRecent: vi.fn(() => []),
      },
      persistConfig: vi.fn(async () => {}),
      fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
      devices: {
        create: vi.fn(async () => null),
        allocateDeviceId: vi.fn(async () => 1),
        createContext: vi.fn(() => null),
        register: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        decommission: vi.fn(async () => {}),
        getAll: vi.fn(async () => []),
        getChildren: vi.fn(async () => []),
      },
      bindRuntimeState: (rs: IDeviceRuntimeState) => {
        runtimeStateRef = rs
      },
      registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
        if (cap.runtimeState && runtimeStateRef) {
          runtimeStateRef.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      }),
      api: {
        broker: {
          publish: { mutate: vi.fn() },
          subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-ctrl-prec-1' })) },
          unsubscribe: { mutate: vi.fn(async () => {}) },
        },
        deviceManager: stubDeviceManager(),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
        withTags: vi.fn(),
      },
    } as unknown as import('@camstack/types').DeviceContext

    const device = new HaControlDevice(ctx)

    expect(eventHandler).not.toBeNull()
    eventHandler!({
      data: {
        brokerId: 'b1',
        key: 'number.setpoint',
        payload: {
          state: '24.567',
          last_changed: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          attributes: {
            unit_of_measurement: '°C',
            min: 10,
            max: 30,
            step: 0.5,
            suggested_display_precision: 1,
          },
        },
      },
    })

    const slice = device.runtimeState.getCapState<ControlStatus>('control')
    expect(slice?.kind).toBe('numeric')
    expect(slice?.precision).toBe(1)
  })

  it('derives precision from step when suggested_display_precision is absent', () => {
    let runtimeStateRef: IDeviceRuntimeState | null = null
    let eventHandler: ((event: { data: unknown }) => void) | null = null

    const ctx = {
      id: 11,
      stableId: 'ha:test:11',
      parentDeviceId: null,
      deviceMeta: {
        type: DeviceType.Control,
        name: 'Brightness',
        location: null,
        disabled: false,
        addonId: 'homeassistant',
        metadata: {},
      },
      persistedConfig: {
        brokerId: 'b1',
        entityId: 'input_number.brightness',
        capabilities: ['control'],
        role: 'numeric-control',
      },
      initialRuntimeState: {},
      eventBus: {
        emit: vi.fn(),
        subscribe: vi.fn((_filter: unknown, handler: (event: { data: unknown }) => void) => {
          eventHandler = handler
          return () => {}
        }),
        getRecent: vi.fn(() => []),
      },
      persistConfig: vi.fn(async () => {}),
      fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
      devices: {
        create: vi.fn(async () => null),
        allocateDeviceId: vi.fn(async () => 1),
        createContext: vi.fn(() => null),
        register: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        decommission: vi.fn(async () => {}),
        getAll: vi.fn(async () => []),
        getChildren: vi.fn(async () => []),
      },
      bindRuntimeState: (rs: IDeviceRuntimeState) => {
        runtimeStateRef = rs
      },
      registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
        if (cap.runtimeState && runtimeStateRef) {
          runtimeStateRef.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      }),
      api: {
        broker: {
          publish: { mutate: vi.fn() },
          subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-ctrl-prec-2' })) },
          unsubscribe: { mutate: vi.fn(async () => {}) },
        },
        deviceManager: stubDeviceManager(),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
        withTags: vi.fn(),
      },
    } as unknown as import('@camstack/types').DeviceContext

    const device = new HaControlDevice(ctx)

    expect(eventHandler).not.toBeNull()
    eventHandler!({
      data: {
        brokerId: 'b1',
        key: 'input_number.brightness',
        payload: {
          state: '50',
          last_changed: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          attributes: {
            min: 0,
            max: 100,
            step: 0.5,
          },
        },
      },
    })

    const slice = device.runtimeState.getCapState<ControlStatus>('control')
    expect(slice?.kind).toBe('numeric')
    // step=0.5 → derived precision=1
    expect(slice?.precision).toBe(1)
  })
})

describe('HaControlDevice — options seeding from persisted config', () => {
  it('seeds the control slice with options from persisted config before any state-push', async () => {
    const dev = instantiateControlDevice({
      brokerId: 'b1',
      entityId: 'select.hvac_mode',
      capabilities: ['control'],
      role: 'select-control',
      options: ['Eco', 'Comfort'],
    })
    const slice = dev.runtimeState.getCapState<ControlStatus>('control')
    expect(slice).toBeDefined()
    expect(slice?.options).toEqual(['Eco', 'Comfort'])
    expect(slice?.kind).toBe('select')
  })

  it('seeds an empty options array when no options in persisted config', () => {
    const dev = instantiateControlDevice({
      brokerId: 'b1',
      entityId: 'input_number.brightness',
      capabilities: ['control'],
      role: 'numeric-control',
    })
    const slice = dev.runtimeState.getCapState<ControlStatus>('control')
    expect(slice?.options).toEqual([])
    expect(slice?.kind).toBe('numeric')
  })

  it('seeds an empty options array when options in persisted config is an empty array', () => {
    const dev = instantiateControlDevice({
      brokerId: 'b1',
      entityId: 'input_text.name',
      capabilities: ['control'],
      role: 'text-control',
      options: [],
    })
    const slice = dev.runtimeState.getCapState<ControlStatus>('control')
    expect(slice?.options).toEqual([])
    expect(slice?.kind).toBe('text')
  })
})

/** Build a HaLockDevice with the broker.message handler captured so a test can
 *  drive HA state pushes and inspect the lock-control slice + device.online. */
function makeLockWithHandler(config: Record<string, unknown>): {
  device: HaLockDevice
  push: (state: Record<string, unknown>) => void
} {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  let eventHandler: ((event: { data: unknown }) => void) | null = null

  const ctx = {
    id: 70,
    stableId: 'ha:test:70',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Lock,
      name: 'Front Door',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn((_filter: unknown, handler: (event: { data: unknown }) => void) => {
        eventHandler = handler
        return () => {}
      }),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 1),
      createContext: vi.fn(() => null),
      register: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      decommission: vi.fn(async () => {}),
      getAll: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
    },
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      broker: {
        publish: { mutate: vi.fn() },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-lock-1' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
      },
      deviceManager: stubDeviceManager(),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as import('@camstack/types').DeviceContext

  const device = new HaLockDevice(ctx)
  return {
    device,
    push: (state) => {
      if (!eventHandler) throw new Error('no event handler attached')
      eventHandler({
        data: { brokerId: config['brokerId'], key: config['entityId'], payload: state },
      })
    },
  }
}

describe('HaBaseChildDevice availability → device.online (A1)', () => {
  const CONFIG = { brokerId: 'ha_001', entityId: 'lock.front_door', capabilities: ['lock-control'] }

  it('marks online=false on an `unavailable` push while preserving the last-known value slice', () => {
    const { device, push } = makeLockWithHandler(CONFIG)

    // A real push first: device comes online and the value slice updates.
    push({
      state: 'locked',
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      attributes: {},
    })
    expect(device.online).toBe(true)
    expect(device.runtimeState.getCapState<LockControlStatus>('lock-control')?.state).toBe('locked')

    // Then an `unavailable` push: online flips false, but the VALUE slice is
    // preserved (subclass early-return keeps the last-known lock state).
    push({
      state: 'unavailable',
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      attributes: {},
    })
    expect(device.online).toBe(false)
    expect(device.runtimeState.getCapState<LockControlStatus>('lock-control')?.state).toBe('locked')
  })

  it('restores online=true on a subsequent real state push', () => {
    const { device, push } = makeLockWithHandler(CONFIG)

    push({
      state: 'unavailable',
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      attributes: {},
    })
    expect(device.online).toBe(false)

    push({
      state: 'unlocked',
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      attributes: {},
    })
    expect(device.online).toBe(true)
    expect(device.runtimeState.getCapState<LockControlStatus>('lock-control')?.state).toBe(
      'unlocked',
    )
  })

  it('treats `unknown` as unreachable too', () => {
    const { device, push } = makeLockWithHandler(CONFIG)
    push({
      state: 'locked',
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      attributes: {},
    })
    expect(device.online).toBe(true)
    push({
      state: 'unknown',
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      attributes: {},
    })
    expect(device.online).toBe(false)
  })
})
