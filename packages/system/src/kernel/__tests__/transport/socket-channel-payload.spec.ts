import { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { PayloadReply } from '../../transport/local-transport.js'
import { SocketChannel } from '../../transport/socket-channel.js'

/**
 * Two SocketChannels over an in-memory socket pair. Every write is delivered
 * as ONE `data` event per `write` call, so a head written separately from its
 * payload tail arrives in two chunks — exactly what the decoder must reassemble.
 */
function pair(): [SocketChannel, SocketChannel, { aWrites: Buffer[]; bWrites: Buffer[] }] {
  const a = new Socket()
  const b = new Socket()
  const log = { aWrites: [] as Buffer[], bWrites: [] as Buffer[] }
  ;(a as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer) => {
    log.aWrites.push(Buffer.from(c))
    b.emit('data', Buffer.from(c))
    return true
  }
  ;(b as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer) => {
    log.bWrites.push(Buffer.from(c))
    a.emit('data', Buffer.from(c))
    return true
  }
  ;(a as unknown as { cork: () => void }).cork = () => {}
  ;(a as unknown as { uncork: () => void }).uncork = () => {}
  ;(b as unknown as { cork: () => void }).cork = () => {}
  ;(b as unknown as { uncork: () => void }).uncork = () => {}
  ;(a as unknown as { destroy: () => void }).destroy = () => a.emit('close')
  ;(b as unknown as { destroy: () => void }).destroy = () => b.emit('close')
  return [new SocketChannel(a), new SocketChannel(b), log]
}

const bytesOf = (n: number, fill: number): Uint8Array => new Uint8Array(n).fill(fill)

describe('SocketChannel — an opaque payload rides beside the envelope', () => {
  it('hands the request handler the payload bytes untouched, beside the body', async () => {
    const [client, server] = pair()
    const seen: { body: unknown; payload: Uint8Array | undefined }[] = []
    server.onRequest(async (body, payload) => {
      seen.push({ body, payload })
      return 'ok'
    })
    const payload = bytesOf(13_500, 0xab)
    await expect(client.request({ kind: 'x' }, { payload })).resolves.toBe('ok')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.body).toEqual({ kind: 'x' })
    expect(Buffer.from(seen[0]!.payload!).equals(Buffer.from(payload))).toBe(true)
  })

  it('a handler returning a PayloadReply resolves the requester with the same shape', async () => {
    const [client, server] = pair()
    server.onRequest(async () => new PayloadReply({ meta: 1 }, bytesOf(5000, 0x42)))
    const got = await client.request({}, { payload: bytesOf(1, 0) })
    expect(got).toBeInstanceOf(PayloadReply)
    const reply = got as PayloadReply
    expect(reply.body).toEqual({ meta: 1 })
    expect(Buffer.from(reply.payload).equals(Buffer.from(bytesOf(5000, 0x42)))).toBe(true)
  })

  it('a plain reply to a payload request resolves plain — the responder decides', async () => {
    const [client, server] = pair()
    server.onRequest(async () => ({ plain: true }))
    await expect(client.request({}, { payload: bytesOf(3, 1) })).resolves.toEqual({
      plain: true,
    })
  })

  it('a request without a payload hands the handler `undefined` for it', async () => {
    const [client, server] = pair()
    let seen: Uint8Array | undefined | null = null
    server.onRequest(async (_body, payload) => {
      seen = payload
      return 1
    })
    await client.request({})
    expect(seen).toBeUndefined()
  })

  it('writes the payload tail as its own chunk, never copied into the head', async () => {
    const [client, server, log] = pair()
    server.onRequest(async () => 'ok')
    const payload = bytesOf(4096, 0x7e)
    await client.request({ kind: 'x' }, { payload })
    // Two writes for the request: head, then the tail verbatim.
    const [head, tail] = log.aWrites
    expect(head).toBeDefined()
    expect(tail).toBeDefined()
    expect(head!.byteLength).toBeLessThan(64)
    expect(tail!.equals(Buffer.from(payload))).toBe(true)
  })

  it('charges the peer’s byte census with head AND tail, in both directions', async () => {
    const [client, server] = pair()
    server.onRequest(async () => new PayloadReply(undefined, bytesOf(2000, 1)))
    await client.request({ kind: 'x' }, { payload: bytesOf(1000, 2) })
    const tx = client.readTraffic().tx
    const rx = server.readTraffic().rx
    expect(tx.reqMessages).toBe(1)
    expect(tx.reqBytes).toBeGreaterThan(1000)
    expect(tx.reqBytes).toBe(rx.reqBytes)
    expect(client.readTraffic().rx.resBytes).toBeGreaterThan(2000)
    expect(client.readTraffic().rx.resBytes).toBe(server.readTraffic().tx.resBytes)
  })

  it('a payload reply whose request timed out is discarded like any late response', async () => {
    const [client, server] = pair()
    let release: (() => void) | null = null
    server.onRequest(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new PayloadReply(1, bytesOf(2, 0)))
        }),
    )
    await expect(client.request({}, { timeoutMs: 5, payload: bytesOf(1, 0) })).rejects.toThrow(
      /timed out/,
    )
    release!()
    await new Promise((r) => setTimeout(r, 5))
    // Nothing to assert beyond "no crash, no mis-delivery": a later request
    // must still correlate to its own answer.
    server.onRequest(async () => 'later')
    await expect(client.request({})).resolves.toBe('later')
  })
})
