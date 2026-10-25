import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaEnumSensorDevice } from '../ha-enum-sensor-device.js'
import type { HaEntityState } from '../../ha-types.js'

interface EnumSliceShape {
  value?: string
  format?: string
  lastFetchedAt?: number
}

function buildEnumSensorCtx(persistedExtra: Record<string, unknown>): {
  ctx: import('@camstack/types').DeviceContext
  setCapStateCalls: EnumSliceShape[]
} {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const setCapStateCalls: EnumSliceShape[] = []
  const slices = new Map<string, EnumSliceShape>()

  const rsMock: IDeviceRuntimeState = {
    installCapSchema: vi.fn(),
    setCapState: vi.fn((cap: string, val: EnumSliceShape) => {
      slices.set(cap, val)
      if (cap === 'enum-sensor') setCapStateCalls.push(val)
    }),
    getCapState: vi.fn((cap: string) => slices.get(cap)),
    getCapField: vi.fn(),
    patchCapState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeCap: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({})),
    flush: vi.fn(async () => {}),
  } as unknown as IDeviceRuntimeState

  const ctx = {
    id: 700,
    stableId: 'ha:enum:700',
    parentDeviceId: null,
    deviceMeta: {
      id: 700,
      stableId: 'ha:enum:700',
      type: DeviceType.Sensor,
      name: 'First Cleaning Date',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId: 'sensor.first_cleaning_date',
      capabilities: ['enum-sensor'],
      ...persistedExtra,
    },
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 700),
      createContext: vi.fn(() => null),
      register: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      decommission: vi.fn(async () => {}),
      getAll: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
    },
    bindRuntimeState: vi.fn((rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
      Object.assign(rs, rsMock)
    }),
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
        publish: { mutate: vi.fn(async () => null) },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-enum-test' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(() => null),
      addContext: vi.fn(),
      with: vi.fn(),
    },
  } as unknown as import('@camstack/types').DeviceContext

  return { ctx, setCapStateCalls }
}

function makeState(value: string): HaEntityState {
  return {
    state: value,
    attributes: {},
    last_changed: '2025-12-02T09:36:12+00:00',
    last_updated: '2025-12-02T09:36:12+00:00',
    entity_id: 'sensor.first_cleaning_date',
    context: { id: '', parent_id: null, user_id: null },
  } as unknown as HaEntityState
}

function pushState(device: HaEnumSensorDevice, value: string): void {
  ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
    makeState(value),
  )
}

describe('HaEnumSensorDevice — dateTimeFormat seeding', () => {
  it("seeds format 'datetime' into the slice (cold-start + on push)", () => {
    const { ctx, setCapStateCalls } = buildEnumSensorCtx({
      dateTimeFormat: 'datetime',
      role: 'datetime-sensor',
    })
    const device = new HaEnumSensorDevice(ctx)
    // Cold-start slice carries the format up-front.
    expect(setCapStateCalls[0]?.format).toBe('datetime')
    pushState(device, '2025-12-02T09:36:12+00:00')
    const last = setCapStateCalls[setCapStateCalls.length - 1]
    expect(last?.value).toBe('2025-12-02T09:36:12+00:00')
    expect(last?.format).toBe('datetime')
  })

  it("seeds format 'date' when config carries dateTimeFormat='date'", () => {
    const { ctx, setCapStateCalls } = buildEnumSensorCtx({
      dateTimeFormat: 'date',
      role: 'datetime-sensor',
    })
    const device = new HaEnumSensorDevice(ctx)
    pushState(device, '2025-12-02')
    const last = setCapStateCalls[setCapStateCalls.length - 1]
    expect(last?.value).toBe('2025-12-02')
    expect(last?.format).toBe('date')
  })

  it('omits format for a plain enum sensor (no dateTimeFormat in config)', () => {
    const { ctx, setCapStateCalls } = buildEnumSensorCtx({ role: 'enum-sensor' })
    const device = new HaEnumSensorDevice(ctx)
    pushState(device, 'sunny')
    const last = setCapStateCalls[setCapStateCalls.length - 1]
    expect(last?.value).toBe('sunny')
    expect(last?.format).toBeUndefined()
  })

  it('ignores an invalid dateTimeFormat value (omits format)', () => {
    const { ctx, setCapStateCalls } = buildEnumSensorCtx({
      dateTimeFormat: 'bogus',
      role: 'datetime-sensor',
    })
    const device = new HaEnumSensorDevice(ctx)
    pushState(device, '2025-12-02T09:36:12+00:00')
    const last = setCapStateCalls[setCapStateCalls.length - 1]
    expect(last?.format).toBeUndefined()
  })
})
