import { DeviceFeature, DeviceRole, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { deriveBatteryStatus, HaContainerDevice } from '../devices/ha-container-device.js'
import type { HaEntityState } from '../ha-types.js'

interface ContainerHarness {
  device: HaContainerDevice
  names: string[]
  subscribeMutate: ReturnType<typeof vi.fn>
  /** Push a `broker.message` at the container exactly as the bus would. */
  push: (entityId: string, state: string) => void
  /** The container's current `battery` runtime-state slice, or null. */
  batterySlice: () => Record<string, unknown> | null
  /** The real provider `registerNativeCap` was handed for the named cap. */
  providerOf: (capName: string) => { getStatus: (input: unknown) => Promise<unknown> }
}

/**
 * Build a DeviceContext stub and instantiate HaContainerDevice, then run the
 * real activation lifecycle.
 *
 * The contract this asserts is the post-wiring one: the container registers the
 * `battery` cap NATIVELY when the physical device has a battery entity, and
 * derives the slice from the SAME `broker.message` push stream that drives
 * `online`. Before 2026-08-08 it registered nothing and instead auto-authored
 * four `DeviceLink`s for the kernel to overlay — a provider deriving its own
 * field through a mechanism any operator could also write.
 */
async function makeContainer(
  config: Record<string, unknown>,
  initialRuntimeState: Record<string, unknown> = {},
): Promise<ContainerHarness> {
  const names: string[] = []
  const providers = new Map<string, { getStatus: (input: unknown) => Promise<unknown> }>()
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const subscribeMutate = vi.fn(async () => ({ subscriptionId: 'sub-batt-1' }))
  const handlers: Array<(e: { data: unknown }) => void> = []

  const ctx = {
    id: 100,
    stableId: 'ha:test:100',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Container,
      name: 'Test Plug',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState,
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn((_f: unknown, h: (e: { data: unknown }) => void) => {
        handlers.push(h)
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
    registerNativeCap: vi.fn(
      (
        cap: { name: string; runtimeState?: unknown },
        provider: { getStatus: (input: unknown) => Promise<unknown> },
      ) => {
        names.push(cap.name)
        providers.set(cap.name, provider)
        if (cap.runtimeState && runtimeStateRef) {
          runtimeStateRef.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      },
    ),
    api: {
      broker: {
        publish: { mutate: vi.fn() },
        subscribe: { mutate: subscribeMutate },
        unsubscribe: { mutate: vi.fn(async () => {}) },
        getState: {
          query: vi.fn(async ({ key }: { key: string }) => ({
            entity_id: key,
            state: 'off',
            attributes: { device_class: 'battery', model: 'HmIP-DLD' },
            last_changed: new Date().toISOString(),
            last_updated: new Date().toISOString(),
          })),
        },
      },
      deviceManager: {
        setChildLayout: { mutate: vi.fn(async () => {}) },
        getDevice: { query: vi.fn(async () => ({ id: 100 })) },
      },
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

  const device = new HaContainerDevice(ctx)
  await device.onActivate()
  const push = (entityId: string, state: string): void => {
    for (const h of handlers) {
      h({ data: { brokerId: 'ha_001', key: entityId, payload: { state, attributes: {} } } })
    }
  }
  const batterySlice = (): Record<string, unknown> | null =>
    runtimeStateRef?.getCapState<Record<string, unknown>>('battery') ?? null
  const providerOf = (capName: string): { getStatus: (input: unknown) => Promise<unknown> } => {
    const provider = providers.get(capName)
    if (!provider) throw new Error(`no provider registered for cap "${capName}"`)
    return provider
  }
  return { device, names, subscribeMutate, push, batterySlice, providerOf }
}

const NUMERIC_BATTERY_ENTITY = {
  entityId: 'sensor.front_door_battery',
  deviceType: DeviceType.Sensor,
  capabilities: ['numeric-sensor'],
  role: DeviceRole.BatterySensor,
  deviceClass: 'battery',
}

const BINARY_BATTERY_ENTITY = {
  entityId: 'binary_sensor.lock_battery',
  deviceType: DeviceType.Sensor,
  capabilities: ['binary'],
  role: DeviceRole.BatterySensor,
  deviceClass: 'battery',
}

const st = (state: string): HaEntityState => ({ state, attributes: {} }) as HaEntityState

const BATTERY_CONFIG = {
  system: 'homeassistant',
  brokerId: 'ha_001',
  haDeviceId: 'ha-dev-1',
  entities: [
    {
      entityId: 'sensor.front_door_battery',
      deviceType: DeviceType.Sensor,
      capabilities: ['numeric-sensor'],
      role: DeviceRole.BatterySensor,
      deviceClass: 'battery',
    },
  ],
}

const NO_BATTERY_CONFIG = {
  system: 'homeassistant',
  brokerId: 'ha_001',
  haDeviceId: 'ha-dev-2',
  entities: [
    {
      entityId: 'sensor.front_door_temperature',
      deviceType: DeviceType.Sensor,
      capabilities: ['temperature-sensor'],
      role: DeviceRole.TemperatureSensor,
      deviceClass: 'temperature',
    },
  ],
}

describe('deriveBatteryStatus', () => {
  it('numeric battery → the reading, clamped to 0-100', () => {
    const s = deriveBatteryStatus(
      [NUMERIC_BATTERY_ENTITY],
      'sensor.front_door_battery',
      st('73'),
      1000,
    )
    expect(s).toEqual({ level: 73, charging: 'none', sleeping: false, lastUpdated: 1000 })
  })

  it('clamps an out-of-range firmware value instead of failing the status', () => {
    // The old `linear … clamp [0,100]` transform bought exactly this, and the
    // reason is on the record: an out-of-range value must never take the whole
    // status down.
    expect(
      deriveBatteryStatus([NUMERIC_BATTERY_ENTITY], 'sensor.front_door_battery', st('137'), 0)
        ?.level,
    ).toBe(100)
    expect(
      deriveBatteryStatus([NUMERIC_BATTERY_ENTITY], 'sensor.front_door_battery', st('-4'), 0)
        ?.level,
    ).toBe(0)
  })

  it('binary LOW_BAT → below the warning band but never 0, and flagged binary', () => {
    const low = deriveBatteryStatus(
      [BINARY_BATTERY_ENTITY],
      'binary_sensor.lock_battery',
      st('on'),
      0,
    )
    expect(low?.binary).toBe(true)
    expect(low?.level).toBeLessThan(20)
    expect(low?.level).toBeGreaterThan(0)
    const normal = deriveBatteryStatus(
      [BINARY_BATTERY_ENTITY],
      'binary_sensor.lock_battery',
      st('off'),
      0,
    )
    expect(normal?.level).toBe(100)
    expect(normal?.binary).toBe(true)
  })

  it('prefers a numeric battery sensor over a binary LOW_BAT when both exist', () => {
    const entities = [BINARY_BATTERY_ENTITY, NUMERIC_BATTERY_ENTITY]
    expect(deriveBatteryStatus(entities, 'binary_sensor.lock_battery', st('on'), 0)).toBeNull()
    expect(deriveBatteryStatus(entities, 'sensor.front_door_battery', st('50'), 0)?.level).toBe(50)
  })

  it('an unparseable state yields nothing rather than a fabricated 0 %', () => {
    expect(
      deriveBatteryStatus([NUMERIC_BATTERY_ENTITY], 'sensor.front_door_battery', st('unknown'), 0),
    ).toBeNull()
  })

  it('no battery entity → no status', () => {
    expect(deriveBatteryStatus([], 'sensor.x', st('50'), 0)).toBeNull()
  })
})

describe('HaContainerDevice battery (native, derived in-provider)', () => {
  it('registers the battery cap NATIVELY when a battery entity is present', async () => {
    const { names } = await makeContainer(BATTERY_CONFIG)
    expect(names).toContain('battery')
  })

  it('registers NO battery cap when the device has none', async () => {
    const { names } = await makeContainer(NO_BATTERY_CONFIG)
    expect(names).not.toContain('battery')
  })

  it('derives the slice from the availability push stream it already subscribes', async () => {
    const h = await makeContainer(BATTERY_CONFIG)
    h.push('sensor.front_door_battery', '61')
    expect(h.batterySlice()).toMatchObject({ level: 61, charging: 'none' })
  })

  it('ignores a push from any entity that is not the battery source', async () => {
    const h = await makeContainer(BATTERY_CONFIG)
    h.push('sensor.front_door_battery', '61')
    h.push('sensor.something_else', '5')
    expect(h.batterySlice()).toMatchObject({ level: 61 })
  })

  it('advertises BatteryOperated when a battery entity is present', async () => {
    const { device } = await makeContainer(BATTERY_CONFIG)
    expect(device.features).toContain(DeviceFeature.BatteryOperated)
    expect(device.features).toContain(DeviceFeature.Resyncable)
  })

  it('detects a battery entity via device_class even without the role', async () => {
    const { names } = await makeContainer({
      ...BATTERY_CONFIG,
      entities: [
        {
          entityId: 'sensor.batt',
          deviceType: DeviceType.Sensor,
          capabilities: ['numeric-sensor'],
          deviceClass: 'battery',
        },
      ],
    })
    expect(names).toContain('battery')
  })

  it('does NOT advertise BatteryOperated without a battery entity', async () => {
    const { device } = await makeContainer(NO_BATTERY_CONFIG)
    expect(device.features).not.toContain(DeviceFeature.BatteryOperated)
    expect(device.features).toEqual([DeviceFeature.Resyncable])
  })

  it('subscribes only the all-entities availability feed — no dedicated battery subscription', async () => {
    const { subscribeMutate } = await makeContainer(BATTERY_CONFIG)
    expect(subscribeMutate).toHaveBeenCalledTimes(1)
    expect(subscribeMutate).toHaveBeenCalledWith({
      brokerId: 'ha_001',
      filter: { entityIds: ['sensor.front_door_battery'] },
    })
  })

  // Binary LOW_BAT battery (e.g. HomeMatic HmIP-DLD): a binary_sensor with
  // device_class=battery — no real %, only on=low / off=normal.
  const BINARY_BATTERY_CONFIG = {
    system: 'homeassistant',
    brokerId: 'ha_001',
    haDeviceId: 'ha-dev-3',
    entities: [BINARY_BATTERY_ENTITY],
  }

  it('getRawState aggregates entity raw states + haDeviceId for the device', async () => {
    const { device } = await makeContainer(BINARY_BATTERY_CONFIG)
    const raw = await device.getRawState()
    expect(raw?.source).toBe('homeassistant')
    const data = raw?.data as {
      haDeviceId?: string
      entities?: Record<string, { state: string; attributes: Record<string, unknown> }>
    }
    expect(data.haDeviceId).toBe('ha-dev-3')
    expect(data.entities?.['binary_sensor.lock_battery']?.state).toBe('off')
    expect(data.entities?.['binary_sensor.lock_battery']?.attributes).toMatchObject({
      model: 'HmIP-DLD',
    })
  })

  it('before any reading, the battery is UNKNOWN (null / unknown), never 0 % on battery (D393, D315)', async () => {
    const h = await makeContainer(BATTERY_CONFIG)
    expect(h.batterySlice()).toEqual({
      level: null,
      charging: 'unknown',
      sleeping: false,
      lastUpdated: 0,
    })
    const status = await h.providerOf('battery').getStatus({ deviceId: 100 })
    expect(status).toEqual({
      level: null,
      charging: 'unknown',
      sleeping: false,
      lastUpdated: 0,
    })
  })

  it('a RESTORED battery slice survives the boot — the cold seed is written only when no slice exists (D49)', async () => {
    const restored = {
      level: 40,
      charging: 'none',
      sleeping: false,
      lastUpdated: 1_700_000_000_000,
    }
    const h = await makeContainer(BATTERY_CONFIG, { battery: restored })
    expect(h.batterySlice()).toEqual(restored)
  })

  it('replaces a persisted LEGACY cold seed ({level: 0, lastUpdated: 0}) with the new unknown seed (D663)', async () => {
    const legacy = { level: 0, charging: 'none', sleeping: false, lastUpdated: 0 }
    const h = await makeContainer(BATTERY_CONFIG, { battery: legacy })
    expect(h.batterySlice()).toEqual({
      level: null,
      charging: 'unknown',
      sleeping: false,
      lastUpdated: 0,
    })
  })

  it('keeps a REAL stored 0 % reading (a genuine lastUpdated) — lastUpdated is the only signature of "never observed"', async () => {
    const real = {
      level: 0,
      charging: 'none',
      sleeping: false,
      lastUpdated: 1_700_000_000_000,
    }
    const h = await makeContainer(BATTERY_CONFIG, { battery: real })
    expect(h.batterySlice()).toEqual(real)
  })
})
