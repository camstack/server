import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UdsLocalTransportServer,
  UdsLocalTransportClient,
} from '../../transport/uds-local-transport.js'
import type { LocalChannel } from '../../transport/local-transport.js'

const sockPath = () =>
  join(tmpdir(), `camstack-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)

describe('UdsLocalTransport', () => {
  let server: UdsLocalTransportServer | null = null
  let client: UdsLocalTransportClient | null = null
  afterEach(async () => {
    await client?.close()
    await server?.close()
  })

  it('child→parent request round-trips over a real UDS', async () => {
    const path = sockPath()
    server = new UdsLocalTransportServer(path)
    server.onConnection((ch: LocalChannel) => ch.onRequest(async (b) => ({ pong: b })))
    await server.listen()

    client = new UdsLocalTransportClient(path)
    const ch = await client.connect()
    await expect(ch.request({ ping: true })).resolves.toEqual({ pong: { ping: true } })
  })

  it('parent→child request round-trips', async () => {
    const path = sockPath()
    server = new UdsLocalTransportServer(path)
    let serverSide: LocalChannel | null = null
    server.onConnection((ch) => {
      serverSide = ch
    })
    await server.listen()

    client = new UdsLocalTransportClient(path)
    const ch = await client.connect()
    ch.onRequest(async (b) => ({ fromChild: b }))
    // wait for the server to observe the connection
    await new Promise((r) => setTimeout(r, 20))
    await expect((serverSide as unknown as LocalChannel).request({ hi: 1 })).resolves.toEqual({
      fromChild: { hi: 1 },
    })
  })

  it('server close fires the channel close handler on the client', async () => {
    const path = sockPath()
    server = new UdsLocalTransportServer(path)
    server.onConnection(() => {})
    await server.listen()
    client = new UdsLocalTransportClient(path)
    const ch = await client.connect()
    const closed = new Promise<void>((resolve) => ch.onClose(resolve))
    await server.close()
    server = null
    await expect(closed).resolves.toBeUndefined()
  })

  it('connect rejects when nothing is listening', async () => {
    client = new UdsLocalTransportClient(sockPath())
    await expect(client.connect()).rejects.toBeTruthy()
  })

  it('listen() twice throws "already listening"', async () => {
    const path = sockPath()
    server = new UdsLocalTransportServer(path)
    await server.listen()
    await expect(server.listen()).rejects.toThrow('already listening')
  })

  it('connect() twice (without close) throws "already connected"', async () => {
    const path = sockPath()
    server = new UdsLocalTransportServer(path)
    server.onConnection(() => {})
    await server.listen()
    client = new UdsLocalTransportClient(path)
    await client.connect()
    await expect(client.connect()).rejects.toThrow('already connected')
  })
})
