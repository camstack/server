/**
 * D1062 — a VeSync device declares the account's refresh policy on its
 * `device-state-refresh` cap (polled, batched, no faster than the VeSync floor,
 * slowed by `pollIntervalMs`), registers it again when the interval changes,
 * and answers the core's reads through the account manager.
 */
import type {
  CapabilityDefinition,
  IScopedLogger,
  InferNativeProvider,
  NativeCapOptions,
  StateRefreshPolicy,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { vesyncConnectionSchema } from '../config.js'
import type { VeSyncClient, VeSyncPurifierSnapshot } from '../vesync-client-contract.js'
import { vesyncAccounts } from '../vesync-account-resolver.js'
import { VeSyncIntegrationManager } from '../vesync-integration-manager.js'
import {
  registerVeSyncStateRefresh,
  type VeSyncRefreshContext,
  VESYNC_MIN_REFRESH_INTERVAL_MS,
} from '../devices/vesync-state-refresh.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

const purifier: VeSyncPurifierSnapshot = {
  kind: 'purifier',
  nativeId: 'cid-1',
  name: 'Purifier',
  power: false,
  speedPercent: null,
  preset: '',
  availablePresets: ['auto'],
  childLock: false,
  display: true,
  filterLifePercent: 90,
  online: true,
}

interface Registration {
  readonly capName: string
  readonly policy: StateRefreshPolicy | undefined
  readonly refresh:
    | ((input: {
        deviceId: number
        deviceIds: number[]
        reason: 'schedule' | 'command' | 'burst'
      }) => Promise<unknown>)
    | undefined
}

function fakeCtx(): {
  ctx: VeSyncRefreshContext
  registrations: Registration[]
  unregistered: string[]
} {
  const registrations: Registration[] = []
  const unregistered: string[] = []
  const ctx: VeSyncRefreshContext = {
    registerNativeCap<TCap extends CapabilityDefinition>(
      cap: TCap,
      provider: InferNativeProvider<TCap>,
      options?: NativeCapOptions<TCap>,
    ): void {
      const refresh: unknown = Reflect.get(provider, 'refresh')
      registrations.push({
        capName: cap.name,
        policy: options?.stateRefresh,
        refresh:
          typeof refresh === 'function'
            ? (input) => Promise.resolve(Reflect.apply(refresh, provider, [input]))
            : undefined,
      })
    },
    unregisterNativeCap(capName: string): void {
      unregistered.push(capName)
    },
  }
  return { ctx, registrations, unregistered }
}

function manager(calls: string[], pollIntervalMs: number): VeSyncIntegrationManager {
  const client: VeSyncClient = {
    login: async () => undefined,
    restoreSession: () => undefined,
    logout: async () => undefined,
    listDevices: async () => {
      calls.push('listDevices')
      return [purifier]
    },
    refreshDevice: async (nativeId) => {
      calls.push(`refreshDevice:${nativeId}`)
      return purifier
    },
    getDevice: () => purifier,
    setPower: async () => undefined,
    setFanSpeed: async () => undefined,
    setMode: async () => undefined,
    setChildLock: async () => undefined,
    setDisplay: async () => undefined,
    setTargetHumidity: async () => undefined,
  }
  return new VeSyncIntegrationManager({
    id: 'int_1',
    name: 'Home',
    connection: vesyncConnectionSchema.parse({
      email: 'me@example.com',
      password: 'pw',
      pollIntervalMs,
    }),
    logger: silent,
    sessions: {
      load: async () => null,
      save: async () => undefined,
      clear: async () => undefined,
      prune: async () => undefined,
    },
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: (id) => vesyncAccounts.emitSnapshot(id),
    makeClient: () => client,
  })
}

describe('VeSync device-state-refresh registration (D1062)', () => {
  afterEach(() => vesyncAccounts.clear())

  it('declares the polled, batched policy, slowed by pollIntervalMs', async () => {
    const calls: string[] = []
    const m = manager(calls, 60_000)
    vesyncAccounts.set('int_1', m)
    await m.start()
    const { ctx, registrations } = fakeCtx()
    const stop = registerVeSyncStateRefresh({
      ctx,
      deviceId: 5851,
      integrationId: 'int_1',
      nativeId: 'cid-1',
    })
    expect(registrations).toEqual([
      expect.objectContaining({
        capName: 'device-state-refresh',
        policy: {
          integrationId: 'int_1',
          minIntervalMs: VESYNC_MIN_REFRESH_INTERVAL_MS,
          intervalMs: 60_000,
          batch: true,
          push: 'none',
        },
      }),
    ])
    stop()
  })

  it('registers again when pollIntervalMs changes', async () => {
    const calls: string[] = []
    const m = manager(calls, 60_000)
    vesyncAccounts.set('int_1', m)
    await m.start()
    const { ctx, registrations, unregistered } = fakeCtx()
    const stop = registerVeSyncStateRefresh({
      ctx,
      deviceId: 5851,
      integrationId: 'int_1',
      nativeId: 'cid-1',
    })
    await m.applyConnection(
      vesyncConnectionSchema.parse({
        email: 'me@example.com',
        password: 'pw',
        pollIntervalMs: 120_000,
      }),
    )
    expect(unregistered).toEqual(['device-state-refresh'])
    expect(registrations.map((r) => r.policy?.intervalMs)).toEqual([60_000, 120_000])
    stop()
  })

  it("answers the core's reads through the account manager", async () => {
    const calls: string[] = []
    const m = manager(calls, 60_000)
    vesyncAccounts.set('int_1', m)
    await m.start()
    const { ctx, registrations } = fakeCtx()
    const stop = registerVeSyncStateRefresh({
      ctx,
      deviceId: 5851,
      integrationId: 'int_1',
      nativeId: 'cid-1',
    })
    calls.length = 0
    await registrations[0]?.refresh?.({ deviceId: 5851, deviceIds: [5851], reason: 'command' })
    await registrations[0]?.refresh?.({ deviceId: 5851, deviceIds: [5851], reason: 'schedule' })
    expect(calls).toEqual(['refreshDevice:cid-1', 'listDevices'])
    stop()
  })
})
