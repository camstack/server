/**
 * TCP frame transport.
 *
 * Wire:
 *   - URL scheme: `tcp://host:port/`
 *   - Producer calls `listen({host, port})` → server bound to a TCP port
 *   - Consumer calls `connect("tcp://host:port/")` → opens a socket
 *   - Bidirectional byte stream via `net.Socket`
 *
 * The transport is framing-agnostic. The codec stacked on top (usually
 * `LengthPrefixCodec`) handles message boundaries.
 *
 * Backpressure: `net.Socket.write()` returns false when the internal
 * buffer is full. We expose `bufferedBytes` (from `socket.writableLength`)
 * so the FrameServer's drop policy can react. We do NOT wait for 'drain'
 * inside `send()` — the caller (FrameServer) decides whether to drop.
 *
 * Max outbound buffer is set via `socket.setDefaultEncoding`-style config;
 * Node's default high-water mark is 16 KB which is too small for video
 * frames. We bump the socket's writable high-water mark at connection time.
 */
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import type {
  FrameTransport,
  TransportEndpoint,
  TransportConnection,
  TransportListenOptions,
  TransportConnectOptions,
} from '../types.js'
import type { Unsubscribe } from '@camstack/types'

const URL_SCHEME = 'tcp://'

export class TcpTransport implements FrameTransport {
  readonly kind = 'tcp' as const

  async listen(options?: TransportListenOptions): Promise<TransportEndpoint> {
    const host = options?.host ?? '127.0.0.1'
    const port = options?.port ?? 0
    return new Promise<TransportEndpoint>((resolve, reject) => {
      const connectionHandlers = new Set<(conn: TransportConnection) => void>()
      const connections = new Set<TcpConnection>()

      const server = net.createServer((socket) => {
        socket.setNoDelay(true)
        const conn = new TcpConnection(socket, () => {
          connections.delete(conn)
        })
        connections.add(conn)
        for (const handler of connectionHandlers) handler(conn)
      })

      server.once('error', (err) => reject(err))

      server.listen(port, host, () => {
        server.removeAllListeners('error')
        const address = server.address()
        if (address === null || typeof address === 'string') {
          server.close()
          reject(new Error('TcpTransport: server.address() returned unexpected value'))
          return
        }
        // Use the actual bound address/port (host may be 0.0.0.0, port may be 0 → OS assigned).
        const boundHost = address.address === '::' ? '0.0.0.0' : address.address
        const url = `${URL_SCHEME}${boundHost}:${address.port}/`
        const namespace = options?.namespace
        const finalUrl = namespace !== undefined ? `${url}${namespace}` : url

        const endpoint: TransportEndpoint = {
          kind: 'tcp',
          url: finalUrl,
          get activeConnections() {
            return connections.size
          },
          onConnection(handler) {
            connectionHandlers.add(handler)
            return () => connectionHandlers.delete(handler)
          },
          async close() {
            for (const conn of Array.from(connections)) {
              conn.close('endpoint-closed')
            }
            await new Promise<void>((res) => {
              server.close(() => res())
            })
          },
        }
        resolve(endpoint)
      })
    })
  }

  async connect(url: string, options?: TransportConnectOptions): Promise<TransportConnection> {
    const parsed = parseTcpUrl(url)
    if (!parsed) {
      throw new Error(`TcpTransport: invalid URL "${url}"`)
    }

    const timeoutMs = options?.timeoutMs ?? 10_000

    return new Promise<TransportConnection>((resolve, reject) => {
      const socket = new net.Socket()
      socket.setNoDelay(true)

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(new Error(`TcpTransport: connect timeout after ${timeoutMs}ms (${url})`))
      }, timeoutMs)

      socket.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })

      socket.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeAllListeners('error')
        resolve(
          new TcpConnection(socket, () => {
            /* client-side dispose noop */
          }),
        )
      })

      socket.connect(parsed.port, parsed.host)
    })
  }
}

function parseTcpUrl(url: string): { host: string; port: number } | null {
  if (!url.startsWith(URL_SCHEME)) return null
  const rest = url.slice(URL_SCHEME.length)
  // Strip trailing path/namespace — only host:port matters for routing.
  const authority = rest.split('/')[0] ?? ''
  const lastColon = authority.lastIndexOf(':')
  if (lastColon === -1) return null
  const host = authority.slice(0, lastColon)
  const port = Number(authority.slice(lastColon + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

class TcpConnection implements TransportConnection {
  readonly id = randomUUID()
  readonly kind = 'tcp' as const
  readonly remoteAddress: string

  private readonly dataHandlers = new Set<(chunk: Uint8Array) => void>()
  private readonly closeHandlers = new Set<(reason?: string) => void>()
  private closed = false

  constructor(
    private readonly socket: net.Socket,
    private readonly onDispose: () => void,
  ) {
    this.remoteAddress =
      socket.remoteAddress !== undefined && socket.remotePort !== undefined
        ? `${socket.remoteAddress}:${socket.remotePort}`
        : 'unknown'

    socket.on('data', (chunk: Buffer) => {
      if (this.closed) return
      for (const handler of this.dataHandlers) handler(chunk)
    })

    const emitClose = (reason?: string) => {
      if (this.closed) return
      this.closed = true
      for (const handler of this.closeHandlers) handler(reason)
      this.onDispose()
    }
    socket.on('close', () => emitClose('socket-closed'))
    socket.on('error', (err) => emitClose(err.message))
    socket.on('end', () => emitClose('peer-ended'))
  }

  send(chunk: Uint8Array): void {
    if (this.closed) return
    // We ignore the boolean returned by write() — the FrameServer's drop
    // policy uses `bufferedBytes` to decide when to back off.
    this.socket.write(chunk)
  }

  onData(handler: (chunk: Uint8Array) => void): Unsubscribe {
    this.dataHandlers.add(handler)
    return () => this.dataHandlers.delete(handler)
  }

  onClose(handler: (reason?: string) => void): Unsubscribe {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(reason?: string): void {
    if (this.closed) return
    this.closed = true
    for (const handler of this.closeHandlers) handler(reason)
    this.socket.destroy()
    this.onDispose()
  }

  get bufferedBytes(): number {
    return this.socket.writableLength
  }
}
