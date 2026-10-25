import { describe, it, expect, afterEach } from 'vitest'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import type { LocalTransportServer, LocalTransportClient } from '../../transport/local-transport.js'

describe('createLocalTransport', () => {
  let server: LocalTransportServer | null = null
  let client: LocalTransportClient | null = null
  afterEach(async () => {
    await client?.close()
    await server?.close()
  })

  it('produces a server+client that interoperate by nodeId', async () => {
    const factory = createLocalTransport()
    const nodeId = `hub-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    server = factory.createServer(nodeId)
    server.onConnection((ch) => ch.onRequest(async (b) => b))
    await server.listen()

    client = factory.createClient(nodeId)
    const ch = await client.connect()
    await expect(ch.request('hello')).resolves.toBe('hello')
  })
})
