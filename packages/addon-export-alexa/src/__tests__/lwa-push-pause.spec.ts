import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'
import { nextPausedState, pushRecheckDelayMs } from '../push-state.js'
import type { LwaPushState, LwaTokenEntry, UpsertLwaTokenInput } from '../types.js'

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  withTags: () => noopLogger,
} as unknown as LwaEventGatewayDeps['logger']

const BROKER = 'https://broker.example'
const MIN = 60_000

interface BrokerCall {
  readonly path: string
  readonly body: unknown
}

function response(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
  } as unknown as Response
}

function setup(initial: Partial<LwaTokenEntry> = {}) {
  let tokens: LwaTokenEntry[] = [
    {
      userId: 'userA',
      accessToken: 'old',
      expiresAt: Date.now() + 3_600_000,
      receivedAt: 0,
      brokerUrl: BROKER,
      brokerCredential: 'csb1.x.y',
      ...initial,
    },
  ]
  const brokerCalls: BrokerCall[] = []
  const gatewayCalls: string[] = []
  const pushStates: LwaPushState[] = []
  let gatewayStatus = 200
  let brokerAnswer: () => Response = () =>
    response(200, { accessToken: 'new', expiresAt: Date.now() + 3_600_000 })
  const fetchImpl: LwaEventGatewayDeps['fetchImpl'] = async (url, init) => {
    if (url.startsWith(BROKER)) {
      brokerCalls.push({
        path: url.slice(BROKER.length),
        body: JSON.parse(String(init.body ?? '{}')),
      })
      return brokerAnswer()
    }
    gatewayCalls.push(url)
    return response(gatewayStatus, {})
  }
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => fetchImpl(url, init))
  const deps: LwaEventGatewayDeps = {
    ctx: {
      eventBus: { subscribe: () => () => {} },
      api: {},
    } as unknown as LwaEventGatewayDeps['ctx'],
    logger: noopLogger,
    listExposed: () => [],
    listLinkedAccounts: () => [{ userId: 'userA', username: 'userA', linkedAt: 0 }],
    listTokens: () => tokens,
    upsertToken: async (input: UpsertLwaTokenInput) => {
      tokens = [{ ...input, receivedAt: Date.now() }]
    },
    setPushState: async (userId, push) => {
      pushStates.push(push)
      tokens = tokens.map((t) => (t.userId === userId ? { ...t, push } : t))
    },
    getAdvertisedBrokerUrl: () => null,
    getRegion: () => 'NA',
    getExportedSignature: () => null,
    accountMaySee: () => true,
    fetchImpl,
  }
  return {
    gw: new LwaEventGateway(deps),
    brokerCalls,
    gatewayCalls,
    pushStates,
    tokens: () => tokens,
    setGateway: (s: number) => {
      gatewayStatus = s
    },
    setBroker: (f: () => Response) => {
      brokerAnswer = f
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(1_000_000_000)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('push backoff', () => {
  it('climbs 1, 2, 5, 15, 30 then holds at 60 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map(pushRecheckDelayMs)).toEqual(
      [1, 2, 5, 15, 30, 60, 60, 60].map((m) => m * MIN),
    )
  })
  it('a repeat pause counts an attempt and keeps `since`', () => {
    const first = nextPausedState(undefined, 'grant-revoked', 100)
    const second = nextPausedState(first, 'grant-revoked', 200)
    expect(first.attempts).toBe(0)
    expect(second).toMatchObject({ attempts: 1, since: 100, nextCheckAt: 200 + 2 * MIN })
  })
})

describe('a refused push never removes the link', () => {
  it('gateway 403 pauses pushes (gateway-forbidden) and keeps the token entry', async () => {
    const t = setup()
    t.setGateway(403)
    expect(await t.gw.postReport('userA', () => ({}), 'x')).toBe(false)
    expect(t.pushStates).toHaveLength(1)
    expect(t.pushStates[0]).toMatchObject({ state: 'paused', reason: 'gateway-forbidden' })
    expect(t.tokens()).toHaveLength(1)
  })

  it('a paused account is skipped without calling the gateway', async () => {
    const t = setup({ push: nextPausedState(undefined, 'grant-revoked', Date.now()) })
    expect(await t.gw.postReport('userA', () => ({}), 'x')).toBe(false)
    expect(t.gatewayCalls).toHaveLength(0)
  })

  it('a 401 asks the broker to refresh NOW (reason=rejected), once per rejected token', async () => {
    const t = setup()
    t.setGateway(401)
    await t.gw.postReport('userA', () => ({}), 'x')
    expect(t.brokerCalls).toEqual([{ path: '/broker/token', body: { reason: 'rejected' } }])
    // the fresh token is rejected too: no second forced refresh for it
    await t.gw.postReport('userA', () => ({}), 'x')
    expect(t.brokerCalls).toHaveLength(2) // the new token 'new' is a new rejected token
    await t.gw.postReport('userA', () => ({}), 'x')
    expect(t.brokerCalls).toHaveLength(2) // same token again: not forced again
  })

  it('broker 410 (invalid_grant) pauses with grant-revoked, never removes', async () => {
    const t = setup()
    t.setGateway(401)
    t.setBroker(() => response(410, { error: 'grant_revoked' }))
    await t.gw.postReport('userA', () => ({}), 'x')
    expect(t.pushStates.at(-1)).toMatchObject({ state: 'paused', reason: 'grant-revoked' })
    expect(t.tokens()).toHaveLength(1)
  })

  it('broker 401 pauses with unauthorized', async () => {
    const t = setup()
    t.setGateway(401)
    t.setBroker(() => response(401, { error: 'invalid_credential' }))
    await t.gw.postReport('userA', () => ({}), 'x')
    expect(t.pushStates.at(-1)).toMatchObject({ state: 'paused', reason: 'unauthorized' })
  })
})

describe('re-check of a paused account', () => {
  it('waits for the persisted nextCheckAt, then asks the broker', async () => {
    const t = setup({ push: nextPausedState(undefined, 'grant-revoked', Date.now()) })
    t.setBroker(() => response(410, { error: 'grant_revoked' }))
    t.gw.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(t.brokerCalls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(t.brokerCalls).toEqual([{ path: '/broker/token', body: { reason: 'recheck' } }])
    t.gw.stop()
  })

  it('a refused re-check stays paused and backs off to the next step', async () => {
    const t = setup({ push: nextPausedState(undefined, 'grant-revoked', Date.now()) })
    t.setBroker(() => response(410, { error: 'grant_revoked' }))
    t.gw.start()
    await vi.advanceTimersByTimeAsync(61_000)
    t.gw.stop()
    const pushed = t.pushStates.at(-1)
    expect(pushed).toMatchObject({ state: 'paused', attempts: 1 })
    expect(t.tokens()).toHaveLength(1)
  })

  it('an unreachable broker also backs off instead of hammering every scan', async () => {
    const t = setup({ push: nextPausedState(undefined, 'unauthorized', Date.now()) })
    t.setBroker(() => response(503, { error: 'x' }))
    t.gw.start()
    await vi.advanceTimersByTimeAsync(61_000)
    await vi.advanceTimersByTimeAsync(60_000)
    t.gw.stop()
    expect(t.brokerCalls).toHaveLength(1)
  })

  it('a 200 clears the pause (the token is stored without a push flag)', async () => {
    const t = setup({ push: nextPausedState(undefined, 'grant-revoked', Date.now()) })
    t.gw.start()
    await vi.advanceTimersByTimeAsync(61_000)
    t.gw.stop()
    expect(t.tokens()[0]?.push).toBeUndefined()
    expect(t.tokens()[0]?.accessToken).toBe('new')
  })
})

describe('a gateway 403 that the broker cannot cure does not flap', () => {
  it('resume followed by a re-pause climbs the backoff instead of restarting at 1 minute', async () => {
    const t = setup()
    t.setGateway(403)
    await t.gw.postReport('userA', () => ({}), 'x')
    expect(t.pushStates.at(-1)).toMatchObject({ reason: 'gateway-forbidden', attempts: 0 })
    t.gw.start()
    // the broker answers 200 (Amazon token fine): the pause is lifted, the next push 403s again
    await vi.advanceTimersByTimeAsync(61_000)
    expect(t.tokens()[0]?.push).toBeUndefined()
    await t.gw.postReport('userA', () => ({}), 'x')
    const second = t.pushStates.at(-1)
    expect(second).toMatchObject({ state: 'paused', reason: 'gateway-forbidden', attempts: 1 })
    expect(second).toMatchObject({ nextCheckAt: Date.now() + 2 * MIN })
    await vi.advanceTimersByTimeAsync(3 * MIN)
    await t.gw.postReport('userA', () => ({}), 'x')
    t.gw.stop()
    expect(t.pushStates.at(-1)).toMatchObject({ attempts: 2 })
  })

  it('a push that succeeds ends the probation: the next 403 is a fresh 1 minute pause', async () => {
    const t = setup()
    t.setGateway(403)
    await t.gw.postReport('userA', () => ({}), 'x')
    t.gw.start()
    await vi.advanceTimersByTimeAsync(61_000)
    t.gw.stop()
    t.setGateway(200)
    expect(await t.gw.postReport('userA', () => ({}), 'x')).toBe(true)
    t.setGateway(403)
    await t.gw.postReport('userA', () => ({}), 'x')
    expect(t.pushStates.at(-1)).toMatchObject({ attempts: 0 })
  })
})
