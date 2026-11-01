import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { BrokerEcho } from '../speak/broker-echo.js'
import type { AlexaWorker } from '../speak/worker-client.js'
import { RateLimitedError, type WorkerRequest } from '../speak/worker-protocol.js'

function setup(onRequest: (request: WorkerRequest) => unknown) {
  let now = 1_000_000
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as IScopedLogger
  const worker = {
    request: vi.fn(async (request: WorkerRequest) => {
      if (request.op === 'login_broker') return { status: 'ok' }
      if (request.op === 'devices') return { devices: [] }
      return onRequest(request)
    }),
    noteSecrets: vi.fn(),
    stop: vi.fn(),
    failed: false,
  } as unknown as AlexaWorker
  const echo = new BrokerEcho({
    brokerId: 'b',
    brokerName: 'Home',
    domain: 'amazon.it',
    worker,
    readSeed: async () => ({ refreshToken: 't', deviceAppName: 'a' }),
    sessions: {
      get: async () => '',
      put: async () => {},
      delete: async () => {},
    },
    logger,
    now: () => now,
  })
  return { echo, advance: (ms: number) => void (now += ms), at: () => now }
}

describe('BrokerEcho media calls', () => {
  it('reads a player state through the worker', async () => {
    const { echo } = setup(() => ({ playerInfo: { state: 'PLAYING' } }))
    expect(await echo.playerState('s', 'T')).toMatchObject({
      state: 'PLAYING',
    })
    expect(echo.rateLimitedUntil).toBeNull()
  })

  it('a 429 doubles the back-off up to 5 minutes, is surfaced, and rethrown (never empty)', async () => {
    let limited = true
    const { echo, advance, at } = setup(() => {
      if (limited) throw new RateLimitedError('429')
      return { playerInfo: {} }
    })
    await expect(echo.playerState('s', 'T')).rejects.toBeInstanceOf(RateLimitedError)
    expect(echo.rateLimitedUntil).toBe(at() + 30_000)
    await expect(echo.playerState('s', 'T')).rejects.toBeInstanceOf(RateLimitedError)
    expect(echo.rateLimitedUntil).toBe(at() + 60_000)
    for (let i = 0; i < 6; i++) await echo.playerState('s', 'T').catch(() => undefined)
    expect(echo.rateLimitedUntil).toBe(at() + 300_000)
    limited = false
    await echo.playerState('s', 'T')
    expect(echo.rateLimitedUntil).toBeNull()
    advance(1)
  })

  it('a pause that has elapsed is no longer reported', async () => {
    const { echo, advance } = setup(() => {
      throw new RateLimitedError('429')
    })
    await echo.playerState('s', 'T').catch(() => undefined)
    expect(echo.rateLimitedUntil).not.toBeNull()
    advance(30_001)
    expect(echo.rateLimitedUntil).toBeNull()
  })
})
