import { describe, it, expect } from 'vitest'
import { Socket } from 'node:net'
import { SocketChannel } from '../../transport/socket-channel.js'
import { PeerAnsweredError } from '../../transport/peer-answered-error.js'

/** Two SocketChannels wired over an in-memory socket pair (no real fd). */
function pair(): [SocketChannel, SocketChannel] {
  const a = new Socket()
  const b = new Socket()
  // Cross-wire writes: what A writes, B receives, and vice-versa.
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

describe('SocketChannel', () => {
  it('round-trips a request to a response', async () => {
    const [client, server] = pair()
    server.onRequest(async (body) => ({ echo: body }))
    await expect(client.request({ ping: 1 })).resolves.toEqual({ echo: { ping: 1 } })
  })

  it('rejects when the remote handler throws', async () => {
    const [client, server] = pair()
    server.onRequest(async () => {
      throw new Error('boom')
    })
    await expect(client.request({})).rejects.toThrow('boom')
  })

  it('marks an error the far end ANSWERED as such — the call was delivered', async () => {
    const [client, server] = pair()
    server.onRequest(async () => {
      throw new Error('No home preset configured for this camera')
    })
    const thrown = await client.request({}).catch((err: unknown) => err)
    expect(thrown).toBeInstanceOf(PeerAnsweredError)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('No home preset configured for this camera')
  })

  it('correlates concurrent requests independently', async () => {
    const [client, server] = pair()
    server.onRequest(async (body) => (body as { n: number }).n * 2)
    const [a, b, c] = await Promise.all([
      client.request({ n: 1 }),
      client.request({ n: 2 }),
      client.request({ n: 3 }),
    ])
    expect([a, b, c]).toEqual([2, 4, 6])
  })

  it('delivers one-way events', async () => {
    const [client, server] = pair()
    const got: unknown[] = []
    server.onEvent((b) => got.push(b))
    client.emit({ tick: 1 })
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([{ tick: 1 }])
  })

  it('rejects in-flight requests on close', async () => {
    const [client, server] = pair()
    server.onRequest(() => new Promise(() => {})) // never resolves
    const p = client.request({})
    client.close()
    await expect(p).rejects.toThrow('channel closed')
    // A close is a TRANSPORT failure: nobody answered.
    await expect(p).rejects.not.toBeInstanceOf(PeerAnsweredError)
  })
})
