import net from 'node:net'
import type { IScopedLogger } from '@camstack/types'

/**
 * A lightweight TCP server that broadcasts raw encoded video bytes
 * (H.264/H.265 Annex-B) to all connected clients.
 *
 * Each StreamBroker owns one StreamPipeServer. Restreamers (e.g. restreamer)
 * connect via `tcp://127.0.0.1:{port}` and receive the same byte stream
 * that the broker reads from the camera, eliminating duplicate RTSP
 * connections.
 */
/** Max bytes queued in a client's write buffer before we consider it too slow */
const MAX_WRITE_BUFFER_BYTES = 2 * 1024 * 1024 // 2 MB

export class StreamPipeServer {
  private readonly server: net.Server
  private readonly clients: Set<net.Socket> = new Set()
  private port = 0
  private started = false
  private readonly logger: IScopedLogger | undefined
  private _onClientCountChanged: (() => void) | null = null

  /** Register a callback invoked when pipe client count changes. */
  onClientCountChanged(cb: () => void): void {
    this._onClientCountChanged = cb
  }

  constructor(logger?: IScopedLogger) {
    this.logger = logger
    this.server = net.createServer((socket) => {
      this.handleConnection(socket)
    })

    this.server.on('error', (err) => {
      this.logger?.error('StreamPipeServer error', { meta: { error: err.message } })
    })
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        const address = this.server.address() as net.AddressInfo
        this.port = address.port
        this.started = true
        this.logger?.debug('StreamPipeServer listening', { meta: { port: this.port } })
        resolve()
      })
    })
  }

  /**
   * Broadcast raw encoded bytes to all connected clients.
   * Silently drops data for clients that are slow or disconnected.
   */
  broadcast(data: Buffer): void {
    for (const client of this.clients) {
      if (client.destroyed) {
        this.clients.delete(client)
        continue
      }

      // Drop data for slow clients instead of letting buffers grow unbounded
      if (client.writableLength > MAX_WRITE_BUFFER_BYTES) {
        this.logger?.warn('StreamPipeServer client buffer overflow — dropping client', {
          meta: { bufferMB: Number((client.writableLength / 1024 / 1024).toFixed(1)) },
        })
        this.removeClient(client)
        continue
      }

      client.write(data, (err) => {
        if (err) {
          this.logger?.debug('StreamPipeServer write error, removing client', {
            meta: { error: err.message },
          })
          this.removeClient(client)
        }
      })
    }
  }

  getPort(): number {
    return this.port
  }

  getUrl(): string {
    return `tcp://127.0.0.1:${this.port}`
  }

  getClientCount(): number {
    return this.clients.size
  }

  isStarted(): boolean {
    return this.started
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return
    }

    this.started = false
    this._onClientCountChanged = null

    for (const client of this.clients) {
      client.destroy()
    }
    this.clients.clear()

    await new Promise<void>((resolve) => {
      this.server.close(() => {
        this.logger?.debug('StreamPipeServer stopped')
        resolve()
      })
    })
  }

  private handleConnection(socket: net.Socket): void {
    this.clients.add(socket)
    this.logger?.debug('StreamPipeServer client connected', { meta: { total: this.clients.size } })
    this._onClientCountChanged?.()

    socket.on('close', () => {
      this.removeClient(socket)
    })

    socket.on('error', () => {
      this.removeClient(socket)
    })
  }

  private removeClient(socket: net.Socket): void {
    const existed = this.clients.delete(socket)
    if (existed) {
      this.logger?.debug('StreamPipeServer client disconnected', {
        meta: { total: this.clients.size },
      })
      this._onClientCountChanged?.()
    }
    if (!socket.destroyed) {
      socket.destroy()
    }
  }
}
