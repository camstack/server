import { describe, expect, it } from 'vitest'
import { Z2mClient, type Z2mConnection, Z2mRequestError } from '../z2m-client.js'
import type { Z2mEnvelope } from '../z2m-protocol.js'
import { FakeNet, type LogLine, ManualTimers, recordingLogger } from './fakes.js'

function harness(token: string | null = null) {
  const net = new FakeNet()
  const timers = new ManualTimers()
  const states: Z2mConnection[] = []
  const envelopes: Z2mEnvelope[] = []
  const lines: LogLine[] = []
  const client = new Z2mClient({
    endpoint: { host: 'z2m.lan', port: 8080, tls: false, token },
    logger: recordingLogger(lines),
    onEnvelope: (e) => envelopes.push(e),
    onConnection: (s) => states.push(s),
    factory: net.factory,
    timers,
    backoffBaseMs: 1000,
    backoffMaxMs: 8000,
    requestTimeoutMs: 5000,
  })
  return { net, timers, states, envelopes, lines, client }
}

describe('Z2mClient', () => {
  it('connects to /api, with the token as a query parameter and never in a log line', () => {
    const h = harness('s3cret')
    h.client.start()
    expect(h.net.last.url).toBe('ws://z2m.lan:8080/api?token=s3cret')
    h.net.last.open()
    expect(h.states).toEqual(['connecting', 'online'])
    expect(JSON.stringify(h.lines)).not.toContain('s3cret')
  })

  it('uses wss when tls is on and no query without a token', () => {
    const net = new FakeNet()
    const client = new Z2mClient({
      endpoint: { host: 'z2m.lan', port: 443, tls: true, token: null },
      logger: recordingLogger(),
      onEnvelope: () => {},
      onConnection: () => {},
      factory: net.factory,
      timers: new ManualTimers(),
    })
    client.start()
    expect(net.last.url).toBe('wss://z2m.lan:443/api')
  })

  it('delivers parsed envelopes and drops a frame that is not one', () => {
    const h = harness()
    h.client.start()
    h.net.last.open()
    h.net.last.push('bridge/state', { state: 'online' })
    h.net.last.pushRaw('not json')
    h.net.last.pushRaw(JSON.stringify({ nope: 1 }))
    expect(h.envelopes).toEqual([{ topic: 'bridge/state', payload: { state: 'online' } }])
  })

  it('reconnects with a doubling, capped backoff and resets it after a successful open', () => {
    const h = harness()
    h.client.start()
    h.net.last.drop()
    expect(h.timers.pending()).toEqual([1000])
    expect(h.states.at(-1)).toBe('offline')
    expect(h.timers.fire()).toBe(1000)
    h.net.last.drop()
    expect(h.timers.pending()).toEqual([2000])
    h.timers.fire()
    h.net.last.drop()
    h.timers.fire()
    h.net.last.drop()
    h.timers.fire()
    h.net.last.drop()
    expect(h.timers.pending()).toEqual([8000]) // capped: 1000 * 2^4 = 16000 > 8000
    h.timers.fire()
    h.net.last.open()
    h.net.last.drop()
    expect(h.timers.pending()).toEqual([1000])
    expect(h.net.sockets).toHaveLength(6)
  })

  it('stops for good on a refused token (4401): auth-rejected, no retry', () => {
    const h = harness('bad')
    h.client.start()
    h.net.last.drop(4401, 'Unauthorized')
    expect(h.states.at(-1)).toBe('auth-rejected')
    expect(h.timers.pending()).toEqual([])
  })

  it('does not reconnect after stop()', () => {
    const h = harness()
    h.client.start()
    h.net.last.open()
    h.client.stop()
    expect(h.net.last.closed).toBe(true)
    expect(h.states.at(-1)).toBe('closed')
    expect(h.timers.pending()).toEqual([])
  })

  it('publishes a command only while online', () => {
    const h = harness()
    h.client.start()
    expect(() => h.client.publish('lamp/set', { state: 'ON' })).toThrow(Z2mRequestError)
    h.net.last.open()
    h.client.publish('lamp/set', { state: 'ON' })
    expect(h.net.last.sentEnvelopes()).toEqual([{ topic: 'lamp/set', payload: { state: 'ON' } }])
  })

  it('correlates a request with its response by transaction', async () => {
    const h = harness()
    h.client.start()
    h.net.last.open()
    const answer = h.client.request('bridge/request/permit_join', { time: 254 })
    const sent = h.net.last.sentEnvelopes()[0]
    expect(sent?.topic).toBe('bridge/request/permit_join')
    const transaction = sent?.payload['transaction']
    expect(typeof transaction).toBe('string')
    h.net.last.push('bridge/response/permit_join', {
      data: { time: 254 },
      status: 'ok',
      transaction: 'someone-else',
    })
    h.net.last.push('bridge/response/permit_join', {
      data: { time: 254 },
      status: 'ok',
      transaction,
    })
    await expect(answer).resolves.toEqual({ time: 254 })
  })

  it('rejects a request the server refused, with the server reason', async () => {
    const h = harness()
    h.client.start()
    h.net.last.open()
    const answer = h.client.request('bridge/request/device/remove', { id: 'ghost' })
    const transaction = h.net.last.sentEnvelopes()[0]?.payload['transaction']
    h.net.last.push('bridge/response/device/remove', {
      data: {},
      status: 'error',
      error: "Device 'ghost' does not exist",
      transaction,
    })
    await expect(answer).rejects.toThrow("Device 'ghost' does not exist")
  })

  it('rejects a request that never gets a response, and one cut off by a lost connection', async () => {
    const h = harness()
    h.client.start()
    h.net.last.open()
    const slow = h.client.request('bridge/request/health_check', {})
    h.timers.fire()
    await expect(slow).rejects.toThrow('timed out')
    const cut = h.client.request('bridge/request/restart', {})
    h.net.last.drop()
    await expect(cut).rejects.toThrow('connection lost')
  })
})
