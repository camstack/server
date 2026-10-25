/**
 * The TRANSPORT census: three planes, path parsing (batch included),
 * aggregation, and the one property that decides whether this may exist on the
 * request path at all - DISARMED IT TOUCHES NOTHING.
 *
 * One spec, extended, rather than a second one per plane: the invariant these
 * tests exist to protect is that the planes SUM to the total, and an invariant
 * split across two files is an invariant neither file states.
 *
 * ## The neutralisation for each load-bearing test
 *
 * A green suite is not proof. Each of these fails for the right reason when the
 * fix is removed:
 *
 *  - *"a comma without `batch=1` is ONE procedure"* — make `parseTrpcProcedures`
 *    split unconditionally and it reports two, over-counting every path that
 *    contains a comma.
 *  - *"a batched request counts every procedure"* — return `[decoded]` and the
 *    batched call counts 1 instead of 3, which is the direction that CLEARS an
 *    innocent transport.
 *  - *"disarmed, the request is never touched"* — move the `census.armed` guard
 *    in `recordTrpcHttpRequest` below any field access and the hostile request
 *    throws. This is the test that would have caught a diagnostic quietly
 *    costing a header read on all 41 requests/second.
 *  - *"disarmed, the WS FRAME is never touched"* — same shape, one plane over:
 *    move the guard in `WsCensusSession.observeMessage` below the `toString()`
 *    and the hostile frame throws.
 *  - *"per-procedure totals survive the group bound"* — drop the
 *    `unattributedCalls` branch and the totals no longer add up, which is
 *    exactly the number the negative conclusion rests on.
 *  - *"a WS frame is counted per OPERATION"* — count per connection instead
 *    (which is what the code did until 2026-08-27) and a socket that sent 4
 *    queries reports 1.
 *  - *"a subscription is not a call"* — fold `kind: 'subscription'` into the
 *    call branch and one long-lived stream inflates `procedureCalls`, which is
 *    the misreading that makes a quiet plane look like the storm.
 *  - *"the planes sum to the total"* — attribute an observation to no plane and
 *    `planesExplainTotal` goes false, which is the acceptance criterion.
 */

import { describe, expect, it, vi } from 'vitest'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import type { IScopedLogger } from '@camstack/types'
import type { ClientRequest } from '../client-ip.js'
import {
  BATCH_OVERFLOW_PROCEDURE,
  HttpRequestCensus,
  MAX_BATCH_PROCEDURES,
  MAX_GROUPS,
  MAX_WINDOW_MS,
  MIN_REPORT_EVERY_MS,
  parseTrpcProcedures,
  type RequestCensusObservation,
  shortenUserAgent,
  UNKNOWN,
} from '../http-request-census.js'
import { recordTrpcHttpRequest } from '../http-request-census-hook.js'
import type { AuthenticatedAgent } from '../trpc.context.js'
import {
  attachWsCensusSession,
  identifyWsCensusSession,
  MAX_PENDING_WS_OPERATIONS,
  parseTrpcWsFrame,
  WS_PATHLESS_PROCEDURE,
  type WsCensusClient,
} from '../ws-request-census.js'

// ── helpers ─────────────────────────────────────────────────────────────────

/** A census on a hand-driven clock and a hand-driven scheduler. */
function makeCensus(): {
  census: HttpRequestCensus
  advance: (ms: number) => void
  runPendingTimers: () => void
  pending: () => number
} {
  let now = 1_000_000
  const timers: { fn: () => void; at: number }[] = []
  const census = new HttpRequestCensus({
    now: () => now,
    schedule: (fn, ms) => {
      timers.push({ fn, at: now + ms })
    },
  })
  return {
    census,
    advance: (ms) => {
      now += ms
    },
    runPendingTimers: () => {
      // One pass: a tick that reschedules must not spin forever here.
      const due = timers.splice(0, timers.length).filter((t) => t.at <= now)
      for (const timer of due) timer.fn()
    },
    pending: () => timers.length,
  }
}

function observation(over: Partial<RequestCensusObservation> = {}): RequestCensusObservation {
  return {
    procedures: ['deviceManager.listAll'],
    userAgent: 'camstack-viewer/1.0',
    ip: '192.168.10.10',
    principal: 'apocaliss92 (admin)',
    ...over,
  }
}

/** A request whose every field is a getter that THROWS. Reading anything off
 *  it is a test failure, which is what makes the disarmed-cost claim real. */
function hostileRequest(): ClientRequest {
  const req = {}
  for (const field of ['url', 'headers', 'ip', 'socket', 'method']) {
    Object.defineProperty(req, field, {
      get() {
        throw new Error(`disarmed census read request.${field}`)
      },
    })
  }
  // The union is `FastifyRequest | IncomingMessage`; this stand-in satisfies
  // neither structurally on purpose - it exists to be untouched.
  return req as unknown as ClientRequest
}

function plainRequest(url: string, headers: Record<string, string> = {}): ClientRequest {
  return { url, headers, socket: { remoteAddress: '10.0.0.7' } } as unknown as ClientRequest
}

/** A tRPC WS operation frame, as `wsLink` puts it on the wire. */
function wsFrame(id: number, method: 'query' | 'mutation' | 'subscription', path: string): string {
  return JSON.stringify({ id, jsonrpc: '2.0', method, params: { path, input: {} } })
}

interface FakeWsClient extends WsCensusClient {
  send(frame: unknown): void
  disconnect(): void
}

/** A socket that only does what the census needs: deliver frames and close. */
function fakeWsClient(): FakeWsClient {
  const onMessage: ((data: unknown, isBinary: boolean) => void)[] = []
  const onClose: (() => void)[] = []
  const client: FakeWsClient = {
    on: (event, listener) => {
      if (event === 'message') onMessage.push(listener)
      return client
    },
    once: (event, listener) => {
      if (event === 'close') onClose.push(listener)
      return client
    },
    send: (frame) => {
      for (const listener of onMessage) listener(frame, false)
    },
    disconnect: () => {
      for (const listener of onClose) listener()
    },
  }
  return client
}

/** The WS upgrade request the session derives ip + user-agent from. */
function upgradeRequest(userAgent = 'camstack-viewer/1.0'): IncomingMessage {
  // A real IncomingMessage (what the WS adapter hands over), not a cast shape.
  const socket = new Socket()
  Object.defineProperty(socket, 'remoteAddress', { value: '192.168.10.44' })
  const req = new IncomingMessage(socket)
  req.url = '/trpc?connectionParams=1'
  req.headers = { 'user-agent': userAgent }
  return req
}

/**
 * A frame that LOOKS like every real one — `Buffer.isBuffer` is true — and
 * explodes the instant anything decodes it. Reading it at all is a failure.
 */
function hostileFrame(): Buffer {
  const buffer = Buffer.from(wsFrame(1, 'query', 'deviceManager.listAll'))
  Object.defineProperty(buffer, 'toString', {
    value: (): string => {
      throw new Error('disarmed census decoded the ws frame')
    },
  })
  return buffer
}

// ── path parsing ────────────────────────────────────────────────────────────

/** A complete logger whose `info` is the spy a test reads. */
function loggerWithInfo(info: IScopedLogger['info']): IScopedLogger {
  const logger: IScopedLogger = {
    info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

describe('parseTrpcProcedures', () => {
  it('reads a single procedure off a non-batched GET', () => {
    expect(parseTrpcProcedures('/trpc/deviceManager.listAll?input=%7B%7D')).toEqual([
      'deviceManager.listAll',
    ])
  })

  it('splits a BATCHED request into one call per procedure', () => {
    expect(
      parseTrpcProcedures(
        '/trpc/deviceManager.listAll,camera.list,system.health?batch=1&input=%7B%7D',
      ),
    ).toEqual(['deviceManager.listAll', 'camera.list', 'system.health'])
  })

  it('does NOT split a comma when `batch=1` is absent - that is one procedure', () => {
    // tRPC only splits under `batch=1`. Splitting unconditionally would invent
    // calls that never happened.
    expect(parseTrpcProcedures('/trpc/weird.name,with.comma?input=%7B%7D')).toEqual([
      'weird.name,with.comma',
    ])
  })

  it('decodes a percent-encoded batch separator before splitting', () => {
    expect(parseTrpcProcedures('/trpc/a.one%2Cb.two?batch=1')).toEqual(['a.one', 'b.two'])
  })

  it('ignores `batch=1` for content types tRPC never batches', () => {
    // `multipart/form-data` and `application/octet-stream` hard-code
    // isBatchCall:false in the adapter, whatever the query string says.
    expect(parseTrpcProcedures('/trpc/a,b?batch=1', 'multipart/form-data; boundary=x')).toEqual([
      'a,b',
    ])
    expect(parseTrpcProcedures('/trpc/a,b?batch=1', 'application/octet-stream')).toEqual(['a,b'])
    expect(parseTrpcProcedures('/trpc/a,b?batch=1', 'application/json')).toEqual(['a', 'b'])
  })

  it('is not fooled by a `batch=11` or a `nobatch=1` parameter', () => {
    expect(parseTrpcProcedures('/trpc/a,b?batch=11')).toEqual(['a,b'])
    expect(parseTrpcProcedures('/trpc/a,b?nobatch=1')).toEqual(['a,b'])
    expect(parseTrpcProcedures('/trpc/a,b?input=1&batch=1')).toEqual(['a', 'b'])
  })

  it('returns nothing for a non-tRPC URL or a bare prefix', () => {
    expect(parseTrpcProcedures('/api/addon-pages/x/y.js')).toEqual([])
    expect(parseTrpcProcedures('/trpc/')).toEqual([])
    expect(parseTrpcProcedures('/trpcx/foo')).toEqual([])
  })

  it('keeps a malformed percent-escape as raw text rather than dropping the request', () => {
    // A dropped request is a hole in the total the negative conclusion rests on.
    expect(parseTrpcProcedures('/trpc/broken%E0%A4?input=1')).toEqual(['broken%E0%A4'])
  })

  it('drops empty batch entries and marks an oversized batch instead of growing', () => {
    expect(parseTrpcProcedures('/trpc/a,,b,?batch=1')).toEqual(['a', 'b'])
    const huge = Array.from({ length: MAX_BATCH_PROCEDURES + 5 }, (_, i) => `p${i}`).join(',')
    const parsed = parseTrpcProcedures(`/trpc/${huge}?batch=1`)
    expect(parsed.length).toBe(MAX_BATCH_PROCEDURES + 1)
    expect(parsed[parsed.length - 1]).toBe(BATCH_OVERFLOW_PROCEDURE)
  })
})

describe('shortenUserAgent', () => {
  it('renders a missing or blank user-agent as a named unknown, never as blank', () => {
    expect(shortenUserAgent(null)).toBe(UNKNOWN)
    expect(shortenUserAgent('   ')).toBe(UNKNOWN)
  })

  it('truncates a long user-agent so one client is one row', () => {
    const long = `Mozilla/5.0 ${'x'.repeat(300)}`
    expect(shortenUserAgent(long).length).toBeLessThan(long.length)
  })
})

// ── aggregation ─────────────────────────────────────────────────────────────

describe('HttpRequestCensus aggregation', () => {
  it('groups by (procedure, user-agent, ip, principal)', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    census.observeHttpRequest(observation())
    census.observeHttpRequest(observation())
    census.observeHttpRequest(observation({ principal: 'anonymous' }))
    census.observeHttpRequest(observation({ ip: '10.9.9.9' }))
    census.observeHttpRequest(observation({ userAgent: 'admin-ui/2' }))

    const snap = census.snapshot()
    expect(snap.distinctGroups).toBe(4)
    const busiest = snap.groups[0]
    expect(busiest?.calls).toBe(2)
    expect(busiest?.principal).toBe('apocaliss92 (admin)')
    expect(busiest?.ip).toBe('192.168.10.10')
  })

  it('counts EVERY procedure of a batched request, and says it was batched', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    census.observeHttpRequest(
      observation({ procedures: ['deviceManager.listAll', 'camera.list', 'system.health'] }),
    )
    census.observeHttpRequest(observation({ procedures: ['deviceManager.listAll'] }))

    const snap = census.snapshot()
    expect(snap.httpRequests).toBe(2)
    expect(snap.batchedRequests).toBe(1)
    // 3 + 1: counting the batch as one request would report 2 and clear the
    // transport that actually made four calls.
    expect(snap.procedureCalls).toBe(4)
  })

  it('reports a per-procedure TOTAL that sums every caller group', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    census.observeHttpRequest(observation({ ip: '10.0.0.1' }))
    census.observeHttpRequest(observation({ ip: '10.0.0.2' }))
    census.observeHttpRequest(observation({ ip: '10.0.0.3', procedures: ['camera.list'] }))

    const snap = census.snapshot()
    const listAll = snap.procedures.find((p) => p.procedure === 'deviceManager.listAll')
    expect(listAll?.calls).toBe(2)
    expect(snap.procedures.find((p) => p.procedure === 'camera.list')?.calls).toBe(1)
  })

  it('extrapolates a per-minute rate off the elapsed window', () => {
    const { census, advance } = makeCensus()
    census.arm(600_000)
    for (let i = 0; i < 30; i += 1) census.observeHttpRequest(observation())
    advance(60_000)
    const snap = census.snapshot()
    expect(snap.elapsedMs).toBe(60_000)
    expect(snap.procedures[0]?.perMin).toBe(30)
  })

  it('keeps the TOTALS exact when the group bound sheds attribution', () => {
    const { census } = makeCensus()
    census.arm(600_000)
    const total = MAX_GROUPS + 25
    for (let i = 0; i < total; i += 1) {
      census.observeHttpRequest(observation({ ip: `10.1.${Math.floor(i / 250)}.${i % 250}` }))
    }
    const snap = census.snapshot()
    expect(snap.distinctGroups).toBe(MAX_GROUPS)
    expect(snap.unattributedCalls).toBe(25)
    // The number the conclusion rests on is still the truth.
    expect(snap.procedureCalls).toBe(total)
    expect(snap.procedures.find((p) => p.procedure === 'deviceManager.listAll')?.calls).toBe(total)
  })

  it('renders a missing ip as a named unknown', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    census.observeHttpRequest(observation({ ip: null, userAgent: null }))
    const group = census.snapshot().groups[0]
    expect(group?.ip).toBe(UNKNOWN)
    expect(group?.userAgent).toBe(UNKNOWN)
  })

  it('ignores an observation with no procedures', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    census.observeHttpRequest(observation({ procedures: [] }))
    expect(census.snapshot().httpRequests).toBe(0)
  })
})

// ── the WS wire format, mirrored from the adapter ────────────────────────────

describe('parseTrpcWsFrame', () => {
  it('reads one query off a single frame', () => {
    expect(parseTrpcWsFrame(wsFrame(1, 'query', 'deviceManager.listAll'))).toEqual({
      calls: ['deviceManager.listAll'],
      subscriptions: [],
      stops: 0,
    })
  })

  it('counts EVERY message of a batched frame - `wsLink` sends an array', () => {
    // Counting an array as one call undercounts by the batch factor, which is
    // the direction that clears an innocent transport.
    const batch = `[${wsFrame(1, 'query', 'a.one')},${wsFrame(2, 'mutation', 'b.two')}]`
    expect(parseTrpcWsFrame(batch).calls).toEqual(['a.one', 'b.two'])
  })

  it('separates a subscription from a call, and counts stops on their own', () => {
    const frame = `[${wsFrame(1, 'subscription', 'live.events')},${wsFrame(2, 'query', 'camera.list')}]`
    const parsed = parseTrpcWsFrame(frame)
    expect(parsed.calls).toEqual(['camera.list'])
    expect(parsed.subscriptions).toEqual(['live.events'])
    expect(parseTrpcWsFrame(JSON.stringify({ id: 1, method: 'subscription.stop' })).stops).toBe(1)
  })

  it('is not fooled by keepalives or by connection params', () => {
    // The adapter answers PING/PONG before parsing, and consumes the
    // connectionParams frame to build the context. Neither invoked anything.
    expect(parseTrpcWsFrame('PING').calls).toEqual([])
    expect(parseTrpcWsFrame('PONG').calls).toEqual([])
    expect(
      parseTrpcWsFrame(JSON.stringify({ method: 'connectionParams', data: { token: 'tok-x' } }))
        .calls,
    ).toEqual([])
  })

  it('ignores a method tRPC does not have, rather than inventing a call', () => {
    expect(parseTrpcWsFrame(JSON.stringify({ id: 1, method: 'teleport' })).calls).toEqual([])
    expect(parseTrpcWsFrame('not json at all').calls).toEqual([])
    expect(parseTrpcWsFrame('').calls).toEqual([])
  })

  it('names a pathless operation rather than dropping it', () => {
    const frame = JSON.stringify({ id: 1, method: 'query', params: {} })
    expect(parseTrpcWsFrame(frame).calls).toEqual([WS_PATHLESS_PROCEDURE])
  })

  it('marks an oversized batch instead of growing without limit', () => {
    const many = Array.from({ length: MAX_BATCH_PROCEDURES + 5 }, (_, i) =>
      wsFrame(i, 'query', `p${i}`),
    ).join(',')
    const parsed = parseTrpcWsFrame(`[${many}]`)
    expect(parsed.calls.length).toBe(MAX_BATCH_PROCEDURES + 1)
    expect(parsed.calls[parsed.calls.length - 1]).toBe(BATCH_OVERFLOW_PROCEDURE)
  })
})

// ── the WS plane: per OPERATION, identity per CONNECTION ─────────────────────

describe('the WebSocket plane', () => {
  it('counts one call per OPERATION, not one per connection', () => {
    // This is the whole defect: the census used to fire in `createContext`,
    // which the WS adapter runs once per SOCKET. Four queries reported one.
    const { census } = makeCensus()
    census.arm(60_000)
    const client = fakeWsClient()
    attachWsCensusSession(census, client, upgradeRequest())
    identifyWsCensusSession(client, 'apocaliss92 (admin)')

    for (let i = 0; i < 4; i += 1) client.send(wsFrame(i, 'query', 'deviceManager.listAll'))

    const snap = census.snapshot()
    expect(snap.wsConnections).toBe(1)
    expect(snap.planes.ws).toBe(4)
    expect(snap.procedureCalls).toBe(4)
    expect(snap.procedures[0]?.procedure).toBe('deviceManager.listAll')
    expect(snap.procedures[0]?.planes.ws).toBe(4)
  })

  it('counts a SUBSCRIPTION apart, so a long-lived stream is not a storm', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    const client = fakeWsClient()
    attachWsCensusSession(census, client, upgradeRequest())
    identifyWsCensusSession(client, 'apocaliss92 (admin)')

    client.send(wsFrame(1, 'subscription', 'live.events'))
    client.send(wsFrame(2, 'query', 'camera.list'))
    client.send(JSON.stringify({ id: 1, method: 'subscription.stop' }))

    const snap = census.snapshot()
    expect(snap.subscriptions).toBe(1)
    expect(snap.subscriptionStops).toBe(1)
    // The subscription is NOT in the call total, on any plane.
    expect(snap.procedureCalls).toBe(1)
    expect(snap.planes.ws).toBe(1)
    const live = snap.procedures.find((p) => p.procedure === 'live.events')
    expect(live?.subscriptions).toBe(1)
    expect(live?.calls).toBe(0)
  })

  it('derives the identity ONCE from the connection and reuses it', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    const client = fakeWsClient()
    attachWsCensusSession(census, client, upgradeRequest('camstack-viewer/1.2.3'))
    identifyWsCensusSession(client, 'apocaliss92 (admin)')
    client.send(wsFrame(1, 'query', 'deviceManager.listAll'))
    client.send(wsFrame(2, 'query', 'deviceManager.listAll'))

    const group = census.snapshot().groups[0]
    expect(group?.plane).toBe('ws')
    expect(group?.principal).toBe('apocaliss92 (admin)')
    expect(group?.userAgent).toBe('camstack-viewer/1.2.3')
    expect(group?.ip).toBe('192.168.10.44')
    expect(group?.calls).toBe(2)
    // One group, not two: the identity is the connection's, derived once.
    expect(census.snapshot().distinctGroups).toBe(1)
  })

  it('HOLDS operations that beat the bearer resolution, then names them', () => {
    // `createWsTrpcContext` is async; the client's first query can land before
    // it resolves. Counting those as `anonymous` would libel the caller, and
    // dropping them would hole the total.
    const { census } = makeCensus()
    census.arm(60_000)
    const client = fakeWsClient()
    attachWsCensusSession(census, client, upgradeRequest())

    client.send(wsFrame(1, 'query', 'deviceManager.listAll'))
    expect(census.snapshot().procedureCalls).toBe(0)

    identifyWsCensusSession(client, 'apocaliss92 (admin)')
    const snap = census.snapshot()
    expect(snap.procedureCalls).toBe(1)
    expect(snap.groups[0]?.principal).toBe('apocaliss92 (admin)')
  })

  it('releases held operations as the named unknown when the socket never authenticates', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    const client = fakeWsClient()
    attachWsCensusSession(census, client, upgradeRequest())
    client.send(wsFrame(1, 'query', 'deviceManager.listAll'))
    client.disconnect()

    const snap = census.snapshot()
    // Never lost, never silently absent.
    expect(snap.procedureCalls).toBe(1)
    expect(snap.groups[0]?.principal).toBe(UNKNOWN)
  })

  it('counts past the hold bound rather than buffering without limit', () => {
    const { census } = makeCensus()
    census.arm(600_000)
    const client = fakeWsClient()
    attachWsCensusSession(census, client, upgradeRequest())
    const total = MAX_PENDING_WS_OPERATIONS + 7
    for (let i = 0; i < total; i += 1) client.send(wsFrame(i, 'query', 'deviceManager.listAll'))

    expect(census.snapshot().procedureCalls).toBe(7)
    identifyWsCensusSession(client, 'apocaliss92 (admin)')
    expect(census.snapshot().procedureCalls).toBe(total)
  })

  it('counts every frame it looked at, operations or not', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    const client = fakeWsClient()
    attachWsCensusSession(census, client, upgradeRequest())
    identifyWsCensusSession(client, 'anonymous')
    client.send('PING')
    client.send(wsFrame(1, 'query', 'camera.list'))
    const snap = census.snapshot()
    expect(snap.wsMessages).toBe(2)
    expect(snap.planes.ws).toBe(1)
  })
})

// ── the planes explain the total ────────────────────────────────────────────

describe('every call is attributed to exactly ONE plane', () => {
  it('adds up: http + ws + mesh + unknown === procedureCalls', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    census.observeHttpRequest(observation())
    const client = fakeWsClient()
    attachWsCensusSession(census, client, upgradeRequest())
    identifyWsCensusSession(client, 'apocaliss92 (admin)')
    client.send(wsFrame(1, 'query', 'deviceManager.listAll'))
    client.send(wsFrame(2, 'query', 'deviceManager.listAll'))
    census.observe({
      plane: 'mesh',
      kind: 'call',
      procedures: ['system.info'],
      userAgent: null,
      ip: null,
      principal: 'mesh:hub',
    })

    const snap = census.snapshot()
    expect(snap.planes).toEqual({ http: 1, ws: 2, mesh: 1, unknown: 0 })
    expect(snap.procedureCalls).toBe(4)
    expect(snap.planesExplainTotal).toBe(true)
  })

  it('reports a plane that measured nothing as 0, never by omitting it', () => {
    // An absent key reads as "not instrumented". A `0` reads as "instrumented,
    // and it was not this one" — which is the negative the search needs.
    const { census } = makeCensus()
    census.arm(60_000)
    census.observeHttpRequest(observation())
    expect(census.snapshot().planes).toEqual({ http: 1, ws: 0, mesh: 0, unknown: 0 })
  })

  it('splits a per-procedure total by plane, and the split sums to the total', () => {
    // This is the row an operator reads to answer "which transport carried the
    // 4 960", and the identity the fleet-census reconciliation rests on.
    const { census } = makeCensus()
    census.arm(60_000)
    census.observeHttpRequest(observation())
    census.observe({ ...observation(), plane: 'ws', kind: 'call' })
    census.observe({ ...observation(), plane: 'ws', kind: 'call' })

    const row = census.snapshot().procedures[0]
    expect(row?.procedure).toBe('deviceManager.listAll')
    expect(row?.planes).toEqual({ http: 1, ws: 2, mesh: 0, unknown: 0 })
    expect((row?.planes.http ?? 0) + (row?.planes.ws ?? 0)).toBe(row?.calls)
  })

  it('keeps an undecidable plane in a NAMED bucket rather than losing the call', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    census.observe({ ...observation(), plane: 'unknown', kind: 'call' })
    const snap = census.snapshot()
    expect(snap.planes.unknown).toBe(1)
    expect(snap.procedureCalls).toBe(1)
    expect(snap.planesExplainTotal).toBe(true)
  })
})

// ── disarmed costs nothing ──────────────────────────────────────────────────

describe('a DISARMED census counts nothing and touches nothing', () => {
  it('never reads a single field off the request', () => {
    const { census } = makeCensus()
    expect(census.armed).toBe(false)
    // Every getter on this request throws. If the armed check is not the FIRST
    // statement of the hook, this test fails instead of the hub paying for a
    // diagnostic nobody switched on.
    expect(() => recordTrpcHttpRequest(census, hostileRequest(), null)).not.toThrow()
    expect(census.snapshot().httpRequests).toBe(0)
    expect(census.snapshot().procedureCalls).toBe(0)
  })

  it('never decodes a single WebSocket frame', () => {
    // Same shape as the hostile request, one plane over. The frame passes
    // `Buffer.isBuffer` and throws on decode, so if the `census.armed` guard
    // ever moves below the `toString()` this fails instead of the hub paying
    // a JSON.parse per frame for a diagnostic nobody switched on.
    const { census } = makeCensus()
    const session = attachWsCensusSession(census, fakeWsClient(), upgradeRequest())
    expect(() => session.observeMessage(hostileFrame())).not.toThrow()
    expect(census.snapshot().wsMessages).toBe(0)
  })

  it('proves that hostile frame is genuinely hostile once the census is armed', () => {
    // Without this the test above passes for a census that never looks at
    // anything at all — a tautology dressed as a guarantee.
    const { census } = makeCensus()
    const session = attachWsCensusSession(census, fakeWsClient(), upgradeRequest())
    census.arm(60_000)
    expect(() => session.observeMessage(hostileFrame())).toThrow(
      'disarmed census decoded the ws frame',
    )
  })

  it('stops counting a socket whose frame threw, once, and says so', () => {
    // A throw inside a `ws` listener is an uncaught exception, not a failed
    // request. Remove the try/catch in `attachWsCensusSession` and this test
    // fails by taking the whole process path with it.
    const { census } = makeCensus()
    census.arm(60_000)
    const warn = vi.fn()
    const client = fakeWsClient()
    attachWsCensusSession(census, client, upgradeRequest(), { warn })

    expect(() => client.send(hostileFrame())).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)

    // Silenced for this socket only — and it does not repeat the confession.
    client.send(hostileFrame())
    client.send(wsFrame(1, 'query', 'camera.list'))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(census.snapshot().planes.ws).toBe(0)
  })

  it('ignores a direct observation, a WebSocket connection and a WS operation', () => {
    const { census } = makeCensus()
    census.observeHttpRequest(observation())
    census.observeWsConnection()
    census.observe({ ...observation(), plane: 'ws', kind: 'call' })
    census.observeSubscriptionStop(3)
    const snap = census.snapshot()
    expect(snap.httpRequests).toBe(0)
    expect(snap.wsConnections).toBe(0)
    expect(snap.planes.ws).toBe(0)
    expect(snap.subscriptionStops).toBe(0)
    expect(snap.elapsedMs).toBe(0)
  })

  it('stops counting the moment the window closes', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    census.observeHttpRequest(observation())
    census.disarm('test')
    census.observeHttpRequest(observation())
    census.observeWsConnection()
    const snap = census.snapshot()
    expect(snap.armed).toBe(false)
    // The closed window keeps what it measured and accepts nothing more.
    expect(snap.procedureCalls).toBe(1)
    expect(snap.wsConnections).toBe(0)
  })
})

// ── the hook: identity, and no secrets ──────────────────────────────────────

describe('recordTrpcHttpRequest', () => {
  it('derives the principal and never carries the Authorization header', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    const user: AuthenticatedAgent = {
      id: 'u1',
      username: 'apocaliss92',
      isAdmin: true,
    } as AuthenticatedAgent
    recordTrpcHttpRequest(
      census,
      plainRequest('/trpc/deviceManager.listAll?input=%7B%7D', {
        authorization: 'Bearer tok-supersecret-value',
        'user-agent': 'camstack-viewer/1.2.3',
      }),
      user,
    )
    const snap = census.snapshot()
    expect(snap.groups[0]?.principal).toBe('apocaliss92 (admin)')
    expect(snap.groups[0]?.userAgent).toBe('camstack-viewer/1.2.3')
    expect(JSON.stringify(snap)).not.toContain('supersecret')
    expect(JSON.stringify(snap).toLowerCase()).not.toContain('bearer')
  })

  it('records an unauthenticated request as `anonymous`, never as blank', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    recordTrpcHttpRequest(census, plainRequest('/trpc/system.health'), null)
    expect(census.snapshot().groups[0]?.principal).toBe('anonymous')
  })

  it('counts each procedure of a batched request through the hook', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    recordTrpcHttpRequest(
      census,
      plainRequest('/trpc/deviceManager.listAll,camera.list?batch=1', {
        'content-type': 'application/json',
      }),
      null,
    )
    const snap = census.snapshot()
    expect(snap.httpRequests).toBe(1)
    expect(snap.procedureCalls).toBe(2)
  })

  it('ignores a request that is not a tRPC call, and a missing request', () => {
    const { census } = makeCensus()
    census.arm(60_000)
    recordTrpcHttpRequest(census, plainRequest('/api/health'), null)
    recordTrpcHttpRequest(census, undefined, null)
    expect(census.snapshot().httpRequests).toBe(0)
  })
})

// ── window lifecycle + the report line ──────────────────────────────────────

describe('the armed window', () => {
  it('clamps the requested window and reports what it actually armed', () => {
    const { census } = makeCensus()
    census.arm(MAX_WINDOW_MS * 10)
    expect(census.snapshot().windowMs).toBe(MAX_WINDOW_MS)
    census.arm(1)
    expect(census.snapshot().windowMs).toBeGreaterThanOrEqual(1_000)
  })

  it('emits ONE aggregated line per interval, not one per request', () => {
    const { census, advance, runPendingTimers } = makeCensus()
    const info = vi.fn()
    census.setLogger(loggerWithInfo(info))
    census.arm(120_000, MIN_REPORT_EVERY_MS)
    for (let i = 0; i < 500; i += 1) census.observeHttpRequest(observation())
    expect(info).not.toHaveBeenCalled()

    advance(MIN_REPORT_EVERY_MS)
    runPendingTimers()
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]?.[0]).toBe('transport census')
  })

  it('closes itself at the end of the window and emits a final line', () => {
    const { census, advance, runPendingTimers } = makeCensus()
    const info = vi.fn()
    census.setLogger(loggerWithInfo(info))
    census.arm(10_000, MIN_REPORT_EVERY_MS)
    census.observeHttpRequest(observation())

    advance(MIN_REPORT_EVERY_MS)
    runPendingTimers()
    expect(census.armed).toBe(true)

    advance(MIN_REPORT_EVERY_MS)
    runPendingTimers()
    expect(census.armed).toBe(false)
    expect(info).toHaveBeenCalledTimes(2)
    // The counts survive the close - the window is read AFTER it ran.
    expect(census.snapshot().procedureCalls).toBe(1)
  })

  it('reports even when it measured nothing - silence would read as "never armed"', () => {
    const { census, advance, runPendingTimers } = makeCensus()
    const info = vi.fn()
    census.setLogger(loggerWithInfo(info))
    census.arm(6_000, MIN_REPORT_EVERY_MS)
    advance(MIN_REPORT_EVERY_MS * 2)
    runPendingTimers()
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('re-arming clears the previous window and neutralises its pending timer', () => {
    const { census, advance, runPendingTimers } = makeCensus()
    const info = vi.fn()
    census.setLogger(loggerWithInfo(info))
    census.arm(120_000, MIN_REPORT_EVERY_MS)
    census.observeHttpRequest(observation())
    census.arm(120_000, MIN_REPORT_EVERY_MS)
    expect(census.snapshot().procedureCalls).toBe(0)

    advance(MIN_REPORT_EVERY_MS)
    runPendingTimers()
    // Two windows were armed but only the live one ticks: a stale timer that
    // still reported would divide one table by two durations.
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('carries the per-procedure totals AND the WebSocket count on the line', () => {
    const { census } = makeCensus()
    const info = vi.fn()
    census.setLogger(loggerWithInfo(info))
    census.arm(60_000)
    census.observeHttpRequest(observation())
    census.observeWsConnection()
    census.observeWsConnection()
    census.report('manual')

    const meta = info.mock.calls[0]?.[1]?.meta
    expect(meta?.wsConnections).toBe(2)
    expect(meta?.procedureCalls).toBe(1)
    expect(meta?.procedures?.[0]?.procedure).toBe('deviceManager.listAll')
  })

  it('puts the PLANES and the acceptance criterion on the same line', () => {
    // "The sum of the planes explains the total" has to be readable off ONE
    // line, or nobody checks it. `planesExplainTotal` is that check, printed.
    const { census } = makeCensus()
    const info = vi.fn()
    census.setLogger(loggerWithInfo(info))
    census.arm(60_000)
    census.observeHttpRequest(observation())
    census.observe({ ...observation(), plane: 'ws', kind: 'call' })
    census.observe({
      ...observation({ procedures: ['live.events'] }),
      plane: 'ws',
      kind: 'subscription',
    })
    census.report('manual')

    const meta = info.mock.calls[0]?.[1]?.meta
    expect(meta?.planes).toEqual({ http: 1, ws: 1, mesh: 0, unknown: 0 })
    expect(meta?.planesExplainTotal).toBe(true)
    expect(meta?.procedureCalls).toBe(2)
    expect(meta?.subscriptions).toBe(1)
    expect(meta?.top?.[0]?.plane).toBe('http')
  })
})
