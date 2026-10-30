import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HmClientRegistry,
  START_RETRY_DELAYS_MS,
  type ManagerFactoryOptions,
  type ManagerLike,
} from '../homematic-client-registry.js'
import { homematicFacades } from '../homematic-facade-resolver.js'
import type { HomematicConfig } from '../config.js'
import { RecordingLogger } from './recording-logger.js'

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

interface FakeManager extends ManagerLike {
  readonly applied: HomematicConfig[]
  readonly stopCalls: () => number
}

/**
 * A manager stub: `failStarts` is how many `start()` calls reject before one
 * resolves. Tracks the live connection so `getConnection` follows `applyConnection`.
 */
function makeFake(opts: ManagerFactoryOptions, failStarts: { left: number }): FakeManager {
  let connection = opts.connection
  const applied: HomematicConfig[] = []
  let stops = 0
  return {
    applied,
    stopCalls: () => stops,
    start: vi.fn().mockImplementation(async () => {
      if (failStarts.left > 0) {
        failStarts.left -= 1
        throw new Error('connect ECONNREFUSED')
      }
      opts.onConnected(opts.id)
      opts.onStateChanged(opts.id)
    }),
    stop: vi.fn().mockImplementation(async () => {
      stops += 1
    }),
    applyConnection: vi.fn().mockImplementation(async (conn: HomematicConfig) => {
      applied.push(conn)
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

function setup(failStarts = 0) {
  const fails = { left: failStarts }
  const built: FakeManager[] = []
  const logger = new RecordingLogger()
  const lines = logger.lines
  const onConnected = vi.fn()
  const onDisconnected = vi.fn()
  const reg = new HmClientRegistry(logger, {
    onConnected,
    onDisconnected,
    makeManager: (opts) => {
      const fake = makeFake(opts, fails)
      built.push(fake)
      return fake
    },
  })
  return { reg, built, lines, onConnected, onDisconnected }
}

afterEach(() => {
  homematicFacades.clear()
})

describe('upsert', () => {
  it('starts one session per integration, keyed on the integration id', async () => {
    const { reg, onConnected } = setup()
    await reg.upsert('int-a', 'Casa', CONN)
    await reg.upsert('int-b', 'Studio', { ...CONN, host: 'h2' })
    expect(reg.list()).toEqual(['int-a', 'int-b'])
    expect(reg.getName('int-a')).toBe('Casa')
    expect(reg.getConnection('int-b')?.host).toBe('h2')
    expect(reg.connectedCount()).toBe(2)
    expect(onConnected).toHaveBeenCalledWith('int-a')
    expect(onConnected).toHaveBeenCalledWith('int-b')
  })

  it('publishes the session on the resolver and tells the devices about a state change', async () => {
    const { reg } = setup()
    let ticks = 0
    homematicFacades.onSnapshot('int-a', () => {
      ticks += 1
    })
    await reg.upsert('int-a', 'Casa', CONN)
    expect(homematicFacades.getSession('int-a')).not.toBeNull()
    expect(ticks).toBeGreaterThan(0)
  })

  it('reconnects with the new settings only when the CONNECTION changed', async () => {
    const { reg, built } = setup()
    await reg.upsert('int-a', 'Casa', CONN)
    await reg.upsert('int-a', 'Casa renamed', CONN)
    expect(built).toHaveLength(1)
    expect(built[0]?.applied).toEqual([])
    expect(reg.getName('int-a')).toBe('Casa renamed')

    await reg.upsert('int-a', 'Casa renamed', { ...CONN, host: 'newhost' })
    expect(built[0]?.applied).toEqual([{ ...CONN, host: 'newhost' }])
    expect(reg.getConnection('int-a')?.host).toBe('newhost')
  })

  it('never throws on a CCU that is down: it stays registered and logs the failure', async () => {
    const { reg, lines } = setup(1)
    await expect(reg.upsert('int-a', 'Casa', CONN)).resolves.toBeUndefined()
    expect(reg.has('int-a')).toBe(true)
    expect(reg.getManager('int-a')).toBeNull()
    expect(reg.connectedCount()).toBe(0)
    expect(homematicFacades.getSession('int-a')).toBeNull()
    expect(
      lines.some((l) => l.level === 'warn' && l.message.includes('session start failed')),
    ).toBe(true)
    await reg.shutdown()
  })

  it('a later upsert (the integration reconcile) rebuilds the session a failed start left behind', async () => {
    const { reg } = setup(1)
    await reg.upsert('int-a', 'Casa', CONN)
    expect(reg.getManager('int-a')).toBeNull()
    await reg.upsert('int-a', 'Casa', CONN)
    expect(reg.getManager('int-a')).not.toBeNull()
    expect(reg.connectedCount()).toBe(1)
    await reg.shutdown()
  })
})

describe('remove / retain / shutdown', () => {
  it('remove stops the session and clears the resolver', async () => {
    const { reg, built } = setup()
    await reg.upsert('int-a', 'Casa', CONN)
    await reg.remove('int-a')
    expect(reg.has('int-a')).toBe(false)
    expect(built[0]?.stopCalls()).toBe(1)
    expect(homematicFacades.getSession('int-a')).toBeNull()
    await expect(reg.remove('int-a')).resolves.toBeUndefined()
  })

  it('retain drops every session whose integration is gone', async () => {
    const { reg } = setup()
    await reg.upsert('int-a', 'A', CONN)
    await reg.upsert('int-b', 'B', CONN)
    await reg.retain(new Set(['int-b']))
    expect(reg.list()).toEqual(['int-b'])
  })

  it('shutdown stops every session', async () => {
    const { reg, built } = setup()
    await reg.upsert('int-a', 'A', CONN)
    await reg.upsert('int-b', 'B', CONN)
    await reg.shutdown()
    expect(reg.list()).toEqual([])
    expect(built.map((b) => b.stopCalls())).toEqual([1, 1])
  })
})

describe('start retry schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a failed start until it succeeds', async () => {
    const { reg } = setup(2)
    await reg.upsert('int-a', 'A', CONN)
    expect(reg.connectedCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(START_RETRY_DELAYS_MS[0] ?? 0)
    expect(reg.connectedCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(START_RETRY_DELAYS_MS[1] ?? 0)
    expect(reg.connectedCount()).toBe(1)
    await reg.shutdown()
  })

  it('warns once when the schedule is exhausted', async () => {
    const { reg, lines } = setup(100)
    await reg.upsert('int-a', 'A', CONN)
    for (const delay of START_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay)
    expect(lines.filter((l) => l.message.includes('start retries exhausted'))).toHaveLength(1)
    expect(reg.has('int-a')).toBe(true)
    await reg.shutdown()
  })

  it('cancels pending retries on shutdown', async () => {
    const { reg, built } = setup(100)
    await reg.upsert('int-a', 'A', CONN)
    const before = built.length
    await reg.shutdown()
    await vi.advanceTimersByTimeAsync((START_RETRY_DELAYS_MS[0] ?? 0) + 1_000)
    expect(built).toHaveLength(before)
  })
})
