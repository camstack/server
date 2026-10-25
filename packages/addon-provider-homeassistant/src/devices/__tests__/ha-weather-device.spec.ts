import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaWeatherDevice } from '../ha-weather-device.js'
import type { HaEntityState } from '../../ha-types.js'

function buildWeatherCtx(entityId: string): {
  ctx: import('@camstack/types').DeviceContext
  setCapStateCalls: Array<Record<string, unknown>>
} {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const setCapStateCalls: Array<Record<string, unknown>> = []

  const rsMock: IDeviceRuntimeState = {
    installCapSchema: vi.fn(),
    setCapState: vi.fn((_cap: string, val: Record<string, unknown>) => {
      setCapStateCalls.push(val)
    }),
    getCapState: vi.fn(() => undefined),
    getCapField: vi.fn(),
    patchCapState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeCap: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({})),
    flush: vi.fn(async () => {}),
  } as unknown as IDeviceRuntimeState

  const ctx = {
    id: 99,
    stableId: `ha:weather:99`,
    parentDeviceId: null,
    deviceMeta: {
      id: 99,
      stableId: `ha:weather:99`,
      type: DeviceType.Weather,
      name: 'Test Weather',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      capabilities: ['weather'],
    },
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
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
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-weather-test' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
      addContext: vi.fn(),
      with: vi.fn(),
    },
  } as unknown as import('@camstack/types').DeviceContext

  return { ctx, setCapStateCalls }
}

function makeState(value: string, attributes: Record<string, unknown> = {}): HaEntityState {
  return {
    state: value,
    attributes,
    last_changed: '2026-06-06T10:00:00.000Z',
    last_updated: '2026-06-06T10:00:00.000Z',
    entity_id: 'weather.home',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

function pushState(device: HaWeatherDevice, state: HaEntityState): void {
  ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(state)
}

describe('HaWeatherDevice', () => {
  it('registers the "weather" cap on construction', () => {
    const { ctx } = buildWeatherCtx('weather.home')
    void new HaWeatherDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const names: string[] = registerNativeCap.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toContain('weather')
  })

  it('decodes condition + all numeric attributes from a state push', () => {
    const { ctx, setCapStateCalls } = buildWeatherCtx('weather.home')
    const device = new HaWeatherDevice(ctx)
    pushState(
      device,
      makeState('partlycloudy', {
        temperature: 21.4,
        temperature_unit: '°C',
        humidity: 63,
        pressure: 1013,
        pressure_unit: 'hPa',
        wind_speed: 12.5,
        wind_speed_unit: 'km/h',
        wind_bearing: 240,
      }),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]!
    expect(pushed['condition']).toBe('partlycloudy')
    expect(pushed['temperature']).toBe(21.4)
    expect(pushed['temperatureUnit']).toBe('°C')
    expect(pushed['humidity']).toBe(63)
    expect(pushed['pressure']).toBe(1013)
    expect(pushed['pressureUnit']).toBe('hPa')
    expect(pushed['windSpeed']).toBe(12.5)
    expect(pushed['windSpeedUnit']).toBe('km/h')
    expect(pushed['windBearing']).toBe(240)
    expect(pushed['lastFetchedAt']).toBe(Date.parse('2026-06-06T10:00:00.000Z'))
  })

  it('clamps out-of-range humidity but still lands the rest of the push', () => {
    const { ctx, setCapStateCalls } = buildWeatherCtx('weather.home')
    const device = new HaWeatherDevice(ctx)
    // An external provider reports 100.5 — out of the schema's [0,100]
    // contract. The device must clamp it to 100 so the WHOLE push (temp /
    // condition / …) still lands rather than being silently dropped.
    pushState(
      device,
      makeState('sunny', {
        temperature: 19,
        temperature_unit: '°C',
        humidity: 100.5,
      }),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]!
    expect(pushed['humidity']).toBe(100)
    expect(pushed['condition']).toBe('sunny')
    expect(pushed['temperature']).toBe(19)
  })

  it('leaves missing numeric attributes null but keeps the condition', () => {
    const { ctx, setCapStateCalls } = buildWeatherCtx('weather.home')
    const device = new HaWeatherDevice(ctx)
    pushState(device, makeState('sunny', {}))
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]!
    expect(pushed['condition']).toBe('sunny')
    expect(pushed['temperature']).toBeNull()
    expect(pushed['temperatureUnit']).toBeNull()
    expect(pushed['humidity']).toBeNull()
    expect(pushed['pressure']).toBeNull()
    expect(pushed['pressureUnit']).toBeNull()
    expect(pushed['windSpeed']).toBeNull()
    expect(pushed['windSpeedUnit']).toBeNull()
    expect(pushed['windBearing']).toBeNull()
  })

  it('skips unavailable / unknown pushes (preserves last-known slice)', () => {
    const { ctx, setCapStateCalls } = buildWeatherCtx('weather.home')
    const device = new HaWeatherDevice(ctx)
    const before = setCapStateCalls.length
    pushState(device, makeState('unavailable', {}))
    pushState(device, makeState('unknown', {}))
    expect(setCapStateCalls.length).toBe(before)
  })

  it('getStatus reads the runtime slice (read-only, no service methods)', async () => {
    const { ctx } = buildWeatherCtx('weather.home')
    void new HaWeatherDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const call = registerNativeCap.mock.calls.find(
      (c) => (c[0] as { name: string }).name === 'weather',
    )
    expect(call).toBeDefined()
    const provider = call![1] as Record<string, unknown>
    // Read-only: only getStatus is present — no open/close/set* methods.
    expect(typeof provider['getStatus']).toBe('function')
    expect(Object.keys(provider)).toEqual(['getStatus'])
  })
})
