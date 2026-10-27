import { EventEmitter } from 'node:events'
import {
  DreameAuthError,
  type MiotProp,
  type PropertyResult,
  type StateChangedEvent,
} from '@apocaliss92/nodedreame'
import type { IntegrationSessionSink, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type DreameConfig, settingsToDreameConfig } from '../config.js'
import { dreameFacades } from '../dreame-gateway.js'
import {
  type DreameFacadeLike,
  DreameIntegrationManager,
  type DreameManagedDevice,
  sameConnection,
} from '../dreame-integration-manager.js'

/** No-op logger satisfying IScopedLogger structurally (no cast). */
function fakeLogger(): IScopedLogger {
  const log: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
    withTags: () => log,
  }
  return log
}

interface SpyDevice extends DreameManagedDevice {
  /** props passed to every refreshCachedProperties (shadow seed) call. */
  readonly cachedCalls: MiotProp[][]
}

/** A device that records every shadow seed so tests can assert on it. */
function fakeDevice(): SpyDevice {
  const cachedCalls: MiotProp[][] = []
  return {
    cachedCalls,
    refreshCachedProperties: (props: MiotProp[]): Promise<PropertyResult[]> => {
      cachedCalls.push(props)
      return Promise.resolve([])
    },
  }
}

/** A facade exposing a fixed device list, satisfying DreameFacadeLike. */
function fakeFacade(devices: readonly DreameManagedDevice[]): DreameFacadeLike {
  return {
    login: () => Promise.resolve(),
    discoverDevices: () => Promise.resolve(devices),
    close: () => Promise.resolve(),
    devices,
    on: () => undefined,
  }
}

/** A facade backed by a real emitter so the pump's listeners can be counted. */
interface EmittingFacade extends DreameFacadeLike {
  emitState(deviceId: string): void
  stateListenerCount(): number
}

function emittingFacade(devices: readonly DreameManagedDevice[]): EmittingFacade {
  const emitter = new EventEmitter()
  function on(event: 'error', cb: (err: Error) => void): unknown
  function on(event: 'stateChanged', cb: (push: StateChangedEvent) => void): unknown
  function on(
    event: 'error' | 'stateChanged',
    cb: ((err: Error) => void) | ((push: StateChangedEvent) => void),
  ): unknown {
    return emitter.on(event, cb)
  }
  return {
    login: () => Promise.resolve(),
    discoverDevices: () => Promise.resolve(devices),
    close: () => Promise.resolve(),
    devices,
    on,
    emitState: (deviceId: string): void => {
      const push: StateChangedEvent = { deviceId, changes: [] }
      emitter.emit('stateChanged', push)
    },
    stateListenerCount: (): number => emitter.listenerCount('stateChanged'),
  }
}

function makeManager(
  config: DreameConfig,
  facade: DreameFacadeLike,
  id = 'b1',
  session?: IntegrationSessionSink,
): DreameIntegrationManager {
  return new DreameIntegrationManager({
    id,
    name: 'Account 1',
    connection: config,
    logger: fakeLogger(),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    makeFacade: () => facade,
    ...(session !== undefined ? { session } : {}),
  })
}

describe('DreameIntegrationManager catalog seed', () => {
  it('seeds the catalog from the cloud shadow once per device on start', async () => {
    const d1 = fakeDevice()
    const d2 = fakeDevice()
    const config = settingsToDreameConfig({ username: 'u', password: 'p' })
    const mgr = makeManager(config, fakeFacade([d1, d2]))

    await mgr.start()

    expect(d1.cachedCalls.length).toBe(1)
    expect(d2.cachedCalls.length).toBe(1)
    // The seed reads the full catalog (more than one prop coordinate).
    expect(d1.cachedCalls[0]?.length ?? 0).toBeGreaterThan(1)
  })

  it('does not re-seed after start (no background polling)', async () => {
    const d1 = fakeDevice()
    const config = settingsToDreameConfig({ username: 'u', password: 'p' })
    const mgr = makeManager(config, fakeFacade([d1]))

    await mgr.start()
    await mgr.stop()
    expect(d1.cachedCalls.length).toBe(1)
  })

  it('tolerates a per-device seed failure without rejecting start', async () => {
    const flaky: DreameManagedDevice = {
      refreshCachedProperties: () => Promise.reject(new Error('device offline')),
    }
    const config = settingsToDreameConfig({ username: 'u', password: 'p' })
    const mgr = makeManager(config, fakeFacade([flaky]))

    await expect(mgr.start()).resolves.toBeUndefined()
  })
})

describe('DreameIntegrationManager stateChanged fan-out pump', () => {
  it('pumps facade pushes into the shared bus — ONE facade listener for N children', async () => {
    const facade = emittingFacade([fakeDevice()])
    const config = settingsToDreameConfig({ username: 'u', password: 'p' })
    const mgr = makeManager(config, facade, 'pump-b1')

    // Subscribe MANY children (well past Node's default MaxListeners cap of
    // 10) BEFORE the facade connects — the latent case where a child
    // activating early previously never attached a live listener.
    const ticks: number[] = Array.from({ length: 30 }, () => 0)
    const unsubs = ticks.map((_, i) =>
      dreameFacades.onStateChanged('pump-b1', 'dev-1', () => {
        ticks[i] = (ticks[i] ?? 0) + 1
      }),
    )

    await mgr.start()
    facade.emitState('dev-1')
    facade.emitState('other-device')

    // Every child got exactly the one matching push...
    expect(ticks).toEqual(Array.from({ length: 30 }, () => 1))
    // ...through a SINGLE listener on the facade emitter (no MaxListeners).
    expect(facade.stateListenerCount()).toBe(1)

    for (const unsub of unsubs) unsub()
    await mgr.stop()
  })

  it('unsubscribed children receive nothing (teardown removes them)', async () => {
    const facade = emittingFacade([fakeDevice()])
    const config = settingsToDreameConfig({ username: 'u', password: 'p' })
    const mgr = makeManager(config, facade, 'pump-b2')
    await mgr.start()

    let calls = 0
    const unsub = dreameFacades.onStateChanged('pump-b2', 'dev-1', () => {
      calls += 1
    })
    unsub()
    facade.emitState('dev-1')

    expect(calls).toBe(0)
    await mgr.stop()
  })
})

describe('sameConnection', () => {
  it('treats a differing poll interval as a different connection', () => {
    const a = settingsToDreameConfig({ username: 'u', password: 'p', pollIntervalMs: 30_000 })
    const b = settingsToDreameConfig({ username: 'u', password: 'p', pollIntervalMs: 10_000 })
    expect(sameConnection(a, b)).toBe(false)
  })

  it('treats identical configs as the same connection', () => {
    const a = settingsToDreameConfig({ username: 'u', password: 'p' })
    const b = settingsToDreameConfig({ username: 'u', password: 'p' })
    expect(sameConnection(a, b)).toBe(true)
  })
})

describe('DreameIntegrationManager session reporting', () => {
  function recorder() {
    const calls: string[] = []
    const session: IntegrationSessionSink = {
      register: (id, name) => void calls.push(`register:${id}:${name}`),
      failure: (id, err) =>
        void calls.push(`failure:${id}:${err instanceof Error ? err.name : '?'}`),
      ok: async (id) => void calls.push(`ok:${id}`),
    }
    return { calls, session }
  }
  const config = settingsToDreameConfig({ username: 'u', password: 'p' })

  it('reports a rejected sign-in', async () => {
    const { calls, session } = recorder()
    const facade: DreameFacadeLike = {
      ...fakeFacade([]),
      login: () => Promise.reject(new DreameAuthError('bad credentials')),
    }
    const mgr = makeManager(config, facade, 'b1', session)
    await expect(mgr.start()).rejects.toThrow()
    expect(calls).toEqual(['register:b1:Account 1', 'failure:b1:DreameAuthError'])
  })

  it('reports a good sign-in as a restored session', async () => {
    const { calls, session } = recorder()
    const mgr = makeManager(config, fakeFacade([]), 'b1', session)
    await mgr.start()
    expect(calls).toEqual(['register:b1:Account 1', 'ok:b1'])
  })
})
