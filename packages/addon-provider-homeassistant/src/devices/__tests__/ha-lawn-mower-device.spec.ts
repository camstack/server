import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaLawnMowerDevice } from '../ha-lawn-mower-device.js'
import type { HaEntityState } from '../../ha-types.js'

function buildMowerCtx(
  entityId: string,
  publishMutate = vi.fn(async () => null),
): {
  ctx: import('@camstack/types').DeviceContext
  setCapStateCalls: Array<Record<string, unknown>>
} {
  // Only the lawn-mower slice: the device also pushes `running-state` (D933).
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const setCapStateCalls: Array<Record<string, unknown>> = []

  const rsMock: IDeviceRuntimeState = {
    installCapSchema: vi.fn(),
    setCapState: vi.fn((cap: string, val: Record<string, unknown>) => {
      if (cap === 'lawn-mower-control') setCapStateCalls.push(val)
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
    stableId: `ha:lawn_mower:99`,
    parentDeviceId: null,
    deviceMeta: {
      id: 99,
      stableId: `ha:lawn_mower:99`,
      type: DeviceType.LawnMower,
      name: 'Test Mower',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      capabilities: ['lawn-mower-control'],
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
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-mower-test' })) },
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

function getMowerProvider(ctx: import('@camstack/types').DeviceContext): {
  startMowing: (i: { deviceId: number }) => Promise<void>
  pause: (i: { deviceId: number }) => Promise<void>
  dock: (i: { deviceId: number }) => Promise<void>
} {
  const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
  const call = registerNativeCap.mock.calls.find(
    (c: ReadonlyArray<{ name: string }>) => c[0]?.name === 'lawn-mower-control',
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
    entity_id: 'lawn_mower.garden',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

describe('HaLawnMowerDevice', () => {
  it('registers the "lawn-mower-control" cap on construction', () => {
    const { ctx } = buildMowerCtx('lawn_mower.garden')
    void new HaLawnMowerDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const names: string[] = registerNativeCap.mock.calls.map(
      (c: ReadonlyArray<{ name: string }>) => c[0]!.name,
    )
    expect(names).toContain('lawn-mower-control')
  })

  it.each([
    ['startMowing', 'start_mowing'],
    ['pause', 'pause'],
    ['dock', 'dock'],
  ] as const)('%s() calls broker.publish domain:lawn_mower service:%s', async (method, service) => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildMowerCtx('lawn_mower.garden', publishMutate)
    void new HaLawnMowerDevice(ctx)
    const provider = getMowerProvider(ctx)

    await provider[method]({ deviceId: 99 })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({
          domain: 'lawn_mower',
          service,
          entityId: 'lawn_mower.garden',
        }),
      }),
    )
  })

  it('state push maps HA activity + battery into the cap slice', () => {
    const { ctx, setCapStateCalls } = buildMowerCtx('lawn_mower.garden')
    const device = new HaLawnMowerDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('mowing', { battery_level: 42 }),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed).toBeDefined()
    expect(pushed!['activity']).toBe('mowing')
    expect(pushed!['batteryLevel']).toBe(42)
    expect(pushed!['lastChangedAt']).toBe(Date.parse('2026-06-06T10:00:00.000Z'))
  })

  it('maps unknown HA state to idle and missing battery to null', () => {
    const { ctx, setCapStateCalls } = buildMowerCtx('lawn_mower.garden')
    const device = new HaLawnMowerDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeState('returning', {}),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['activity']).toBe('idle')
    expect(pushed!['batteryLevel']).toBeNull()
  })

  it('skips unavailable / unknown pushes (preserves last-known slice)', () => {
    const { ctx, setCapStateCalls } = buildMowerCtx('lawn_mower.garden')
    const device = new HaLawnMowerDevice(ctx)
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
