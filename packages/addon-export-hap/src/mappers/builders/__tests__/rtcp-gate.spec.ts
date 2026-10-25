/**
 * The RTCP gate resolves on one of two events that mean OPPOSITE things:
 *
 *   - a packet arrived on our advertised return port → the controller found
 *     us, the SRTP path is validated, media may flow;
 *   - the 1 s fallback fired → nothing ever arrived, we are streaming into a
 *     port the controller may not even be listening on.
 *
 * Both used to `resolve()` a bare `Promise<void>`, so the log could not tell
 * them apart — and "did iOS ever send us RTCP?" has been an ASSUMPTION in
 * every diagnosis of the 31 s teardown. The gate now reports which happened.
 */
import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeRtcpGate, type RtcpGateSocket } from '../rtcp-gate.js'

class FakeSocket extends EventEmitter implements RtcpGateSocket {}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('makeRtcpGate', () => {
  it('resolves with reason "packet" when the controller probes the return port', async () => {
    const socket = new FakeSocket()
    const gate = makeRtcpGate(socket, 1000)

    vi.advanceTimersByTime(120)
    socket.emit('message', Buffer.alloc(8))

    await expect(gate).resolves.toMatchObject({ reason: 'packet' })
  })

  it('resolves with reason "timeout" when nothing ever arrives', async () => {
    const socket = new FakeSocket()
    const gate = makeRtcpGate(socket, 1000)

    await vi.advanceTimersByTimeAsync(1000)

    await expect(gate).resolves.toMatchObject({ reason: 'timeout' })
  })

  it('reports how long it waited, so a slow probe is distinguishable from a fast one', async () => {
    const socket = new FakeSocket()
    const gate = makeRtcpGate(socket, 1000)

    vi.advanceTimersByTime(750)
    socket.emit('message', Buffer.alloc(8))

    const resolution = await gate
    expect(resolution.waitedMs).toBeGreaterThanOrEqual(750)
  })

  it('is one-shot — it detaches its listener so it cannot outlive the session', async () => {
    const socket = new FakeSocket()
    const gate = makeRtcpGate(socket, 1000)

    socket.emit('message', Buffer.alloc(8))
    await gate

    expect(socket.listenerCount('message')).toBe(0)
  })

  it('detaches its listener on timeout too', async () => {
    const socket = new FakeSocket()
    const gate = makeRtcpGate(socket, 1000)

    await vi.advanceTimersByTimeAsync(1000)
    await gate

    expect(socket.listenerCount('message')).toBe(0)
  })
})
