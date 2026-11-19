/**
 * D1062 — a Gree AC declares the per-device polled policy on its
 * `device-state-refresh` cap; the core's read goes through the connection
 * manager (state, then the extra columns); a dead AC still counts toward being
 * lost and re-bound; the library's own poll timer is never started.
 */
import { EventEmitter } from 'node:events'
import { AcDevice, type DiscoveredDevice } from '@apocaliss92/nodegree'
import type {
  CapabilityDefinition,
  InferNativeProvider,
  IScopedLogger,
  NativeCapOptions,
  StateRefreshPolicy,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsToGreeConfig } from '../config.js'
import {
  GREE_MIN_REFRESH_INTERVAL_MS,
  registerGreeStateRefresh,
  type GreeRefreshContext,
} from '../devices/gree-state-refresh.js'
import { GreeConnectionResolver, greeConnections } from '../gree-gateway.js'
import { type GreeFacadeLike, GreeIntegrationManager } from '../gree-integration-manager.js'

const MAC = 'aa:bb:cc:dd:ee:01'
const responder: DiscoveredDevice = { ip: '192.0.2.10', port: 7000, mac: MAC, name: 'Daniel' }

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

interface FakeAc {
  readonly ac: AcDevice
  readonly updateState: ReturnType<typeof vi.fn>
  readonly requestColumns: ReturnType<typeof vi.fn>
  readonly startPolling: ReturnType<typeof vi.fn>
}

function fakeAc(): FakeAc {
  const ac: AcDevice = Object.create(AcDevice.prototype)
  const updateState = vi.fn(async () => ({}))
  const requestColumns = vi.fn(async () => ({ OutEnvTem: 46, Defrost: 0, AllErr: 0 }))
  const startPolling = vi.fn()
  Object.assign(ac, {
    emitter: new EventEmitter(),
    updateState,
    requestColumns,
    startPolling,
    stopPolling: vi.fn(),
  })
  return { ac, updateState, requestColumns, startPolling }
}

async function started(fake: FakeAc): Promise<{
  manager: GreeIntegrationManager
  resolver: GreeConnectionResolver
  disconnected: ReturnType<typeof vi.fn>
}> {
  const resolver = new GreeConnectionResolver()
  const disconnected = vi.fn()
  const facade: GreeFacadeLike = {
    discover: async () => [responder],
    createAc: async () => fake.ac,
    close: async () => undefined,
  }
  const manager = new GreeIntegrationManager({
    id: 'k1',
    name: 'Daniel',
    deviceId: 554,
    connection: settingsToGreeConfig({ host: '192.0.2.10' }),
    logger: silent,
    onConnected: () => undefined,
    onDisconnected: disconnected,
    surfaceSink: {
      set: (key, surface) => resolver.set(key, surface),
      setExtras: (key, mac, extras) => resolver.setExtras(key, mac, extras),
    },
    expectMac: MAC,
    makeFacade: () => facade,
    scheduler: { after: () => () => undefined },
  })
  await manager.start()
  return { manager, resolver, disconnected }
}

afterEach(() => greeConnections.clear())

describe('Gree device-state-refresh (D1062)', () => {
  it('declares the per-device polled policy', () => {
    const registered: Array<StateRefreshPolicy | undefined> = []
    const ctx: GreeRefreshContext = {
      registerNativeCap<TCap extends CapabilityDefinition>(
        _cap: TCap,
        _provider: InferNativeProvider<TCap>,
        options?: NativeCapOptions<TCap>,
      ): void {
        registered.push(options?.stateRefresh)
      },
    }
    registerGreeStateRefresh({ ctx, connectionKey: 'k1', mac: MAC })
    expect(registered[0]).toEqual({
      integrationId: 'k1',
      minIntervalMs: GREE_MIN_REFRESH_INTERVAL_MS,
      batch: false,
      push: 'none',
    })
  })

  it('never starts the library poll timer; a core read updates state and extras', async () => {
    const fake = fakeAc()
    const { manager, resolver } = await started(fake)
    expect(fake.startPolling).not.toHaveBeenCalled()
    fake.updateState.mockClear()
    await resolver.getRefresh('k1')?.(MAC)
    expect(fake.updateState).toHaveBeenCalledTimes(1)
    expect(resolver.getExtras('k1', MAC)).toEqual({ outdoorTemp: 6, defrost: false, errorCode: 0 })
    await manager.stop()
  })

  it('a timeout counts toward losing the AC; a refusal to read throws to the caller', async () => {
    const fake = fakeAc()
    const { manager, resolver, disconnected } = await started(fake)
    const timeout = Object.assign(new Error('no answer'), { name: 'GreeTimeoutError' })
    fake.updateState.mockRejectedValue(timeout)
    const refresh = resolver.getRefresh('k1')
    for (let i = 0; i < 3; i += 1) await expect(refresh?.(MAC)).rejects.toThrow('no answer')
    expect(disconnected).toHaveBeenCalledTimes(1)
    await manager.stop()
  })

  it('one failed read is exactly one count, even if the library also emits its poll events', async () => {
    const fake = fakeAc()
    const { manager, resolver, disconnected } = await started(fake)
    const timeout = Object.assign(new Error('no answer'), { name: 'GreeTimeoutError' })
    fake.updateState.mockImplementation(async () => {
      fake.ac.emit('error', timeout)
      fake.ac.emit('offline', undefined)
      throw timeout
    })
    const refresh = resolver.getRefresh('k1')
    for (let i = 0; i < 2; i += 1) await expect(refresh?.(MAC)).rejects.toThrow('no answer')
    expect(disconnected).not.toHaveBeenCalled()
    await expect(refresh?.(MAC)).rejects.toThrow('no answer')
    expect(disconnected).toHaveBeenCalledTimes(1)
    await manager.stop()
  })

  it('an unbound connection has nothing to read', () => {
    expect(greeConnections.getRefresh('nope')).toBeNull()
  })
})
