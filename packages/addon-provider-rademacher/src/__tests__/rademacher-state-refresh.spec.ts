/**
 * D1062 — a HomePilot device declares the polled, batched policy on its
 * `device-state-refresh` cap; the core's scheduled read polls the whole hub, a
 * command read polls only the cover named; the manager arms no timer.
 */
import type {
  CapabilityDefinition,
  InferNativeProvider,
  NativeCapOptions,
  StateRefreshPolicy,
} from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RADEMACHER_MIN_REFRESH_INTERVAL_MS,
  registerRademacherStateRefresh,
  type RademacherRefreshContext,
} from '../devices/rademacher-state-refresh.js'
import { RademacherIntegrationManager } from '../rademacher-integration-manager.js'
import { rademacherSessions } from '../rademacher-session-resolver.js'
import { FakeHubClient, FakeHubGateway, makeCover } from './fake-hub.js'
import { RecordingLogger } from './recording-logger.js'

type Reason = 'schedule' | 'command' | 'burst'

interface Registration {
  readonly policy: StateRefreshPolicy | undefined
  readonly refresh: (input: {
    deviceId: number
    deviceIds: number[]
    reason: Reason
  }) => Promise<unknown>
}

function fakeCtx(): {
  ctx: RademacherRefreshContext
  registrations: Registration[]
  unregistered: string[]
} {
  const registrations: Registration[] = []
  const unregistered: string[] = []
  const ctx: RademacherRefreshContext = {
    registerNativeCap<TCap extends CapabilityDefinition>(
      _cap: TCap,
      provider: InferNativeProvider<TCap>,
      options?: NativeCapOptions<TCap>,
    ): void {
      const refresh: unknown = Reflect.get(provider, 'refresh')
      registrations.push({
        policy: options?.stateRefresh,
        refresh: async (input) =>
          typeof refresh === 'function' ? Reflect.apply(refresh, provider, [input]) : undefined,
      })
    },
    unregisterNativeCap(capName: string): void {
      unregistered.push(capName)
    },
  }
  return { ctx, registrations, unregistered }
}

function rig(pollIntervalMs: number): {
  manager: RademacherIntegrationManager
  gateway: FakeHubGateway
} {
  const gateway = new FakeHubGateway()
  const client = new FakeHubClient([
    makeCover(gateway, '7', 'Salotto'),
    makeCover(gateway, '8', 'Cucina'),
  ])
  const manager = new RademacherIntegrationManager({
    id: 'int-1',
    name: 'Casa',
    connection: { host: '192.168.10.50', password: '', basePath: '', pollIntervalMs },
    logger: new RecordingLogger(),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: (id) => rademacherSessions.emitSnapshot(id),
    makeClient: () => client,
    reconnectBaseMs: 10,
  })
  rademacherSessions.set('int-1', manager)
  return { manager, gateway }
}

afterEach(() => {
  vi.useRealTimers()
  rademacherSessions.clear()
})

describe('Rademacher device-state-refresh (D1062)', () => {
  it('declares the polled, batched policy at the connection interval', async () => {
    const { manager } = rig(45_000)
    await manager.start()
    const { ctx, registrations } = fakeCtx()
    registerRademacherStateRefresh({ ctx, deviceId: 1, integrationId: 'int-1' })
    expect(registrations[0]?.policy).toEqual({
      integrationId: 'int-1',
      minIntervalMs: RADEMACHER_MIN_REFRESH_INTERVAL_MS,
      intervalMs: 45_000,
      batch: true,
      push: 'none',
    })
    await manager.stop()
  })

  it('a scheduled read polls every cover; a command read only the cover named', async () => {
    const { manager, gateway } = rig(30_000)
    await manager.start()
    const { ctx, registrations } = fakeCtx()
    registerRademacherStateRefresh({ ctx, deviceId: 11, integrationId: 'int-1', did: '7' })
    registerRademacherStateRefresh({ ctx, deviceId: 12, integrationId: 'int-1', did: '8' })
    const base = gateway.fetches
    await registrations[0]?.refresh({ deviceId: 11, deviceIds: [11, 12], reason: 'schedule' })
    expect(gateway.fetches - base).toBe(2)
    const afterSchedule = gateway.fetches
    await registrations[0]?.refresh({ deviceId: 11, deviceIds: [11], reason: 'command' })
    expect(gateway.fetches - afterSchedule).toBe(1)
    await manager.stop()
  })

  it('arms no poll timer: only the core asks for a read', async () => {
    vi.useFakeTimers()
    const { manager, gateway } = rig(2_000)
    await manager.start()
    const base = gateway.fetches
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(gateway.fetches).toBe(base)
    expect(vi.getTimerCount()).toBe(0)
    await manager.stop()
  })

  it('registers again when the interval changes', async () => {
    const { manager } = rig(30_000)
    await manager.start()
    const { ctx, registrations, unregistered } = fakeCtx()
    registerRademacherStateRefresh({ ctx, deviceId: 1, integrationId: 'int-1' })
    await manager.applyConnection(
      { host: '192.168.10.50', password: '', basePath: '', pollIntervalMs: 90_000 },
      'Casa',
    )
    expect(unregistered).toEqual(['device-state-refresh'])
    expect(registrations.at(-1)?.policy?.intervalMs).toBe(90_000)
    await manager.stop()
  })
})
