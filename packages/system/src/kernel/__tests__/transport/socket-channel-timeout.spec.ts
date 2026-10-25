/**
 * A UDS request whose peer never replies used to hang FOREVER.
 *
 * `SocketChannel.request()` registers the promise in `pending` and settles it
 * on exactly two events: a matching `res` frame, or the socket's `close`
 * (which drains `pending`). So a peer that RECEIVES the request and then
 * neither answers nor closes — a wedged handler, or a half-open socket after
 * the child was killed without a clean teardown — leaves the caller pending
 * with nothing to wake it.
 *
 * Every other transport layer here is bounded: remote Moleculer cap calls use
 * `REMOTE_CALL_TIMEOUT_MS` (60 s) with per-cap overrides via
 * `CapRouteResolver.callTimeout`. The UDS plane was the exception, which is
 * how camera 101 spent 30+ minutes with every inference permit held by a call
 * that was never coming back (2026-07-30).
 *
 * Note what is NOT the bug: a peer that DIES cleanly is fine — `handleClose`
 * rejects every pending request. Only silence-without-close hangs.
 */

import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SocketChannel } from '../../transport/socket-channel.js'

/** Two SocketChannels wired over an in-memory socket pair (no real fd). */
function pair(): [SocketChannel, SocketChannel] {
  const a = new Socket()
  const b = new Socket()
  ;(a as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer) => {
    b.emit('data', Buffer.from(c))
    return true
  }
  ;(b as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer) => {
    a.emit('data', Buffer.from(c))
    return true
  }
  ;(a as unknown as { destroy: () => void }).destroy = () => {
    a.emit('close')
  }
  ;(b as unknown as { destroy: () => void }).destroy = () => {
    b.emit('close')
  }
  return [new SocketChannel(a), new SocketChannel(b)]
}

describe('SocketChannel — a peer that never answers must not hang the caller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rejects a request whose peer never replies', async () => {
    const [client, server] = pair()
    // Received, and then silence — no response frame, no close.
    server.onRequest(() => new Promise<never>(() => {}))

    const p = client.request({ ping: 1 }, { timeoutMs: 100 })
    const assertion = expect(p).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(200)
    await assertion
  })

  it('names the elapsed bound so the log says what was waited on', async () => {
    const [client, server] = pair()
    server.onRequest(() => new Promise<never>(() => {}))

    const p = client.request({}, { timeoutMs: 100 })
    const assertion = expect(p).rejects.toThrow(/100/)
    await vi.advanceTimersByTimeAsync(200)
    await assertion
  })

  it('does not reject a request that answers within the bound', async () => {
    const [client, server] = pair()
    server.onRequest(async (body) => ({ echo: body }))

    const p = client.request({ ping: 2 }, { timeoutMs: 5_000 })
    await vi.advanceTimersByTimeAsync(10)
    await expect(p).resolves.toEqual({ echo: { ping: 2 } })
  })

  it('a late reply after the timeout is ignored, not mis-delivered', async () => {
    // The pending entry must be dropped on timeout: a `res` arriving later
    // carries an id nobody is waiting for, and must not resolve some LATER
    // request that happens to reuse the slot.
    const [client, server] = pair()
    let release!: (v: unknown) => void
    server.onRequest(() => new Promise((r) => (release = r)))

    const first = client.request({ n: 1 }, { timeoutMs: 100 })
    const firstAssertion = expect(first).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(200)
    await firstAssertion

    release('late')
    await vi.advanceTimersByTimeAsync(50)
    // Nothing blew up, and the channel still works for a fresh request.
    server.onRequest(async () => 'fresh')
    const second = client.request({ n: 2 }, { timeoutMs: 5_000 })
    await vi.advanceTimersByTimeAsync(10)
    await expect(second).resolves.toBe('fresh')
  })

  it('clears its timer when the reply arrives, so a settled request cannot fire later', async () => {
    const [client, server] = pair()
    server.onRequest(async () => 'ok')

    await expect(
      (async () => {
        const p = client.request({}, { timeoutMs: 50 })
        await vi.advanceTimersByTimeAsync(10)
        return p
      })(),
    ).resolves.toBe('ok')

    // Well past the bound. An uncleared timer would reject an already-settled
    // promise (harmless) but would also keep the process alive under a real
    // timer — assert the pending map is empty instead of relying on that.
    await vi.advanceTimersByTimeAsync(500)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still rejects on close, which is the path that already worked', async () => {
    const [client, server] = pair()
    server.onRequest(() => new Promise<never>(() => {}))

    const p = client.request({}, { timeoutMs: 60_000 })
    const assertion = expect(p).rejects.toThrow(/channel closed/)
    client.close()
    await vi.advanceTimersByTimeAsync(10)
    await assertion
  })
})
