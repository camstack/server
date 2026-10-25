import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import { StreamPipeServer } from '../stream-broker/stream-pipe-server'
import type { IScopedLogger } from '@camstack/types'

function createMockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

function connectToServer(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      resolve(socket)
    })
    socket.on('error', reject)
  })
}

function collectData(socket: net.Socket, byteCount: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let received = 0

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      received += chunk.length
      if (received >= byteCount) {
        resolve(Buffer.concat(chunks))
      }
    })
  })
}

describe('StreamPipeServer', () => {
  let server: StreamPipeServer

  afterEach(async () => {
    if (server?.isStarted()) {
      await server.stop()
    }
  })

  it('starts and listens on a port', async () => {
    server = new StreamPipeServer()
    await server.start()

    expect(server.getPort()).toBeGreaterThan(0)
    expect(server.getUrl()).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/)
    expect(server.isStarted()).toBe(true)
  })

  it('accepts client connections', async () => {
    server = new StreamPipeServer()
    await server.start()

    const client = await connectToServer(server.getPort())
    // Give the server a tick to register the connection
    await new Promise((r) => setTimeout(r, 50))

    expect(server.getClientCount()).toBe(1)

    client.destroy()
    await new Promise((r) => setTimeout(r, 50))

    expect(server.getClientCount()).toBe(0)
  })

  it('broadcasts data to a connected client', async () => {
    server = new StreamPipeServer()
    await server.start()

    const client = await connectToServer(server.getPort())
    await new Promise((r) => setTimeout(r, 50))

    const data = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0xaa, 0xbb])
    const received = collectData(client, data.length)

    server.broadcast(data)

    const result = await received
    expect(result.subarray(0, data.length)).toEqual(data)

    client.destroy()
  })

  it('broadcasts same data to multiple clients', async () => {
    server = new StreamPipeServer()
    await server.start()

    const client1 = await connectToServer(server.getPort())
    const client2 = await connectToServer(server.getPort())
    await new Promise((r) => setTimeout(r, 50))

    expect(server.getClientCount()).toBe(2)

    const data = Buffer.from('hello-stream')
    const received1 = collectData(client1, data.length)
    const received2 = collectData(client2, data.length)

    server.broadcast(data)

    const [result1, result2] = await Promise.all([received1, received2])

    expect(result1.subarray(0, data.length)).toEqual(data)
    expect(result2.subarray(0, data.length)).toEqual(data)

    client1.destroy()
    client2.destroy()
  })

  it('handles client disconnect gracefully', async () => {
    server = new StreamPipeServer()
    await server.start()

    const client = await connectToServer(server.getPort())
    await new Promise((r) => setTimeout(r, 50))

    expect(server.getClientCount()).toBe(1)

    client.destroy()
    await new Promise((r) => setTimeout(r, 50))

    expect(server.getClientCount()).toBe(0)

    // Broadcasting after disconnect should not throw
    server.broadcast(Buffer.from('test'))
  })

  it('stop closes all connections', async () => {
    server = new StreamPipeServer()
    await server.start()

    const client1 = await connectToServer(server.getPort())
    const client2 = await connectToServer(server.getPort())
    await new Promise((r) => setTimeout(r, 50))

    expect(server.getClientCount()).toBe(2)

    await server.stop()

    expect(server.getClientCount()).toBe(0)
    expect(server.isStarted()).toBe(false)

    // Wait for client sockets to receive the FIN/RST
    await new Promise((r) => setTimeout(r, 100))

    // Server-side sockets were destroyed, so clients should see the connection close
    expect(client1.readableEnded || client1.destroyed).toBe(true)
    expect(client2.readableEnded || client2.destroyed).toBe(true)
  })

  it('is idempotent for start and stop', async () => {
    server = new StreamPipeServer()

    // Double start should not throw
    await server.start()
    const port = server.getPort()
    await server.start()
    expect(server.getPort()).toBe(port)

    // Double stop should not throw
    await server.stop()
    await server.stop()
  })

  it('uses logger when provided', async () => {
    const logger = createMockLogger()
    server = new StreamPipeServer(logger)
    await server.start()

    expect(logger.debug).toHaveBeenCalledWith('StreamPipeServer listening', expect.anything())

    const client = await connectToServer(server.getPort())
    await new Promise((r) => setTimeout(r, 50))

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('client connected'),
      expect.anything(),
    )

    client.destroy()
    await new Promise((r) => setTimeout(r, 50))

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('client disconnected'),
      expect.anything(),
    )

    await server.stop()

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('StreamPipeServer stopped'))
  })

  it('broadcast is a no-op when no clients are connected', () => {
    server = new StreamPipeServer()
    // Should not throw even before start
    server.broadcast(Buffer.from('test'))
  })
})
