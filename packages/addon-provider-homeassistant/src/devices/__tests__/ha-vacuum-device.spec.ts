import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaVacuumDevice } from '../ha-vacuum-device.js'
import type { HaEntityState } from '../../ha-types.js'

function buildVacuumCtx(
  entityId: string,
  publishMutate = vi.fn(async () => null),
): {
  ctx: import('@camstack/types').DeviceContext
  setCapStateCalls: Array<{ cap: string; val: Record<string, unknown> }>
} {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const setCapStateCalls: Array<{ cap: string; val: Record<string, unknown> }> = []

  const rsMock: IDeviceRuntimeState = {
    installCapSchema: vi.fn(),
    setCapState: vi.fn((cap: string, val: Record<string, unknown>) => {
      setCapStateCalls.push({ cap, val })
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
    stableId: `ha:vacuum:99`,
    parentDeviceId: null,
    deviceMeta: {
      id: 99,
      stableId: `ha:vacuum:99`,
      type: DeviceType.Vacuum,
      name: 'Test Vacuum',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      capabilities: ['vacuum-control'],
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
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-vacuum-test' })) },
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

function capSlice(
  calls: ReadonlyArray<{ cap: string; val: Record<string, unknown> }>,
  cap: string,
): Record<string, unknown> | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]!.cap === cap) return calls[i]!.val
  }
  return undefined
}

function getVacuumProvider(ctx: import('@camstack/types').DeviceContext): {
  start: (i: { deviceId: number }) => Promise<void>
  pause: (i: { deviceId: number }) => Promise<void>
  stop: (i: { deviceId: number }) => Promise<void>
  returnToBase: (i: { deviceId: number }) => Promise<void>
  locate: (i: { deviceId: number }) => Promise<void>
  setFanSpeed: (i: { deviceId: number; speed: string }) => Promise<void>
} {
  const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
  const call = registerNativeCap.mock.calls.find(
    (c: ReadonlyArray<{ name: string }>) => c[0]?.name === 'vacuum-control',
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
    entity_id: 'vacuum.roborock',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

describe('HaVacuumDevice', () => {
  it('registers the "vacuum-control" cap on construction', () => {
    const { ctx } = buildVacuumCtx('vacuum.roborock')
    void new HaVacuumDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const names: string[] = registerNativeCap.mock.calls.map(
      (c: ReadonlyArray<{ name: string }>) => c[0]!.name,
    )
    expect(names).toContain('vacuum-control')
  })

  it.each([
    ['start', 'start'],
    ['pause', 'pause'],
    ['stop', 'stop'],
    ['returnToBase', 'return_to_base'],
    ['locate', 'locate'],
  ] as const)('%s() calls broker.publish domain:vacuum service:%s', async (method, service) => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildVacuumCtx('vacuum.roborock', publishMutate)
    void new HaVacuumDevice(ctx)
    const provider = getVacuumProvider(ctx)

    await provider[method]({ deviceId: 99 })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({ domain: 'vacuum', service, entityId: 'vacuum.roborock' }),
      }),
    )
  })

  it('setFanSpeed() calls service set_fan_speed with { fan_speed }', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildVacuumCtx('vacuum.roborock', publishMutate)
    void new HaVacuumDevice(ctx)
    const provider = getVacuumProvider(ctx)

    await provider.setFanSpeed({ deviceId: 99, speed: 'turbo' })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({ domain: 'vacuum', service: 'set_fan_speed' }),
        payload: { fan_speed: 'turbo' },
      }),
    )
  })

  it('state push maps HA state + attributes into the cap slice', () => {
    const { ctx, setCapStateCalls } = buildVacuumCtx('vacuum.roborock')
    const device = new HaVacuumDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('cleaning', {
        battery_level: 77,
        fan_speed: 'turbo',
        fan_speed_list: ['quiet', 'standard', 'turbo'],
      }),
    )
    const pushed = capSlice(setCapStateCalls, 'vacuum-control')
    expect(pushed).toBeDefined()
    expect(pushed!['state']).toBe('cleaning')
    expect(pushed!['batteryLevel']).toBe(77)
    expect(pushed!['fanSpeed']).toBe('turbo')
    expect(pushed!['availableFanSpeeds']).toEqual(['quiet', 'standard', 'turbo'])
    expect(pushed!['lastChangedAt']).toBe(Date.parse('2026-06-06T10:00:00.000Z'))
  })

  it('maps unknown HA state to idle and missing attributes to null/[]', () => {
    const { ctx, setCapStateCalls } = buildVacuumCtx('vacuum.roborock')
    const device = new HaVacuumDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('on', {}),
    )
    const pushed = capSlice(setCapStateCalls, 'vacuum-control')
    expect(pushed!['state']).toBe('idle')
    expect(pushed!['batteryLevel']).toBeNull()
    expect(pushed!['fanSpeed']).toBeNull()
    expect(pushed!['availableFanSpeeds']).toEqual([])
  })

  it('publishes no tank field — tanks are consumables items now (D915)', () => {
    const { ctx, setCapStateCalls } = buildVacuumCtx('vacuum.roborock')
    const device = new HaVacuumDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('cleaning', { battery_level: 50, fan_speed: 'turbo' }),
    )
    const pushed = capSlice(setCapStateCalls, 'vacuum-control')
    for (const tank of ['cleanWater', 'dirtyWater', 'detergent', 'dustBin']) {
      expect(pushed).not.toHaveProperty(tank)
    }
  })

  it('seeds a cold-start slice in the idle state', () => {
    const { ctx, setCapStateCalls } = buildVacuumCtx('vacuum.roborock')
    void new HaVacuumDevice(ctx)
    const coldStart = capSlice(setCapStateCalls, 'vacuum-control')
    expect(coldStart).toBeDefined()
    expect(coldStart!['state']).toBe('idle')
    expect(coldStart).not.toHaveProperty('cleanWater')
    expect(capSlice(setCapStateCalls, 'running-state')?.['running']).toBeNull()
  })

  it('running slice is true when HA reports cleaning', () => {
    const { ctx, setCapStateCalls } = buildVacuumCtx('vacuum.roborock')
    const device = new HaVacuumDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('cleaning', {}),
    )
    expect(capSlice(setCapStateCalls, 'running-state')?.['running']).toBe(true)
  })

  it('skips unavailable / unknown pushes (preserves last-known slice)', () => {
    const { ctx, setCapStateCalls } = buildVacuumCtx('vacuum.roborock')
    const device = new HaVacuumDevice(ctx)
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
