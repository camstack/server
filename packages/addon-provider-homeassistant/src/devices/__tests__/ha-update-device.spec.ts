import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaUpdateDevice } from '../ha-update-device.js'
import type { HaEntityState } from '../../ha-types.js'

function buildUpdateCtx(
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
    id: 77,
    stableId: `ha:update:77`,
    parentDeviceId: null,
    deviceMeta: {
      id: 77,
      stableId: `ha:update:77`,
      type: DeviceType.Update,
      name: 'Test Update',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      capabilities: ['update'],
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
      allocateDeviceId: vi.fn(async () => 77),
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
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-update-test' })) },
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

function getUpdateProvider(ctx: import('@camstack/types').DeviceContext): {
  installUpdate: (i: { deviceId: number }) => Promise<void>
} {
  const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
  const call = registerNativeCap.mock.calls.find(
    (c: ReadonlyArray<{ name: string }>) => c[0]?.name === 'update',
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
    entity_id: 'update.router_firmware',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

function pushTo(device: HaUpdateDevice, state: HaEntityState): void {
  ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(state)
}

describe('HaUpdateDevice — ghost "Installing…" when up to date (device 880 bug)', () => {
  it('state=off with a stuck in_progress:true reports inProgress=false (nothing to install)', () => {
    // Real-world HA quirk: a firmware-update entity that is up to date
    // (state `off`, installed_version == latest_version) but leaves
    // `in_progress` pinned at `true`. There is no update to install, so the
    // device must NOT show a permanent "Installing…".
    const { ctx, setCapStateCalls } = buildUpdateCtx('update.serratura_front_door_firmware')
    const device = new HaUpdateDevice(ctx)
    pushTo(
      device,
      makeState('off', {
        installed_version: '085',
        latest_version: '085',
        in_progress: true,
        update_percentage: null,
      }),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['inProgress']).toBe(false)
    expect(pushed!['state']).toBe('off')
  })

  it('state=on with update_percentage > 0 reports inProgress=true (modern HA signal)', () => {
    const { ctx, setCapStateCalls } = buildUpdateCtx('update.router_firmware')
    const device = new HaUpdateDevice(ctx)
    pushTo(
      device,
      makeState('on', {
        installed_version: '1.0.0',
        latest_version: '1.1.0',
        in_progress: false,
        update_percentage: 42,
      }),
    )
    expect(setCapStateCalls[setCapStateCalls.length - 1]!['inProgress']).toBe(true)
  })

  it('state=on but no install signals reports inProgress=false', () => {
    const { ctx, setCapStateCalls } = buildUpdateCtx('update.router_firmware')
    const device = new HaUpdateDevice(ctx)
    pushTo(
      device,
      makeState('on', {
        installed_version: '1.0.0',
        latest_version: '1.1.0',
        in_progress: false,
        update_percentage: null,
      }),
    )
    expect(setCapStateCalls[setCapStateCalls.length - 1]!['inProgress']).toBe(false)
  })
})

describe('HaUpdateDevice', () => {
  it('registers the "update" cap on construction', () => {
    const { ctx } = buildUpdateCtx('update.router_firmware')
    void new HaUpdateDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const names = registerNativeCap.mock.calls.map(
      (c: ReadonlyArray<{ name: string }>) => c[0]?.name,
    )
    expect(names).toContain('update')
  })

  it('state=on means an update IS available; versions populated from attributes', () => {
    const { ctx, setCapStateCalls } = buildUpdateCtx('update.router_firmware')
    const device = new HaUpdateDevice(ctx)
    pushTo(
      device,
      makeState('on', {
        installed_version: '1.0.0',
        latest_version: '1.1.0',
        in_progress: false,
      }),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['currentVersion']).toBe('1.0.0')
    expect(pushed!['availableVersion']).toBe('1.1.0')
    expect(pushed!['updatable']).toBe(true)
    expect(pushed!['state']).toBe('on')
    expect(pushed!['inProgress']).toBe(false)
  })

  it('in_progress boolean true → inProgress true', () => {
    const { ctx, setCapStateCalls } = buildUpdateCtx('update.router_firmware')
    const device = new HaUpdateDevice(ctx)
    pushTo(device, makeState('on', { in_progress: true }))
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['inProgress']).toBe(true)
  })

  it('in_progress numeric > 0 → inProgress true; 0 → false', () => {
    const { ctx, setCapStateCalls } = buildUpdateCtx('update.router_firmware')
    const device = new HaUpdateDevice(ctx)
    pushTo(device, makeState('on', { in_progress: 42 }))
    expect(setCapStateCalls[setCapStateCalls.length - 1]!['inProgress']).toBe(true)
    pushTo(device, makeState('on', { in_progress: 0 }))
    expect(setCapStateCalls[setCapStateCalls.length - 1]!['inProgress']).toBe(false)
  })

  it('off state → versions round-trip; updatable stays true (capability flag)', () => {
    const { ctx, setCapStateCalls } = buildUpdateCtx('update.router_firmware')
    const device = new HaUpdateDevice(ctx)
    pushTo(
      device,
      makeState('off', {
        installed_version: '2.0.0',
        latest_version: '2.0.0',
      }),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['currentVersion']).toBe('2.0.0')
    expect(pushed!['availableVersion']).toBe('2.0.0')
    expect(pushed!['state']).toBe('off')
    expect(pushed!['updatable']).toBe(true)
  })

  it('null versions when attributes absent', () => {
    const { ctx, setCapStateCalls } = buildUpdateCtx('update.router_firmware')
    const device = new HaUpdateDevice(ctx)
    pushTo(device, makeState('on', {}))
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['currentVersion']).toBeNull()
    expect(pushed!['availableVersion']).toBeNull()
  })

  it('skips unavailable / unknown pushes', () => {
    const { ctx, setCapStateCalls } = buildUpdateCtx('update.router_firmware')
    const device = new HaUpdateDevice(ctx)
    const before = setCapStateCalls.length
    pushTo(device, makeState('unavailable', {}))
    pushTo(device, makeState('unknown', {}))
    expect(setCapStateCalls.length).toBe(before)
  })

  it('installUpdate() calls update.install service', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildUpdateCtx('update.router_firmware', publishMutate)
    void new HaUpdateDevice(ctx)
    const provider = getUpdateProvider(ctx)

    await provider.installUpdate({ deviceId: 77 })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({
          domain: 'update',
          service: 'install',
          entityId: 'update.router_firmware',
        }),
      }),
    )
  })
})
