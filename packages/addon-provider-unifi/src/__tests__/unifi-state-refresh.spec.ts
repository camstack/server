/**
 * D1062 — a UniFi device declares the controller's refresh policy on its
 * `device-state-refresh` cap: polled while the event stream is down, partial
 * (a slower reconcile) while it is up; the policy follows the stream; the
 * manager arms no timer and re-lists only when the core asks.
 */
import type {
  CapabilityDefinition,
  IScopedLogger,
  InferNativeProvider,
  NativeCapOptions,
  StateRefreshPolicy,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsToConnection } from '../config.js'
import {
  registerUnifiStateRefresh,
  UNIFI_MIN_REFRESH_INTERVAL_MS,
  type UnifiRefreshContext,
} from '../devices/unifi-state-refresh.js'
import type { UnifiControllerClient, UnifiLiveChange } from '../unifi-client-contract.js'
import { UnifiIntegrationManager, UNIFI_RECONCILE_POLL_MS } from '../unifi-integration-manager.js'
import { unifiControllers } from '../unifi-node-resolver.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

interface Registration {
  readonly policy: StateRefreshPolicy | undefined
  readonly refresh: () => Promise<unknown>
}

function fakeCtx(): {
  ctx: UnifiRefreshContext
  registrations: Registration[]
  unregistered: string[]
} {
  const registrations: Registration[] = []
  const unregistered: string[] = []
  const ctx: UnifiRefreshContext = {
    registerNativeCap<TCap extends CapabilityDefinition>(
      _cap: TCap,
      provider: InferNativeProvider<TCap>,
      options?: NativeCapOptions<TCap>,
    ): void {
      const refresh: unknown = Reflect.get(provider, 'refresh')
      registrations.push({
        policy: options?.stateRefresh,
        refresh: async () =>
          typeof refresh === 'function'
            ? Reflect.apply(refresh, provider, [
                { deviceId: 1, deviceIds: [1], reason: 'schedule' },
              ])
            : undefined,
      })
    },
    unregisterNativeCap(capName: string): void {
      unregistered.push(capName)
    },
  }
  return { ctx, registrations, unregistered }
}

function rig(pollIntervalMs: number): {
  manager: UnifiIntegrationManager
  lists: { count: number }
  live: (change: UnifiLiveChange) => void
} {
  const lists = { count: 0 }
  let listener: ((change: UnifiLiveChange) => void) | null = null
  const client: UnifiControllerClient = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    listInfraDevices: async () => {
      lists.count += 1
      return []
    },
    listClients: async () => [],
    getInfraDevice: () => null,
    getClient: () => null,
    setPortPoe: async () => undefined,
    restartDevice: async () => undefined,
    powerCyclePort: async () => undefined,
    setLed: async () => undefined,
    degradedError: () => null,
    onLiveChange: (l) => {
      listener = l
      return () => undefined
    },
  }
  const manager = new UnifiIntegrationManager({
    id: 'u1',
    name: 'UniFi',
    connection: settingsToConnection({ host: 'console.example', apiKey: 'k', pollIntervalMs }),
    logger: quiet,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: (id) => unifiControllers.emitSnapshot(id),
    makeClient: () => client,
  })
  unifiControllers.set('u1', manager)
  return { manager, lists, live: (change) => listener?.(change) }
}

afterEach(() => {
  vi.useRealTimers()
  unifiControllers.clear()
})

describe('UniFi device-state-refresh (D1062)', () => {
  it('declares the polled, batched policy at the connection interval', async () => {
    const { manager } = rig(45_000)
    await manager.start()
    const { ctx, registrations } = fakeCtx()
    registerUnifiStateRefresh({ ctx, deviceId: 1, integrationId: 'u1' })
    expect(registrations[0]?.policy).toEqual({
      integrationId: 'u1',
      minIntervalMs: UNIFI_MIN_REFRESH_INTERVAL_MS,
      intervalMs: 45_000,
      batch: true,
      push: 'none',
    })
    await manager.stop()
  })

  it('the policy follows the event stream: partial and slower while up, polled when down', async () => {
    const { manager, live } = rig(45_000)
    await manager.start()
    const { ctx, registrations, unregistered } = fakeCtx()
    registerUnifiStateRefresh({ ctx, deviceId: 1, integrationId: 'u1' })
    live({ kind: 'stream', up: true, reason: null })
    expect(unregistered).toEqual(['device-state-refresh'])
    expect(registrations.at(-1)?.policy).toMatchObject({
      push: 'partial',
      intervalMs: UNIFI_RECONCILE_POLL_MS,
    })
    live({ kind: 'stream', up: false, reason: 'closed' })
    expect(registrations.at(-1)?.policy).toMatchObject({ push: 'none', intervalMs: 45_000 })
    await manager.stop()
  })

  it('re-lists only when the core asks, and arms no timer', async () => {
    vi.useFakeTimers()
    const { manager, lists } = rig(2_000)
    await manager.start()
    const afterStart = lists.count
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(lists.count).toBe(afterStart)
    expect(vi.getTimerCount()).toBe(0)
    const { ctx, registrations } = fakeCtx()
    registerUnifiStateRefresh({ ctx, deviceId: 1, integrationId: 'u1' })
    await registrations[0]?.refresh()
    expect(lists.count).toBe(afterStart + 1)
    await manager.stop()
  })
})
