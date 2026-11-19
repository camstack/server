/**
 * D1062 — an Enpal box-level device declares the polled, batched policy on its
 * `device-state-refresh` cap, re-registers when the interval changes, and answers
 * the core's read by polling the box; the manager arms no timer of its own.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CapabilityDefinition,
  IScopedLogger,
  InferNativeProvider,
  NativeCapOptions,
  StateRefreshPolicy,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { settingsToConnection } from '../config.js'
import type { FetchLike } from '../enpal-client.js'
import { EnpalIntegrationManager } from '../enpal-integration-manager.js'
import { enpalConnections } from '../enpal-resolver.js'
import {
  ENPAL_MIN_REFRESH_INTERVAL_MS,
  registerEnpalStateRefresh,
  type EnpalRefreshContext,
} from '../devices/enpal-state-refresh.js'

const csv = readFileSync(join(__dirname, 'fixtures', 'influx-last-values.csv'), 'utf8')

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

interface Registration {
  readonly policy: StateRefreshPolicy | undefined
  readonly refresh: () => Promise<unknown>
}

function fakeCtx(): {
  ctx: EnpalRefreshContext
  registrations: Registration[]
  unregistered: string[]
} {
  const registrations: Registration[] = []
  const unregistered: string[] = []
  const ctx: EnpalRefreshContext = {
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

function manager(fetches: string[], pollIntervalMs: number): EnpalIntegrationManager {
  const fetchFake: FetchLike = async (url) => {
    fetches.push(String(url))
    return new Response(csv, { status: 200 })
  }
  return new EnpalIntegrationManager({
    id: 'int_1',
    name: 'Enpal',
    connection: settingsToConnection({
      host: '192.0.2.10',
      token: 't',
      source: 'influx',
      pollIntervalMs,
    }),
    tokenLocked: false,
    logger: silent,
    fetch: fetchFake,
    now: () => 42,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: () => enpalConnections.emitSnapshot('int_1'),
  })
}

describe('Enpal device-state-refresh registration (D1062)', () => {
  afterEach(() => enpalConnections.set('int_1', null))

  it('declares the polled, batched policy at the connection interval', () => {
    enpalConnections.set('int_1', manager([], 60_000))
    const { ctx, registrations } = fakeCtx()
    registerEnpalStateRefresh({ ctx, deviceId: 1, integrationId: 'int_1' })
    expect(registrations[0]?.policy).toEqual({
      integrationId: 'int_1',
      minIntervalMs: ENPAL_MIN_REFRESH_INTERVAL_MS,
      intervalMs: 60_000,
      batch: true,
      push: 'none',
    })
  })

  it('the core read polls the box and publishes the snapshot', async () => {
    const fetches: string[] = []
    const m = manager(fetches, 10_000)
    enpalConnections.set('int_1', m)
    await m.start()
    const afterStart = fetches.length
    const { ctx, registrations } = fakeCtx()
    registerEnpalStateRefresh({ ctx, deviceId: 1, integrationId: 'int_1' })
    await registrations[0]?.refresh()
    expect(fetches.length).toBeGreaterThan(afterStart)
    expect(m.getSnapshot()).not.toBeNull()
    await m.stop()
  })

  it('a refresh with no running integration fails loudly', async () => {
    const { ctx, registrations } = fakeCtx()
    registerEnpalStateRefresh({ ctx, deviceId: 1, integrationId: 'int_1' })
    await expect(registrations[0]?.refresh()).rejects.toThrow(/not running/)
  })

  it('registers again when the connection interval changes', () => {
    enpalConnections.set('int_1', manager([], 60_000))
    const { ctx, registrations, unregistered } = fakeCtx()
    registerEnpalStateRefresh({ ctx, deviceId: 1, integrationId: 'int_1' })
    enpalConnections.set('int_1', manager([], 120_000))
    enpalConnections.emitSnapshot('int_1')
    expect(unregistered).toEqual(['device-state-refresh'])
    expect(registrations.at(-1)?.policy?.intervalMs).toBe(120_000)
  })
})
