import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeederDevice } from '@apocaliss92/nodepetkit'
import {
  DeviceType,
  deviceStateRefreshCapability,
  type DeviceContext,
  type IDeviceRuntimeState,
  type PetFeederStatus,
} from '@camstack/types'
import { petkitConnections } from '../petkit-gateway.js'
import { PetkitFeederDevice } from '../devices/petkit-feeder-device.js'

interface Registration {
  readonly cap: { readonly name: string }
  readonly provider: Record<string, (input: never) => Promise<unknown>>
  readonly options: { readonly stateRefresh?: Record<string, unknown> } | undefined
}

/** A test double for the library's feeder handle: the device reads what `cloud` currently says. */
function makeHandle(cloud: { childLock: number }) {
  const handle = {
    online: true,
    deviceType: 'd3',
    isDualHopper: false,
    feeding: false,
    food: 80,
    food1: null,
    food2: null,
    batteryPower: null,
    desiccantLeftDays: 20,
    errorCode: null,
    state: { state: { eating: 0, weight: 61 }, settings: { manualLock: cloud.childLock } },
    refresh: vi.fn(async () => {
      handle.state = { state: { eating: 0, weight: 61 }, settings: { manualLock: cloud.childLock } }
    }),
    setChildLock: vi.fn(async () => {}),
  }
  return handle
}

/** Documented type boundary: the double stands in for the library class (private members). */
function asFeeder(handle: ReturnType<typeof makeHandle>): FeederDevice {
  return handle as unknown as FeederDevice
}

function publish(handle: ReturnType<typeof makeHandle>, pollIntervalMs?: number): void {
  petkitConnections.set('acct-1', {
    infos: [],
    handles: new Map([['pk-1', asFeeder(handle)]]),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  })
}

function makeFeeder() {
  const registrations: Registration[] = []
  const warn = vi.fn()
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const ctx = {
    id: 3,
    stableId: 'petkit:test:3',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.PetFeeder,
      name: 'Feeder',
      location: null,
      disabled: false,
      addonId: 'provider-petkit',
      metadata: {},
    },
    persistedConfig: { petkitDeviceId: 'pk-1', integrationId: 'acct-1', petkitDeviceType: 'd3' },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn(
      (
        cap: { name: string; runtimeState?: unknown },
        provider: Registration['provider'],
        options?: Registration['options'],
      ) => {
        registrations.push({ cap, provider, options })
        if (cap.runtimeState && runtimeStateRef) {
          runtimeStateRef.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      },
    ),
    unregisterNativeCap: vi.fn(),
    api: {
      deviceManager: {
        registerDevice: { mutate: vi.fn(async () => ({})) },
        setMetadata: { mutate: vi.fn(async () => {}) },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as DeviceContext
  const device = new PetkitFeederDevice(ctx)
  return {
    device,
    warn,
    reg: (name: string) => registrations.find((r) => r.cap.name === name),
    status: () => device.runtimeState.getCapState<PetFeederStatus>('pet-feeder'),
  }
}

beforeEach(() => {
  petkitConnections.clear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('PetKit device-state-refresh (D1062)', () => {
  it('declares a polled, per-device policy slowed by the integration interval', async () => {
    publish(makeHandle({ childLock: 0 }), 60_000)
    const { device, reg } = makeFeeder()
    await device.onActivate()
    expect(reg(deviceStateRefreshCapability.name)?.options?.stateRefresh).toMatchObject({
      integrationId: 'acct-1',
      push: 'none',
      batch: false,
      minIntervalMs: 30_000,
      intervalMs: 60_000,
    })
  })

  it('owns no poll timer: the device is read once on activation and then only when the core asks', async () => {
    vi.useFakeTimers()
    const handle = makeHandle({ childLock: 0 })
    publish(handle)
    const { device } = makeFeeder()
    await device.onActivate()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(handle.refresh).toHaveBeenCalledTimes(1)
    await device.removeDevice()
  })

  it('a refresh reads the cloud and maps what it says into the slice', async () => {
    const cloud = { childLock: 0 }
    const handle = makeHandle(cloud)
    publish(handle)
    const { device, reg, status } = makeFeeder()
    await device.onActivate()
    expect(status()?.childLock).toBe(false)
    cloud.childLock = 1
    await reg(deviceStateRefreshCapability.name)?.provider['refresh']?.({
      deviceIds: [3],
      reason: 'schedule',
    } as never)
    expect(status()?.childLock).toBe(true)
  })

  it('a refresh the cloud refused fails, so the core logs it', async () => {
    const handle = makeHandle({ childLock: 0 })
    publish(handle)
    const { device, reg } = makeFeeder()
    await device.onActivate()
    handle.refresh.mockRejectedValueOnce(new Error('429'))
    await expect(
      reg(deviceStateRefreshCapability.name)?.provider['refresh']?.({
        deviceIds: [3],
        reason: 'schedule',
      } as never),
    ).rejects.toThrow(/429/)
  })

  it('a refresh the core asked for is not logged by the provider (the core logs it)', async () => {
    const handle = makeHandle({ childLock: 0 })
    publish(handle)
    const { device, reg, warn } = makeFeeder()
    await device.onActivate()
    await new Promise((resolve) => setTimeout(resolve, 0)) // the activation read settles
    warn.mockClear()
    handle.refresh.mockRejectedValueOnce(new Error('429'))
    await reg(deviceStateRefreshCapability.name)
      ?.provider['refresh']?.({ deviceIds: [3], reason: 'schedule' } as never)
      .catch(() => undefined)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a feed is held as feeding, so the core reads again 3 s and 10 s after it', async () => {
    publish(makeHandle({ childLock: 0 }))
    const { device, reg } = makeFeeder()
    await device.onActivate()
    expect(reg('pet-feeder')?.options).toMatchObject({
      commands: { feed: { extraEffects: [{ field: 'feeding', value: true }] } },
    })
  })

  it('a command does not read the cloud itself: the core reads after it', async () => {
    const handle = makeHandle({ childLock: 0 })
    publish(handle)
    const { device, reg } = makeFeeder()
    await device.onActivate()
    handle.refresh.mockClear()
    await reg('pet-feeder')?.provider['setChildLock']?.({ on: true } as never)
    expect(handle.setChildLock).toHaveBeenCalledWith(true)
    expect(handle.refresh).not.toHaveBeenCalled()
  })

  it('a status read never waits for the cloud (serve and revalidate, D224)', async () => {
    const handle = makeHandle({ childLock: 0 })
    publish(handle)
    const { device, reg } = makeFeeder()
    await device.onActivate()
    // The slice is old and the cloud is slow: the answer is the slice we have.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    handle.refresh.mockImplementation(() => new Promise<void>(() => {}))
    const answered = await Promise.race([
      reg('pet-feeder')?.provider['getStatus']?.({ deviceId: 3 } as never),
      new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 50)),
    ])
    expect(answered).not.toBe('waited')
    vi.restoreAllMocks()
  })
})
