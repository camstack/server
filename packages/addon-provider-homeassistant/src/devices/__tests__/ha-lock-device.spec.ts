import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaLockDevice } from '../ha-lock-device.js'

function buildLockCtx(
  entityId: string,
  publishMutate = vi.fn(async () => null),
): import('@camstack/types').DeviceContext {
  let runtimeStateRef: IDeviceRuntimeState | null = null

  return {
    id: 99,
    stableId: `ha:lock:99`,
    parentDeviceId: null,
    deviceMeta: {
      id: 99,
      stableId: `ha:lock:99`,
      type: DeviceType.Lock,
      name: 'Test Lock',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      capabilities: ['lock-control'],
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
        publish: { mutate: publishMutate },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-lock-test' })) },
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
}

function getLockProvider(ctx: import('@camstack/types').DeviceContext): {
  lock: (i: { deviceId: number; code?: string }) => Promise<void>
  unlock: (i: { deviceId: number; code?: string }) => Promise<void>
  open: (i: { deviceId: number }) => Promise<void>
} {
  const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
  const lockCall = registerNativeCap.mock.calls.find(
    (call: ReadonlyArray<{ name: string }>) => call[0]?.name === 'lock-control',
  )
  expect(lockCall).toBeDefined()
  return lockCall![1] as {
    lock: (i: { deviceId: number; code?: string }) => Promise<void>
    unlock: (i: { deviceId: number; code?: string }) => Promise<void>
    open: (i: { deviceId: number }) => Promise<void>
  }
}

describe('HaLockDevice', () => {
  it('registers the "lock-control" cap on construction', () => {
    const ctx = buildLockCtx('lock.front_door')
    void new HaLockDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const registeredNames: string[] = registerNativeCap.mock.calls.map(
      (call: ReadonlyArray<{ name: string }>) => call[0]!.name,
    )
    expect(registeredNames).toContain('lock-control')
  })

  it('lock() calls broker.publish with domain:lock service:lock and entityId', async () => {
    const publishMutate = vi.fn(async () => null)
    const ctx = buildLockCtx('lock.front_door', publishMutate)
    void new HaLockDevice(ctx)
    const provider = getLockProvider(ctx)

    await provider.lock({ deviceId: 99 })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({
          domain: 'lock',
          service: 'lock',
          entityId: 'lock.front_door',
        }),
      }),
    )
  })

  it('unlock() calls broker.publish with domain:lock service:unlock and entityId', async () => {
    const publishMutate = vi.fn(async () => null)
    const ctx = buildLockCtx('lock.front_door', publishMutate)
    void new HaLockDevice(ctx)
    const provider = getLockProvider(ctx)

    await provider.unlock({ deviceId: 99 })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({
          domain: 'lock',
          service: 'unlock',
          entityId: 'lock.front_door',
        }),
      }),
    )
  })

  it('open() calls broker.publish with domain:lock service:open and entityId', async () => {
    const publishMutate = vi.fn(async () => null)
    const ctx = buildLockCtx('lock.garage_door', publishMutate)
    void new HaLockDevice(ctx)
    const provider = getLockProvider(ctx)

    await provider.open({ deviceId: 99 })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({
          domain: 'lock',
          service: 'open',
          entityId: 'lock.garage_door',
        }),
      }),
    )
  })
})
