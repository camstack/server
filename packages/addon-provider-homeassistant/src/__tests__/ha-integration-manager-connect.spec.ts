import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'

/**
 * Non-blocking connect contract for the HA broker lifecycle.
 *
 * Regression guard for the integration-creation hang cluster: a broker
 * pointing at an unreachable / dead HA host must NOT block `start()` (and
 * therefore `broker.add` → the wizard spinner) nor `HaBrokerRegistry.restore()`
 * on addon boot. The connection is fired in the background; a failed connect
 * becomes an observable `unreachable` / `auth-failed` status carrying a
 * human-readable error (never the library's bare numeric code).
 */

// Controllable `createConnection`: each call parks on a fresh deferred the
// test can resolve / reject to drive the manager's status transitions.
interface ConnectControl {
  calls: number
  reject: ((reason: unknown) => void) | null
  resolve: ((conn: unknown) => void) | null
}
const connectControl: ConnectControl = { calls: 0, reject: null, resolve: null }

vi.mock('home-assistant-js-websocket', async (importActual) => {
  const actual = await importActual<typeof import('home-assistant-js-websocket')>()
  return {
    ...actual,
    createConnection: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          connectControl.calls += 1
          connectControl.resolve = resolve
          connectControl.reject = reject
        }),
    ),
    createLongLivedTokenAuth: vi.fn((baseUrl: string, accessToken: string) => ({
      wsUrl: `${baseUrl.replace(/^http/, 'ws')}/api/websocket`,
      accessToken,
      expired: false,
      refreshAccessToken: async () => {},
    })),
  }
})

// Imported AFTER the mock is declared (vi.mock is hoisted). ERR_* survive via
// the `...actual` spread, so the real numeric codes flow through.
import { HaIntegrationManager } from '../ha-integration-manager.js'
import { HaBrokerRegistry } from '../ha-broker-registry.js'
import { ERR_CANNOT_CONNECT, ERR_INVALID_AUTH } from 'home-assistant-js-websocket'

function buildNoopLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function buildNoopEventBus(): IEventBus {
  return {
    emit() {},
    subscribe: () => () => {},
    getRecent: (): readonly SystemEvent[] => [],
  }
}

function buildManager(): HaIntegrationManager {
  return new HaIntegrationManager({
    id: 'ha_001',
    name: 'Ghost',
    auth: { kind: 'long-lived', baseUrl: 'http://192.168.10.250:8123', accessToken: 'throwaway' },
    logger: buildNoopLogger(),
    eventBus: buildNoopEventBus(),
  })
}

// Let queued microtasks (the background connect's .catch) settle.
const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  connectControl.calls = 0
  connectControl.reject = null
  connectControl.resolve = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('HaIntegrationManager — non-blocking connect', () => {
  it('start() resolves promptly even while the connection is still pending', async () => {
    const mgr = buildManager()
    // A resolved promise means we did NOT block on the (never-resolving) connect.
    await mgr.start()
    expect(connectControl.calls).toBe(1)
    expect(mgr.getInfo().status).toBe('connecting')
  })

  it('classifies a rejected connect as unreachable with a readable error', async () => {
    const mgr = buildManager()
    await mgr.start()
    connectControl.reject?.(ERR_CANNOT_CONNECT)
    await flush()
    const info = mgr.getInfo()
    expect(info.status).toBe('unreachable')
    expect(info.error).toBeTruthy()
    // NOT the bare numeric library code (ERR_CANNOT_CONNECT === 1).
    expect(info.error).not.toBe('1')
    expect(info.error).toMatch(/connect/i)
  })

  it('classifies an auth rejection as auth-failed with a readable error', async () => {
    const mgr = buildManager()
    await mgr.start()
    connectControl.reject?.(ERR_INVALID_AUTH)
    await flush()
    const info = mgr.getInfo()
    expect(info.status).toBe('auth-failed')
    expect(info.error).not.toBe('2')
    expect(info.error).toMatch(/auth/i)
  })

  it('flips a stuck "connecting" broker to unreachable after the connect deadline', async () => {
    vi.useFakeTimers()
    const mgr = buildManager()
    await mgr.start()
    expect(mgr.getInfo().status).toBe('connecting')
    // Never resolve/reject the connect — only the deadline can move it.
    await vi.advanceTimersByTimeAsync(10_001)
    expect(mgr.getInfo().status).toBe('unreachable')
  })
})

describe('HaBrokerRegistry — createEntry does not block on the connection', () => {
  it('resolves + registers a broker in "connecting" without awaiting connect', async () => {
    const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
    // With the real (blocking) code this would hang on the dead host; the
    // non-blocking start makes it return immediately with the entry persisted.
    const entry = await registry.createEntry('Ghost', {
      baseUrl: 'http://192.168.10.250:8123',
      accessToken: 'throwaway',
    })
    expect(entry.id).toMatch(/^ha_/)
    expect(registry.get(entry.id)?.status).toBe('connecting')
    await registry.shutdown()
  })
})
