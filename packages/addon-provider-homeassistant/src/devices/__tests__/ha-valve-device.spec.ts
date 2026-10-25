import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaValveDevice } from '../ha-valve-device.js'
import type { HaEntityState } from '../../ha-types.js'

function buildValveCtx(
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
    stableId: `ha:valve:99`,
    parentDeviceId: null,
    deviceMeta: {
      id: 99,
      stableId: `ha:valve:99`,
      type: DeviceType.Valve,
      name: 'Test Valve',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      capabilities: ['valve'],
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
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-valve-test' })) },
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

function getValveProvider(ctx: import('@camstack/types').DeviceContext): {
  open: (i: { deviceId: number }) => Promise<void>
  close: (i: { deviceId: number }) => Promise<void>
  stop: (i: { deviceId: number }) => Promise<void>
  setPosition: (i: { deviceId: number; position: number }) => Promise<void>
} {
  const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
  const call = registerNativeCap.mock.calls.find(
    (c: ReadonlyArray<{ name: string }>) => c[0]?.name === 'valve',
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
    entity_id: 'valve.water_main',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

describe('HaValveDevice', () => {
  it('registers the "valve" cap on construction', () => {
    const { ctx } = buildValveCtx('valve.water_main')
    void new HaValveDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const names: string[] = registerNativeCap.mock.calls.map(
      (c: ReadonlyArray<{ name: string }>) => c[0]!.name,
    )
    expect(names).toContain('valve')
  })

  it.each([
    ['open', 'open_valve'],
    ['close', 'close_valve'],
    ['stop', 'stop_valve'],
  ] as const)('%s() calls broker.publish domain:valve service:%s', async (method, service) => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildValveCtx('valve.water_main', publishMutate)
    void new HaValveDevice(ctx)
    const provider = getValveProvider(ctx)

    await provider[method]({ deviceId: 99 })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({ domain: 'valve', service, entityId: 'valve.water_main' }),
      }),
    )
  })

  it('setPosition() calls set_valve_position with the position payload', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildValveCtx('valve.water_main', publishMutate)
    void new HaValveDevice(ctx)
    const provider = getValveProvider(ctx)

    await provider.setPosition({ deviceId: 99, position: 60 })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({
          domain: 'valve',
          service: 'set_valve_position',
          entityId: 'valve.water_main',
        }),
        payload: { position: 60 },
      }),
    )
  })

  it.each([
    ['open', 'open'],
    ['opening', 'opening'],
    ['closing', 'closing'],
    ['closed', 'closed'],
  ] as const)('state push maps HA %s → ValveState %s + position attr', (haState, expected) => {
    const { ctx, setCapStateCalls } = buildValveCtx('valve.water_main')
    const device = new HaValveDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState(haState, { current_position: 35 }),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed).toBeDefined()
    expect(pushed!['state']).toBe(expected)
    expect(pushed!['position']).toBe(35)
    expect(pushed!['lastChangedAt']).toBe(Date.parse('2026-06-06T10:00:00.000Z'))
  })

  it('leaves position null when current_position is absent', () => {
    const { ctx, setCapStateCalls } = buildValveCtx('valve.water_main')
    const device = new HaValveDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('open', {}),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['state']).toBe('open')
    expect(pushed!['position']).toBeNull()
  })

  it('skips unavailable / unknown pushes (preserves last-known slice)', () => {
    const { ctx, setCapStateCalls } = buildValveCtx('valve.water_main')
    const device = new HaValveDevice(ctx)
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
