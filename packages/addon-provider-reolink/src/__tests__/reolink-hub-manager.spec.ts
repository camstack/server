/**
 * D985 — the per-integration hub session manager: the one place that turns the integration list
 * into sessions, and the registry a camera reaches its session through.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { readHubConnection } from '../hub-connection.js'
import { type HubIntegrationConnection, ReolinkHubManager } from '../reolink-hub-manager.js'
import { type HubApiPort, ReolinkHubSession, ReolinkHubSessions } from '../reolink-hub-session.js'

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

function fakeApi(): HubApiPort {
  return {
    login: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    getNvrChannelsSummary: vi.fn(async () => ({ devices: [], channels: [] })),
    getAllChannelsBatteryInfo: vi.fn(async () => ({ batteryInfoData: {} })),
    reboot: vi.fn(async () => undefined),
    onSimpleEvent: vi.fn(async () => undefined),
    offSimpleEvent: vi.fn(async () => undefined),
    client: {
      isSocketConnected: vi.fn(() => true),
      loggedIn: true,
      on: vi.fn(),
      off: vi.fn(),
      prependListener: vi.fn(),
    },
  }
}

function setup() {
  const children = new ReolinkHubSessions()
  const published = new Map<string, ReolinkHubSession<HubApiPort>>()
  const registry = { get: (id: string) => published.get(id) ?? null }
  const connect = vi.fn(async () => fakeApi())
  const manager = new ReolinkHubManager<HubApiPort>({
    logger: logger(),
    childrenOf: (id) => children.childrenOf(id),
    publish: (id, session) => {
      if (session === null) published.delete(id)
      else published.set(id, session)
    },
    connect,
    onConnectionChange: vi.fn(),
  })
  return { manager, registry, connect }
}

/** One integration as the addon hands it over: what its connection record says about its hub. */
function integration(
  id: string,
  name: string,
  settings: Readonly<Record<string, unknown>>,
): HubIntegrationConnection {
  return { id, name, read: readHubConnection(settings) }
}

const NVR = integration('int-1', 'Hub', { host: '10.0.0.5', password: 'pw' })

describe('ReolinkHubManager', () => {
  it('starts one session per NVR integration and publishes it to the registry', async () => {
    const { manager, registry } = setup()
    await manager.reconcile([
      NVR,
      integration('int-2', 'Other', { host: '10.0.0.6', password: 'x' }),
    ])
    expect(manager.list()).toEqual(['int-1', 'int-2'])
    expect(registry.get('int-1')).not.toBeNull()
    expect(registry.get('int-1')?.relayEndpoint().host).toBe('10.0.0.5')
    expect(registry.get('int-2')?.relayEndpoint().host).toBe('10.0.0.6')
    await manager.shutdown()
  })

  it('gives the default integration (no host) no session', async () => {
    const { manager } = setup()
    await manager.reconcile([integration('default', 'Reolink', {})])
    expect(manager.list()).toEqual([])
  })

  it('does not start a session on a locked or missing password, and leaves a running one alone', async () => {
    const { manager } = setup()
    await manager.reconcile([NVR])
    await manager.reconcile([{ ...NVR, read: { kind: 'password-locked' } }])
    expect(manager.get('int-1')?.connection.password).toBe('pw')
    const fresh = setup()
    await fresh.manager.reconcile([integration('int-1', 'Hub', { host: '10.0.0.5' })])
    expect(fresh.manager.list()).toEqual([])
    await manager.shutdown()
  })

  it('re-dials on a changed connection and keeps the session object', async () => {
    const { manager } = setup()
    await manager.reconcile([NVR])
    const before = manager.get('int-1')
    await manager.reconcile([
      integration('int-1', 'Hub', { host: '10.0.0.5', password: 'rotated' }),
    ])
    expect(manager.get('int-1')).toBe(before)
    expect(manager.get('int-1')?.connection.password).toBe('rotated')
    await manager.shutdown()
  })

  it('closes and unpublishes a session whose integration vanished', async () => {
    const { manager, registry } = setup()
    await manager.reconcile([NVR])
    await manager.reconcile([])
    expect(manager.list()).toEqual([])
    expect(registry.get('int-1')).toBeNull()
  })
})
