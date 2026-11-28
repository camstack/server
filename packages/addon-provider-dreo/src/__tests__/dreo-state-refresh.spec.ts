import { describe, expect, it, vi } from 'vitest'
import {
  DeviceType,
  deviceStateRefreshCapability,
  type DeviceContext,
  type IDeviceRuntimeState,
  type SwitchStatus,
} from '@dominevo/types'
import { settingsToDreoConfig } from '../config.js'
import { dreoConnections } from '../dreo-gateway.js'
import { DreoIntegrationManager } from '../dreo-integration-manager.js'
import { DreoFanDevice } from '../devices/dreo-fan-device.js'
import { forgetDreoEpoch } from '../dreo-state-refresh.js'
import { FakeBridge, IDLE_STATE } from './fake-bridge.js'

interface Registration {
  readonly cap: { readonly name: string }
  readonly provider: {
    refresh: (input: { deviceIds: number[]; reason: string }) => Promise<unknown>
  }
  readonly options: { readonly stateRefresh?: Record<string, unknown> } | undefined
}

const quiet = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
}

/** The real manager over a fake worker: the handle and the surface behave as in production. */
async function liveAccount() {
  const bridge = new FakeBridge()
  const manager = new DreoIntegrationManager({
    id: 'acct-1',
    name: 'Home',
    connection: settingsToDreoConfig({ email: 'u@example.com', password: 'p' }),
    logger: quiet as never,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    surfaceSink: dreoConnections,
    makeBridge: () => bridge,
    session: { register: () => undefined, failure: () => undefined, ok: async () => undefined },
  })
  await manager.start()
  return { bridge, manager }
}

function makeFan() {
  const registrations: Registration[] = []
  const unregistered: string[] = []
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const ctx = {
    id: 9,
    stableId: 'dreo:test:9',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Fan,
      name: 'Fan',
      location: null,
      disabled: false,
      addonId: 'provider-dreo',
      metadata: {},
    },
    persistedConfig: { dreoDeviceId: 'dev-1', brokerId: 'acct-1', model: 'DR-HAF001S' },
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
      unregistered.push(name)
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
  const device = new DreoFanDevice(ctx)
  return {
    device,
    registrations,
    refreshReg: () =>
      registrations.filter((r) => r.cap.name === deviceStateRefreshCapability.name).at(-1),
    power: () => device.runtimeState.getCapState<SwitchStatus>('switch')?.on,
  }
}

describe('Dreo device-state-refresh (D1062)', () => {
  it('declares push full for the account, so the core never schedules a read', async () => {
    await liveAccount()
    const { device, refreshReg } = makeFan()
    await device.onActivate()
    expect(refreshReg()?.options?.stateRefresh).toMatchObject({
      integrationId: 'acct-1',
      push: 'full',
      batch: false,
      connectionEpoch: 0,
    })
  })

  it('a refresh reads the account from the cloud, not the cached state', async () => {
    const { bridge } = await liveAccount()
    const { device, refreshReg, power } = makeFan()
    await device.onActivate()
    expect(power()).toBe(false)
    await device.removeDevice() // stop the push listener: only the refresh can move the slice now
    bridge.refreshed = { 'dev-1': { ...IDLE_STATE, on: true } }
    expect(power()).toBe(false)
    await refreshReg()?.provider.refresh({ deviceIds: [9], reason: 'command' })
    expect(bridge.refreshCalls).toBe(1)
    // The handle holds the cloud answer; the slice follows once a listener recomputes it.
    expect(dreoConnections.getDevice('acct-1', 'dev-1')?.state.on).toBe(true)
  })

  it('a refresh with no live connection fails, never a silent success', async () => {
    await liveAccount()
    const { device, refreshReg } = makeFan()
    await device.onActivate()
    dreoConnections.set('acct-1', null)
    await expect(
      refreshReg()?.provider.refresh({ deviceIds: [9], reason: 'schedule' }),
    ).rejects.toThrow(/cloud connection unavailable/)
  })

  it('a reconnect of the push channel publishes a higher connection epoch', async () => {
    const { bridge } = await liveAccount()
    const { device, refreshReg } = makeFan()
    await device.onActivate()
    const before = refreshReg()?.options?.stateRefresh?.['connectionEpoch']
    bridge.push({ push: 'channel', state: 'down' })
    bridge.push({ push: 'channel', state: 'up' })
    const after = refreshReg()?.options?.stateRefresh?.['connectionEpoch']
    expect(typeof before).toBe('number')
    expect(after).toBe(Number(before) + 1)
  })

  it('one reconnect is one epoch bump for the account, however many devices it has', async () => {
    const { bridge } = await liveAccount()
    const first = makeFan()
    const second = makeFan()
    await first.device.onActivate()
    await second.device.onActivate()
    const before = Number(first.refreshReg()?.options?.stateRefresh?.['connectionEpoch'])
    bridge.push({ push: 'channel', state: 'down' })
    bridge.push({ push: 'channel', state: 'up' })
    expect(first.refreshReg()?.options?.stateRefresh?.['connectionEpoch']).toBe(before + 1)
    expect(second.refreshReg()?.options?.stateRefresh?.['connectionEpoch']).toBe(before + 1)
  })

  it('an unknown power value stays unknown in the slice, never false (D315)', async () => {
    const { bridge } = await liveAccount()
    const { device, power } = makeFan()
    await device.onActivate()
    bridge.push({ push: 'state', deviceId: 'dev-1', state: { ...IDLE_STATE, on: true } })
    expect(power()).toBe(true)
    bridge.push({ push: 'state', deviceId: 'dev-1', state: { ...IDLE_STATE, on: null } })
    expect(power()).toBeNull()
  })

  it('forgets the epoch of a removed account', async () => {
    const { bridge } = await liveAccount()
    const first = makeFan()
    await first.device.onActivate()
    bridge.push({ push: 'channel', state: 'down' })
    bridge.push({ push: 'channel', state: 'up' })
    forgetDreoEpoch('acct-1')
    const later = makeFan()
    await later.device.onActivate()
    expect(later.refreshReg()?.options?.stateRefresh?.['connectionEpoch']).toBe(0)
  })

  it('a pushed state reaches the slice; a command alone does not (D1061)', async () => {
    const { bridge } = await liveAccount()
    const { device, power } = makeFan()
    await device.onActivate()
    const handle = dreoConnections.getDevice('acct-1', 'dev-1')
    await handle?.setPower(true)
    expect(power()).toBe(false)
    bridge.push({ push: 'state', deviceId: 'dev-1', state: { ...IDLE_STATE, on: true } })
    expect(power()).toBe(true)
  })
})
