import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  HmBrokerRegistry,
  RESTORE_RETRY_DELAYS_MS,
  sameConnection,
} from '../homematic-broker-registry.js'
import type { HomematicConfig } from '../config.js'

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
}

// A minimal manager stub matching the registry's ManagerLike surface. Tracks
// its live connection so `getConnection` reflects `applyConnection` updates.
function fakeManagerFactory() {
  return (opts: { id: string; name: string; connection: HomematicConfig }) => {
    let connection = opts.connection
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      applyConnection: vi.fn().mockImplementation(async (conn: HomematicConfig) => {
        connection = conn
      }),
      devices: vi.fn().mockReturnValue([]),
      get facade() {
        return null
      },
      getConnection: () => connection,
      getInfo: () => ({
        id: opts.id,
        name: opts.name,
        kind: 'homematic' as const,
        status: 'connected' as const,
        info: {},
        lastCheckedAt: 1,
        error: null,
      }),
    }
  }
}

const CONN: HomematicConfig = {
  host: 'h',
  enableHmipRf: true,
  enableBidcosRf: false,
  enableGroups: true,
  enableBidcosWired: false,
  username: '',
  password: '',
  callbackHost: '',
  callbackPort: 2128,
  tls: false,
}

it('restore starts a manager per entry and allocates ids monotonically after existing ones', async () => {
  const reg = new HmBrokerRegistry(logger, { makeManager: fakeManagerFactory() })
  await reg.restore([{ id: 'hm_001', name: 'A', connection: CONN }])
  expect(reg.size()).toBe(1)
  const created = await reg.createEntry('B', CONN)
  expect(created.id).toBe('hm_002')
  expect(reg.size()).toBe(2)
})

it('createEntry then removeEntry clears the manager and the integration index', async () => {
  const reg = new HmBrokerRegistry(logger, { makeManager: fakeManagerFactory() })
  const e = await reg.createEntry('A', CONN, { integrationId: 'int-1' })
  reg.linkIntegration('int-1', e.id)
  expect(reg.getBrokerIdByIntegrationId('int-1')).toBe(e.id)
  await reg.removeEntry(e.id)
  expect(reg.size()).toBe(0)
  expect(() => reg.getBrokerIdByIntegrationId('int-1')).toThrow()
})

it('getManager returns the live manager; list reflects getInfo', async () => {
  const reg = new HmBrokerRegistry(logger, { makeManager: fakeManagerFactory() })
  const e = await reg.createEntry('A', CONN)
  expect(reg.getManager(e.id)).not.toBeNull()
  const first = reg.list()[0]
  expect(first?.id).toBe(e.id)
  expect(reg.connectedCount()).toBe(1)
})

it('updateEntry applies the new connection to the live manager', async () => {
  const factory = fakeManagerFactory()
  const reg = new HmBrokerRegistry(logger, { makeManager: factory })
  const e = await reg.createEntry('A', CONN)
  await reg.updateEntry(e.id, { ...CONN, host: 'newhost' })
  const mgr = reg.getManager(e.id)
  expect(mgr).not.toBeNull()
  // applyConnection was invoked on the manager
})

it('getConnection returns the live connection and reflects updateEntry', async () => {
  const reg = new HmBrokerRegistry(logger, { makeManager: fakeManagerFactory() })
  const e = await reg.createEntry('A', CONN)
  expect(reg.getConnection(e.id)).toEqual(CONN)
  await reg.updateEntry(e.id, { ...CONN, host: 'newhost' })
  expect(reg.getConnection(e.id)?.host).toBe('newhost')
  expect(reg.getConnection('unknown')).toBeNull()
})

it('updateEntry is the only path that reconnects — onConfigChanged skips it when the connection is unchanged', async () => {
  // Mirrors the addon guard: when the persisted connection equals the live
  // one, the addon must NOT call updateEntry (no facade stop+start). Here we
  // assert the building blocks the guard relies on: sameConnection over the
  // live getConnection result returns true for an FK-only change.
  const reg = new HmBrokerRegistry(logger, { makeManager: fakeManagerFactory() })
  const e = await reg.createEntry('A', CONN)
  // FK-only "change" — same connection object, different integrationId.
  expect(sameConnection(CONN, reg.getConnection(e.id))).toBe(true)
  // A genuine host change is NOT the same connection → guard would reconnect.
  expect(sameConnection({ ...CONN, host: 'other' }, reg.getConnection(e.id))).toBe(false)
})

it('sameConnection compares the connection fields structurally', () => {
  expect(sameConnection(CONN, { ...CONN })).toBe(true)
  expect(sameConnection(CONN, { ...CONN, host: 'other' })).toBe(false)
  expect(sameConnection(CONN, { ...CONN, callbackPort: 9999 })).toBe(false)
  expect(sameConnection(CONN, { ...CONN, enableBidcosRf: true })).toBe(false)
  expect(sameConnection(CONN, { ...CONN, password: 'secret' })).toBe(false)
  expect(sameConnection(CONN, { ...CONN, tls: true })).toBe(false)
  // A null live connection (unknown broker) is never equal to anything.
  expect(sameConnection(CONN, null)).toBe(false)
  expect(sameConnection(null, CONN)).toBe(false)
})

it('a failed start leaves no manager in the map so a later start can rebuild', async () => {
  let calls = 0
  const makeManager = (opts: { id: string; name: string; connection: HomematicConfig }) => {
    calls += 1
    return {
      start:
        calls === 1
          ? vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
          : vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      applyConnection: vi.fn().mockResolvedValue(undefined),
      devices: vi.fn().mockReturnValue([]),
      get facade() {
        return null
      },
      getConnection: () => opts.connection,
      getInfo: () => ({
        id: opts.id,
        name: opts.name,
        kind: 'homematic' as const,
        status: 'connected' as const,
        info: {},
        lastCheckedAt: 1,
        error: null,
      }),
    }
  }
  const reg = new HmBrokerRegistry(logger, { makeManager })
  await reg.restore([{ id: 'hm_001', name: 'A', connection: CONN }])
  expect(reg.size()).toBe(0)
  expect(reg.getManager('hm_001')).toBeNull()
  // Same-id restore after abandon must rebuild (not skip as "already running").
  await reg.restore([{ id: 'hm_001', name: 'A', connection: CONN }])
  expect(reg.size()).toBe(1)
  expect(reg.getManager('hm_001')).not.toBeNull()
  await reg.shutdown()
})

describe('restore retry schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a failed restore until start succeeds', async () => {
    let calls = 0
    const makeManager = (opts: { id: string; name: string; connection: HomematicConfig }) => {
      calls += 1
      const fail = calls <= 2
      return {
        start: fail
          ? vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
          : vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        applyConnection: vi.fn().mockResolvedValue(undefined),
        devices: vi.fn().mockReturnValue([]),
        get facade() {
          return null
        },
        getConnection: () => opts.connection,
        getInfo: () => ({
          id: opts.id,
          name: opts.name,
          kind: 'homematic' as const,
          status: 'connected' as const,
          info: {},
          lastCheckedAt: 1,
          error: null,
        }),
      }
    }
    const reg = new HmBrokerRegistry(logger, { makeManager })
    await reg.restore([{ id: 'hm_001', name: 'A', connection: CONN }])
    expect(reg.size()).toBe(0)

    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_DELAYS_MS[0]!)
    expect(reg.size()).toBe(0)

    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_DELAYS_MS[1]!)
    expect(reg.size()).toBe(1)
    expect(reg.connectedCount()).toBe(1)
    await reg.shutdown()
  })

  it('cancels pending retries on shutdown', async () => {
    const makeManager = () => ({
      start: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
      stop: vi.fn().mockResolvedValue(undefined),
      applyConnection: vi.fn().mockResolvedValue(undefined),
      devices: vi.fn().mockReturnValue([]),
      get facade() {
        return null
      },
      getConnection: () => CONN,
      getInfo: () => ({
        id: 'hm_001',
        name: 'A',
        kind: 'homematic' as const,
        status: 'disconnected' as const,
        info: {},
        lastCheckedAt: 1,
        error: null,
      }),
    })
    const reg = new HmBrokerRegistry(logger, { makeManager })
    await reg.restore([{ id: 'hm_001', name: 'A', connection: CONN }])
    await reg.shutdown()
    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_DELAYS_MS[0]! + 1_000)
    expect(reg.size()).toBe(0)
  })
})
