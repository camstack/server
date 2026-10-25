import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaHumidifierDevice } from '../ha-humidifier-device.js'
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
    stableId: `ha:humidifier:99`,
    parentDeviceId: null,
    deviceMeta: {
      id: 99,
      stableId: `ha:humidifier:99`,
      type: DeviceType.Humidifier,
      name: 'Test Humidifier',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      capabilities: ['humidifier'],
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
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-humidifier-test' })) },
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
  setOn: (i: { deviceId: number; on: boolean }) => Promise<void>
  setTargetHumidity: (i: { deviceId: number; humidity: number }) => Promise<void>
  setMode: (i: { deviceId: number; mode: string }) => Promise<void>
} {
  const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
  const call = registerNativeCap.mock.calls.find(
    (c: ReadonlyArray<{ name: string }>) => c[0]?.name === 'humidifier',
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
    entity_id: 'humidifier.bedroom',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

describe('HaHumidifierDevice', () => {
  it('registers the "humidifier" cap on construction', () => {
    const { ctx } = buildCtx('humidifier.bedroom')
    void new HaHumidifierDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const names: string[] = registerNativeCap.mock.calls.map(
      (c: ReadonlyArray<{ name: string }>) => c[0]!.name,
    )
    expect(names).toContain('humidifier')
  })

  it.each([
    [true, 'turn_on'],
    [false, 'turn_off'],
  ] as const)('setOn(%s) calls humidifier.%s', async (on, service) => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildCtx('humidifier.bedroom', publishMutate)
    void new HaHumidifierDevice(ctx)
    const provider = getProvider(ctx)

    await provider.setOn({ deviceId: 99, on })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({
          domain: 'humidifier',
          service,
          entityId: 'humidifier.bedroom',
        }),
      }),
    )
  })

  it('setTargetHumidity() calls set_humidity with the humidity payload', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildCtx('humidifier.bedroom', publishMutate)
    void new HaHumidifierDevice(ctx)
    const provider = getProvider(ctx)

    await provider.setTargetHumidity({ deviceId: 99, humidity: 55 })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          domain: 'humidifier',
          service: 'set_humidity',
          entityId: 'humidifier.bedroom',
        }),
        payload: { humidity: 55 },
      }),
    )
  })

  it('setMode() calls set_mode with the mode payload', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildCtx('humidifier.bedroom', publishMutate)
    void new HaHumidifierDevice(ctx)
    const provider = getProvider(ctx)

    await provider.setMode({ deviceId: 99, mode: 'baby' })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          domain: 'humidifier',
          service: 'set_mode',
          entityId: 'humidifier.bedroom',
        }),
        payload: { mode: 'baby' },
      }),
    )
  })

  it('state push decodes on/off + current/target + mode + action + bounds', () => {
    const { ctx, setCapStateCalls } = buildCtx('humidifier.bedroom')
    const device = new HaHumidifierDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('on', {
        current_humidity: 40,
        humidity: 55,
        mode: 'auto',
        available_modes: ['auto', 'normal', 'baby'],
        action: 'humidifying',
        min_humidity: 30,
        max_humidity: 80,
      }),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed).toBeDefined()
    expect(pushed!['on']).toBe(true)
    expect(pushed!['currentHumidity']).toBe(40)
    expect(pushed!['targetHumidity']).toBe(55)
    expect(pushed!['mode']).toBe('auto')
    expect(pushed!['availableModes']).toEqual(['auto', 'normal', 'baby'])
    expect(pushed!['action']).toBe('humidifying')
    expect(pushed!['minHumidity']).toBe(30)
    expect(pushed!['maxHumidity']).toBe(80)
    expect(pushed!['lastChangedAt']).toBe(Date.parse('2026-06-06T10:00:00.000Z'))
  })

  it('leaves optional fields null when absent', () => {
    const { ctx, setCapStateCalls } = buildCtx('humidifier.bedroom')
    const device = new HaHumidifierDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('off', {}),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['on']).toBe(false)
    expect(pushed!['currentHumidity']).toBeNull()
    expect(pushed!['targetHumidity']).toBeNull()
    expect(pushed!['mode']).toBeNull()
    expect(pushed!['availableModes']).toEqual([])
    expect(pushed!['action']).toBeNull()
    expect(pushed!['minHumidity']).toBeNull()
    expect(pushed!['maxHumidity']).toBeNull()
  })

  it('skips unavailable / unknown pushes (preserves last-known slice)', () => {
    const { ctx, setCapStateCalls } = buildCtx('humidifier.bedroom')
    const device = new HaHumidifierDevice(ctx)
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
