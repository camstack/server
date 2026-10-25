/**
 * Per-channel socket counters, split by frame kind.
 *
 * hub-main runs ~22 000 socket reads/s and ~22 500 writes/s at a 0.33 KB mean
 * and, until these counters existed, not one of those operations could be
 * attributed: `/proc` reports one `rchar`/`wchar` pair per PROCESS and has no
 * per-socket breakdown. The event fan-out plane — the only part that WAS
 * countable — turned out to be 4 % of it.
 *
 * What must be true for the numbers to be worth anything:
 *
 *  - the split is by KIND, because `req` (work), `res` (where a large payload
 *    can hide) and `evt` (fan-out, scales with runner count) have three
 *    different fixes;
 *  - the bytes are ON-THE-WIRE bytes, prefix included, so they reconcile
 *    against the peer's `/proc` — reconciling against `/proc` is the only
 *    reason to trust either instrument;
 *  - a `data` chunk carrying SEVERAL frames of different kinds charges each
 *    kind its own bytes. Charging the chunk to whichever kind arrived first is
 *    the obvious cheap shortcut and it is wrong, which is why the mixed-chunk
 *    and split-frame cases are asserted explicitly.
 */
import { describe, it, expect } from 'vitest'
import { Socket } from 'node:net'
import { SocketChannel } from '../../transport/socket-channel.js'
import { encodeFrame } from '../../transport/frame-codec.js'
import { socketDirectionBytes, socketDirectionMessages } from '../../transport/socket-traffic.js'

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

/** One channel fed raw bytes, with nothing wired to write back. */
function receiver(): { channel: SocketChannel; feed: (chunk: Buffer) => void } {
  const socket = new Socket()
  ;(socket as unknown as { write: () => boolean }).write = () => true
  const channel = new SocketChannel(socket)
  return { channel, feed: (chunk: Buffer) => void socket.emit('data', chunk) }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

describe('a channel counts what it writes, by kind', () => {
  it('a request is one tx `req` on the caller and one rx `req` on the peer', async () => {
    const [client, server] = pair()
    server.onRequest(async () => 'ok')
    await client.request({ ping: 1 })
    await settle()

    expect(client.readTraffic().tx.reqMessages).toBe(1)
    expect(client.readTraffic().tx.resMessages).toBe(0)
    expect(server.readTraffic().rx.reqMessages).toBe(1)
    // …and the answer travels the other way, as a `res`, on both sides.
    expect(server.readTraffic().tx.resMessages).toBe(1)
    expect(client.readTraffic().rx.resMessages).toBe(1)
  })

  it('a one-way event is `evt` and never touches the req/res counters', async () => {
    const [client, server] = pair()
    server.onEvent(() => {})
    client.emit({ tick: 1 })
    client.emit({ tick: 2 })
    await settle()

    const tx = client.readTraffic().tx
    expect(tx.evtMessages).toBe(2)
    expect(tx.reqMessages).toBe(0)
    expect(tx.resMessages).toBe(0)
    expect(server.readTraffic().rx.evtMessages).toBe(2)
  })

  it('a rejected request still costs one `res` — a failure is traffic too', async () => {
    const [client, server] = pair()
    server.onRequest(async () => {
      throw new Error('boom')
    })
    await expect(client.request({})).rejects.toThrow('boom')
    await settle()
    expect(server.readTraffic().tx.resMessages).toBe(1)
    expect(client.readTraffic().rx.resMessages).toBe(1)
  })
})

describe('the bytes are on-the-wire bytes, so they reconcile against /proc', () => {
  it('one emitted event costs exactly `encodeFrame(...).byteLength`', async () => {
    const [client, server] = pair()
    server.onEvent(() => {})
    const body = { tick: 1, payload: 'x'.repeat(500) }
    client.emit(body)
    await settle()

    const expected = encodeFrame({ k: 'evt', body }).byteLength
    expect(client.readTraffic().tx.evtBytes).toBe(expected)
    // The 4-byte length prefix is part of it: the peer's kernel counted it.
    expect(expected).toBeGreaterThan(500 + 4)
    // Both ends agree on the same frame — the whole point of a per-peer
    // counter is that the two sides of a link can be cross-checked.
    expect(server.readTraffic().rx.evtBytes).toBe(expected)
  })

  it('the mean message size is readable off the counters', async () => {
    const [client, server] = pair()
    server.onEvent(() => {})
    for (let i = 0; i < 10; i += 1) client.emit({ i })
    await settle()
    const tx = client.readTraffic().tx
    expect(socketDirectionMessages(tx)).toBe(10)
    expect(socketDirectionBytes(tx) / socketDirectionMessages(tx)).toBeLessThan(64)
  })
})

describe('a chunk is not a message — the split survives real socket framing', () => {
  it('three frames of three kinds in ONE chunk are charged to three kinds', async () => {
    const { channel, feed } = receiver()
    channel.onRequest(async () => 'ok')
    channel.onEvent(() => {})

    const req = encodeFrame({ k: 'req', id: 7, body: { a: 1 } })
    const res = encodeFrame({ k: 'res', id: 99, ok: true, body: 'x'.repeat(300) })
    const evt = encodeFrame({ k: 'evt', body: { tick: 1 } })
    feed(Buffer.concat([req, res, evt]))
    await settle()

    const rx = channel.readTraffic().rx
    expect(rx.reqMessages).toBe(1)
    expect(rx.resMessages).toBe(1)
    expect(rx.evtMessages).toBe(1)
    // Each kind is charged ITS OWN frame, not the chunk. Attributing the chunk
    // to the first kind seen would put all three lengths on `req`.
    expect(rx.reqBytes).toBe(req.byteLength)
    expect(rx.resBytes).toBe(res.byteLength)
    expect(rx.evtBytes).toBe(evt.byteLength)
    expect(rx.resBytes).not.toBe(rx.evtBytes)
  })

  it('a frame delivered in pieces is charged its FULL wire length, once', async () => {
    const { channel, feed } = receiver()
    channel.onEvent(() => {})
    const evt = encodeFrame({ k: 'evt', body: { payload: 'y'.repeat(4000) } })
    // Split mid-body, and split the 4-byte prefix too — both are real socket
    // events, and both were reassembly bugs before the chunk-list decoder.
    feed(evt.subarray(0, 2))
    feed(evt.subarray(2, 1000))
    feed(evt.subarray(1000))
    await settle()

    const rx = channel.readTraffic().rx
    expect(rx.evtMessages).toBe(1)
    expect(rx.evtBytes).toBe(evt.byteLength)
  })

  it("a small chunk after a big one is not charged the big one's leftovers", async () => {
    // `lastFrameBytes` is written in place and never truncated — truncating it
    // cost 35 ns/call, 15x the counter it feeds. The contract that makes that
    // safe is "only the first `frames.length` entries are read", and this is
    // the case that breaks if anyone ever reads past it: three frames, then one.
    const { channel, feed } = receiver()
    channel.onEvent(() => {})
    const big = encodeFrame({ k: 'evt', body: { p: 'q'.repeat(2000) } })
    feed(Buffer.concat([big, big, big]))
    await settle()
    const afterBig = channel.readTraffic().rx.evtBytes

    const small = encodeFrame({ k: 'evt', body: { p: 1 } })
    feed(small)
    await settle()

    const rx = channel.readTraffic().rx
    expect(rx.evtMessages).toBe(4)
    expect(rx.evtBytes).toBe(afterBig + small.byteLength)
    expect(small.byteLength).toBeLessThan(100)
  })

  it('a chunk that completes NO frame is charged nothing', async () => {
    const { channel, feed } = receiver()
    channel.onEvent(() => {})
    const evt = encodeFrame({ k: 'evt', body: { payload: 'z'.repeat(4000) } })
    feed(evt.subarray(0, 100))
    await settle()

    const rx = channel.readTraffic().rx
    expect(socketDirectionMessages(rx)).toBe(0)
    // A partial frame must not be counted as bytes-with-no-kind either: the
    // counter measures MESSAGES, and half a message is not one.
    expect(socketDirectionBytes(rx)).toBe(0)
  })
})

describe('the counters are cumulative and start at zero', () => {
  it('a fresh channel reports six zeros in each direction', () => {
    const [client] = pair()
    const traffic = client.readTraffic()
    expect(socketDirectionMessages(traffic.tx)).toBe(0)
    expect(socketDirectionBytes(traffic.tx)).toBe(0)
    expect(socketDirectionMessages(traffic.rx)).toBe(0)
    expect(socketDirectionBytes(traffic.rx)).toBe(0)
  })

  it('a reading is a COPY — a later frame never mutates a sample already taken', async () => {
    const [client, server] = pair()
    server.onEvent(() => {})
    client.emit({ a: 1 })
    await settle()
    const first = client.readTraffic()
    client.emit({ a: 2 })
    await settle()
    // The reporting layer subtracts the previous reading; if `readTraffic`
    // handed out the live counters, every delta would be zero and the whole
    // instrument would report a silent plane.
    expect(first.tx.evtMessages).toBe(1)
    expect(client.readTraffic().tx.evtMessages).toBe(2)
  })
})
