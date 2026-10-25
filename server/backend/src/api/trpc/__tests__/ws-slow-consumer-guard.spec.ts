/**
 * A tRPC WS client that stops reading is disconnected, not buffered forever
 * (D443 decision, D444 implementation).
 *
 * Disarms, one per claim:
 *  - delete `connection.socket.terminate()` → "terminated after the grace" red;
 *  - delete the `overForMs < this.graceMs` return → "a burst that drains is
 *    never terminated" red;
 *  - delete the warn → the log assertions red;
 *  - delete the `try/catch` in `poll` → "a socket whose getter throws" red.
 */
import { describe, expect, it, type Mock, vi } from 'vitest'
import {
  WS_SLOW_CONSUMER_GRACE_MS,
  WS_SLOW_CONSUMER_MAX_BUFFERED_BYTES,
  WsSlowConsumerGuard,
  type WsConnectionFacts,
  type WsGuardedSocket,
} from '../ws-slow-consumer-guard.js'

interface FakeSocket extends WsGuardedSocket {
  bufferedAmount: number
  readonly terminate: Mock<() => void>
  close(code: number, reason?: string): void
}

function fakeSocket(): FakeSocket {
  let onClose: ((code: number, reason: Buffer) => void) | null = null
  const socket: FakeSocket = {
    bufferedAmount: 0,
    terminate: vi.fn<() => void>(() => {
      onClose?.(1006, Buffer.alloc(0))
    }),
    once(_event, listener) {
      onClose = listener
      return socket
    },
    close(code, reason = '') {
      onClose?.(code, Buffer.from(reason))
    },
  }
  return socket
}

const facts: WsConnectionFacts = {
  ip: '192.168.10.230',
  userAgent: 'CamStack Viewer/1.0.483 (iOS)',
  bytesRead: () => 160_000,
  bytesWritten: () => 90_000_000,
}

function harness() {
  let clock = 0
  const info = vi.fn()
  const warn = vi.fn()
  const guard = new WsSlowConsumerGuard({ logger: { info, warn }, now: () => clock })
  const tick = (ms: number): void => {
    clock += ms
    guard.poll()
  }
  return { guard, info, warn, tick, lines: () => [...info.mock.calls, ...warn.mock.calls] }
}

describe('WsSlowConsumerGuard', () => {
  it('a client under the bound is never touched and never logged', () => {
    const { guard, tick, lines } = harness()
    const socket = fakeSocket()
    guard.attach(socket, facts)
    socket.bufferedAmount = WS_SLOW_CONSUMER_MAX_BUFFERED_BYTES
    for (let i = 0; i < 20; i++) tick(5_000)
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(lines()).toHaveLength(0)
  })

  it('a burst that drains inside the grace is never terminated — liveness, not identity — and is logged once as drained', () => {
    const { guard, info, tick } = harness()
    const socket = fakeSocket()
    guard.attach(socket, facts)
    socket.bufferedAmount = WS_SLOW_CONSUMER_MAX_BUFFERED_BYTES + 1
    tick(5_000)
    tick(5_000)
    socket.bufferedAmount = 0
    tick(5_000)
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
    const [message, extra] = info.mock.calls[0]!
    expect(String(message)).toContain('drained')
    expect(extra.meta).toMatchObject({ overForMs: 10_000, ip: '192.168.10.230' })
  })

  it('a client that stays above the bound for the grace period is terminated, once, with the peer named', () => {
    const { guard, warn, tick } = harness()
    const socket = fakeSocket()
    guard.attach(socket, facts)
    guard.identify(socket, 'apocaliss92 (session)')
    socket.bufferedAmount = 88 * 1024 * 1024
    // The first poll after attach is what starts the excursion clock; the
    // grace is measured from there, so one poll past it is the termination.
    tick(5_000)
    let elapsed = 0
    while (elapsed < WS_SLOW_CONSUMER_GRACE_MS) {
      expect(socket.terminate).not.toHaveBeenCalled()
      tick(5_000)
      elapsed += 5_000
    }
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    const [message, extra] = warn.mock.calls[0]!
    expect(String(message)).toContain('slow consumer')
    expect(extra.meta).toMatchObject({
      ip: '192.168.10.230',
      principal: 'apocaliss92 (session)',
      bufferedBytes: 88 * 1024 * 1024,
      bytesRead: 160_000,
      overForMs: WS_SLOW_CONSUMER_GRACE_MS,
      boundBytes: WS_SLOW_CONSUMER_MAX_BUFFERED_BYTES,
    })
    // The close the termination caused is logged as ours, and the socket is forgotten.
    tick(5_000)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
  })

  it('every close is logged with what was queued at that moment, and who closed it', () => {
    const { guard, info } = harness()
    const socket = fakeSocket()
    guard.attach(socket, facts)
    socket.bufferedAmount = 1234
    socket.close(1001, 'going away')
    expect(info).toHaveBeenCalledTimes(1)
    const [message, extra] = info.mock.calls[0]!
    expect(String(message)).toContain('closed')
    expect(extra.meta).toMatchObject({ code: 1001, reason: 'going away', closedBy: 'peer' })
  })

  it('an abnormal close that the guard did not cause names the other two causes', () => {
    const { guard, info } = harness()
    const socket = fakeSocket()
    guard.attach(socket, facts)
    socket.close(1006)
    expect(info.mock.calls[0]![1].meta).toMatchObject({
      code: 1006,
      closedBy: 'peer gone or keep-alive PING unanswered',
    })
  })

  it('a socket whose queue cannot be read never takes the poll down, and says so', () => {
    const { guard, warn, tick } = harness()
    const broken = fakeSocket()
    Object.defineProperty(broken, 'bufferedAmount', {
      get() {
        throw new Error('socket handle gone')
      },
    })
    const healthy = fakeSocket()
    guard.attach(broken, facts)
    guard.attach(healthy, facts)
    healthy.bufferedAmount = WS_SLOW_CONSUMER_MAX_BUFFERED_BYTES + 1
    let elapsed = 0
    while (elapsed <= WS_SLOW_CONSUMER_GRACE_MS) {
      tick(5_000)
      elapsed += 5_000
    }
    expect(healthy.terminate).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.some(([m]) => String(m).includes('could not read a socket'))).toBe(true)
  })
})
