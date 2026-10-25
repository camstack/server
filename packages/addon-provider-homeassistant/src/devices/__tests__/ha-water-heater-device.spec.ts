import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaWaterHeaterDevice } from '../ha-water-heater-device.js'
import type { HaEntityState } from '../../ha-types.js'

function buildCtx(
  entityId: string,
  publishMutate = vi.fn(async () => null),
): {
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
    stableId: `ha:water_heater:99`,
    parentDeviceId: null,
    deviceMeta: {
      id: 99,
      stableId: `ha:water_heater:99`,
      type: DeviceType.WaterHeater,
      name: 'Test Water Heater',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      capabilities: ['water-heater'],
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
      allocateDeviceId: vi.fn(async () => 99),
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
        publish: { mutate: publishMutate },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-water-heater-test' })) },
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

function getProvider(ctx: import('@camstack/types').DeviceContext): {
  setTargetTemp: (i: { deviceId: number; temp: number }) => Promise<void>
  setOperationMode: (i: { deviceId: number; mode: string }) => Promise<void>
  setAway: (i: { deviceId: number; on: boolean }) => Promise<void>
} {
  const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
  const call = registerNativeCap.mock.calls.find(
    (c: ReadonlyArray<{ name: string }>) => c[0]?.name === 'water-heater',
  )
  expect(call).toBeDefined()
  return call![1]
}

function makeState(value: string, attributes: Record<string, unknown> = {}): HaEntityState {
  return {
    state: value,
    attributes,
    last_changed: '2026-06-06T10:00:00.000Z',
    last_updated: '2026-06-06T10:00:00.000Z',
    entity_id: 'water_heater.boiler',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

describe('HaWaterHeaterDevice', () => {
  it('registers the "water-heater" cap on construction', () => {
    const { ctx } = buildCtx('water_heater.boiler')
    void new HaWaterHeaterDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const names: string[] = registerNativeCap.mock.calls.map(
      (c: ReadonlyArray<{ name: string }>) => c[0]!.name,
    )
    expect(names).toContain('water-heater')
  })

  it('setTargetTemp() calls set_temperature with the temperature payload', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildCtx('water_heater.boiler', publishMutate)
    void new HaWaterHeaterDevice(ctx)
    const provider = getProvider(ctx)

    await provider.setTargetTemp({ deviceId: 99, temp: 60 })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          domain: 'water_heater',
          service: 'set_temperature',
          entityId: 'water_heater.boiler',
        }),
        payload: { temperature: 60 },
      }),
    )
  })

  it('setOperationMode() calls set_operation_mode with the operation_mode payload', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildCtx('water_heater.boiler', publishMutate)
    void new HaWaterHeaterDevice(ctx)
    const provider = getProvider(ctx)

    await provider.setOperationMode({ deviceId: 99, mode: 'eco' })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          domain: 'water_heater',
          service: 'set_operation_mode',
          entityId: 'water_heater.boiler',
        }),
        payload: { operation_mode: 'eco' },
      }),
    )
  })

  it.each([
    [true],
    [false],
  ] as const)('setAway(%s) calls set_away_mode with the boolean away_mode', async (on) => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildCtx('water_heater.boiler', publishMutate)
    void new HaWaterHeaterDevice(ctx)
    const provider = getProvider(ctx)

    await provider.setAway({ deviceId: 99, on })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          domain: 'water_heater',
          service: 'set_away_mode',
          entityId: 'water_heater.boiler',
        }),
        payload: { away_mode: on },
      }),
    )
  })

  it('state push decodes operation mode + current/target + away + bounds', () => {
    const { ctx, setCapStateCalls } = buildCtx('water_heater.boiler')
    const device = new HaWaterHeaterDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('eco', {
        current_temperature: 48,
        temperature: 60,
        operation_list: ['eco', 'electric', 'gas', 'heat_pump'],
        away_mode: 'on',
        min_temp: 30,
        max_temp: 80,
      }),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed).toBeDefined()
    expect(pushed!['operationMode']).toBe('eco')
    expect(pushed!['currentTemp']).toBe(48)
    expect(pushed!['targetTemp']).toBe(60)
    expect(pushed!['availableModes']).toEqual(['eco', 'electric', 'gas', 'heat_pump'])
    expect(pushed!['away']).toBe(true)
    expect(pushed!['minTemp']).toBe(30)
    expect(pushed!['maxTemp']).toBe(80)
    expect(pushed!['lastChangedAt']).toBe(Date.parse('2026-06-06T10:00:00.000Z'))
  })

  it('maps away_mode "off" → false and absent → null', () => {
    const { ctx, setCapStateCalls } = buildCtx('water_heater.boiler')
    const device = new HaWaterHeaterDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('electric', { away_mode: 'off' }),
    )
    expect(setCapStateCalls[setCapStateCalls.length - 1]!['away']).toBe(false)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('electric', {}),
    )
    expect(setCapStateCalls[setCapStateCalls.length - 1]!['away']).toBeNull()
  })

  it('skips unavailable / unknown pushes (preserves last-known slice)', () => {
    const { ctx, setCapStateCalls } = buildCtx('water_heater.boiler')
    const device = new HaWaterHeaterDevice(ctx)
    const before = setCapStateCalls.length
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('unavailable', {}),
    )
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('unknown', {}),
    )
    expect(setCapStateCalls.length).toBe(before)
  })
})
