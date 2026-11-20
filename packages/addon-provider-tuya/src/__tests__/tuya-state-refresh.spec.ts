import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DeviceType,
  deviceStateRefreshCapability,
  type DeviceContext,
  type IDeviceRuntimeState,
  type SwitchStatus,
} from '@camstack/types'

/** The LAN client: a connected fake that keeps the datapoints the "device" reports. */
const lan = vi.hoisted(() => ({
  dps: {} as Record<string, unknown>,
  sets: [] as unknown[],
  clients: [] as { emit(event: string): boolean }[],
}))

vi.mock('@apocaliss92/nodetuya', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeTuyaDevice extends EventEmitter {
    constructor() {
      super()
      lan.clients.push(this)
    }
    get dps(): Record<string, unknown> {
      return lan.dps
    }
    async connect(): Promise<void> {}
    async get(): Promise<Record<string, unknown>> {
      return lan.dps
    }
    async set(patch: Record<string, unknown>): Promise<void> {
      lan.sets.push(patch)
    }
    disconnect(): void {}
  }
  return { TuyaDevice: FakeTuyaDevice }
})

import { tuyaConnections } from '../tuya-gateway.js'
import { TuyaDpSwitchDevice } from '../devices/tuya-dp-switch-child.js'
import { TuyaSwitchDevice } from '../devices/tuya-switch-device.js'

interface Registration {
  readonly cap: { readonly name: string }
  readonly provider: Record<string, (input: never) => Promise<unknown>>
  readonly options: { readonly stateRefresh?: Record<string, unknown> } | undefined
}

function makeCtx(persistedConfig: Record<string, unknown>) {
  const registrations: Registration[] = []
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const ctx = {
    id: 5,
    stableId: 'tuya:test:5',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Switch,
      name: 'Plug',
      location: null,
      disabled: false,
      addonId: 'provider-tuya',
      metadata: {},
    },
    persistedConfig,
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
    unregisterNativeCap: vi.fn((name: string) => {
      const at = registrations.findIndex((r) => r.cap.name === name)
      if (at >= 0) registrations.splice(at, 1)
    }),
    api: {
      deviceManager: {
        registerDevice: { mutate: vi.fn(async () => ({})) },
        setMetadata: { mutate: vi.fn(async () => {}) },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as DeviceContext
  return {
    ctx,
    reg: (name: string) => registrations.find((r) => r.cap.name === name),
  }
}

const OWNER = { integrationId: 'acct-1', tuyaDeviceId: 'dev-1', localKey: 'k', host: '10.0.0.5' }

async function ownerSwitch() {
  const { ctx, reg } = makeCtx(OWNER)
  const device = new TuyaSwitchDevice(ctx)
  await device.onActivate()
  return { device, reg, on: () => device.runtimeState.getCapState<SwitchStatus>('switch')?.on }
}

async function childSwitch() {
  const { ctx, reg } = makeCtx({ integrationId: 'acct-1', tuyaDeviceId: 'dev-1', dp: '1' })
  const device = new TuyaDpSwitchDevice(ctx)
  await device.onActivate()
  return { device, reg, on: () => device.runtimeState.getCapState<SwitchStatus>('switch')?.on }
}

beforeEach(() => {
  lan.dps = { '1': false }
  lan.sets = []
  lan.clients = []
  tuyaConnections.clear()
})

describe('Tuya device-state-refresh (D1062)', () => {
  it('the LAN owner declares push full for the account, so the core never schedules a read', async () => {
    const { reg } = await ownerSwitch()
    expect(reg(deviceStateRefreshCapability.name)?.options?.stateRefresh).toMatchObject({
      integrationId: 'acct-1',
      push: 'full',
      batch: false,
    })
  })

  it('a LAN reconnect bumps the connection epoch, so the core reads the device again', async () => {
    const { reg } = await ownerSwitch()
    const epoch = (): unknown =>
      reg(deviceStateRefreshCapability.name)?.options?.stateRefresh?.['connectionEpoch']
    const first = epoch()
    lan.clients[0]?.emit('connected') // the first connect is not a reconnect
    expect(epoch()).toBe(first)
    lan.clients[0]?.emit('disconnected')
    lan.clients[0]?.emit('connected')
    expect(epoch()).toBeGreaterThan(typeof first === 'number' ? first : -1)
  })

  it('an owner refresh queries the device and moves the slice to what it reports', async () => {
    const { reg, on } = await ownerSwitch()
    expect(on()).toBe(false)
    lan.dps = { '1': true } // changed on the device, no push reached us
    await reg(deviceStateRefreshCapability.name)?.provider['refresh']?.({
      deviceIds: [5],
      reason: 'command',
    } as never)
    expect(on()).toBe(true)
  })

  it('an accessory child declares push full and its refresh reads the shared client', async () => {
    await ownerSwitch()
    const { reg, on } = await childSwitch()
    expect(reg(deviceStateRefreshCapability.name)?.options?.stateRefresh).toMatchObject({
      integrationId: 'acct-1',
      push: 'full',
    })
    lan.dps = { '1': true }
    await reg(deviceStateRefreshCapability.name)?.provider['refresh']?.({
      deviceIds: [5],
      reason: 'command',
    } as never)
    expect(on()).toBe(true)
  })

  it('a refresh with no LAN client fails, never a silent success', async () => {
    const { reg } = await childSwitch()
    await expect(
      reg(deviceStateRefreshCapability.name)?.provider['refresh']?.({
        deviceIds: [5],
        reason: 'schedule',
      } as never),
    ).rejects.toThrow(/LAN client unavailable/)
  })
})

describe('Tuya commands are held by the hub, never confirmed by the provider (D1061)', () => {
  it('the owner switch setState writes the DP and leaves the slice to the device push', async () => {
    const { reg, on } = await ownerSwitch()
    await reg('switch')?.provider['setState']?.({ on: true } as never)
    expect(lan.sets).toEqual([{ '1': true }])
    expect(on()).toBe(false)
  })

  it('the child switch setState leaves the slice to the device push', async () => {
    await ownerSwitch()
    const { reg, on } = await childSwitch()
    await reg('switch')?.provider['setState']?.({ on: true } as never)
    expect(lan.sets).toEqual([{ '1': true }])
    expect(on()).toBe(false)
  })
})
