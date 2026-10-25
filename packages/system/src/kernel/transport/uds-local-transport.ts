import { createServer, connect, type Server } from 'node:net'
import { unlink } from 'node:fs/promises'
import { SocketChannel } from './socket-channel.js'
import type { LocalChannel, LocalTransportServer, LocalTransportClient } from './local-transport.js'

export class UdsLocalTransportServer implements LocalTransportServer {
  private server: Server | null = null
  private connHandler: (channel: LocalChannel) => void = () => {}
  private readonly channels: Set<SocketChannel> = new Set()

  constructor(private readonly path: string) {}

  onConnection(handler: (channel: LocalChannel) => void): void {
    this.connHandler = handler
  }

  async listen(): Promise<void> {
    if (this.server) throw new Error('UdsLocalTransportServer: already listening')
    if (process.platform !== 'win32') {
      // Remove a stale socket file left by a crashed parent.
      try {
        await unlink(this.path)
      } catch {
        /* none present */
      }
    }
    await new Promise<void>((resolve, reject) => {
      const srv = createServer((socket) => {
        const ch = new SocketChannel(socket)
        this.channels.add(ch)
        ch.onClose(() => this.channels.delete(ch))
        this.connHandler(ch)
      })
      const onErr = (err: Error): void => reject(err)
      srv.once('error', onErr)
      srv.listen(this.path, () => {
        srv.off('error', onErr)
        resolve()
      })
      this.server = srv
    })
  }

  async close(): Promise<void> {
    const srv = this.server
    if (!srv) return
    this.server = null
    // Destroy all active connections so they get a 'close' event promptly.
    for (const ch of this.channels) ch.close()
    this.channels.clear()
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
}

export class UdsLocalTransportClient implements LocalTransportClient {
  private channel: SocketChannel | null = null

  constructor(private readonly path: string) {}

  connect(): Promise<LocalChannel> {
    if (this.channel)
      return Promise.reject(
        new Error('UdsLocalTransportClient: already connected — call close() first'),
      )
    return new Promise<LocalChannel>((resolve, reject) => {
      const socket = connect(this.path)
      const onErr = (err: Error): void => {
        socket.off('connect', onConn)
        reject(err)
      }
      const onConn = (): void => {
        socket.off('error', onErr)
        const ch = new SocketChannel(socket)
        this.channel = ch
        resolve(ch)
      }
      socket.once('connect', onConn)
      socket.once('error', onErr)
    })
  }

  async close(): Promise<void> {
    this.channel?.close()
    this.channel = null
  }
}
