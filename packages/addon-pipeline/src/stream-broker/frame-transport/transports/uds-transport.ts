/**
 * Unix Domain Socket frame transport.
 *
 * Same-host IPC with lower overhead than TCP loopback (no TCP/IP stack
 * traversal, no three-way handshake). Best choice when producer and
 * consumer are on the same machine — roughly 2-3× the throughput of TCP
 * loopback for large binary payloads like decoded frames.
 *
 * Wire:
 *   - URL scheme: `unix:///absolute/path/to/socket.sock`
 *   - Producer calls `listen({socketPath})` → creates the socket file
 *   - Consumer calls `connect("unix:///.../socket.sock")` → opens AF_UNIX
 *   - Bidirectional stream via `net.Socket` (Node treats AF_UNIX as a
 *     regular socket behind the same API)
 *
 * The socket file is removed on `close()` and at server startup if stale.
 * Windows note: Node supports AF_UNIX on Windows 10+ but named pipes may
 * be preferable. This transport uses `net.createServer` which handles
 * AF_UNIX natively on all platforms Node targets.
 */
import net from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import type {
  FrameTransport,
  TransportEndpoint,
  TransportConnection,
  TransportListenOptions,
  TransportConnectOptions,
} from '../types.js'
import type { Unsubscribe } from '@camstack/types'

const URL_SCHEME = 'unix://'

export class UdsTransport implements FrameTransport {
  readonly kind = 'uds' as const

  async listen(options?: TransportListenOptions): Promise<TransportEndpoint> {
    const socketPath =
      options?.socketPath ?? path.join(os.tmpdir(), `camstack-frame-${randomUUID()}.sock`)

    // Remove stale socket file if it exists (common after crash).
    try {
      fs.unlinkSync(socketPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw err
    }

    return new Promise<TransportEndpoint>((resolve, reject) => {
      const connectionHandlers = new Set<(conn: TransportConnection) => void>()
      const connections = new Set<UdsConnection>()

      const server = net.createServer((socket) => {
        const conn = new UdsConnection(socket, () => {
          connections.delete(conn)
        })
        connections.add(conn)
        for (const handler of connectionHandlers) handler(conn)
      })

      server.once('error', (err) => reject(err))

      server.listen(socketPath, () => {
        server.removeAllListeners('error')
        const url = `${URL_SCHEME}${socketPath}`

        const endpoint: TransportEndpoint = {
          kind: 'uds',
          url,
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
            try {
              fs.unlinkSync(socketPath)
            } catch {
              // File may already be gone — ignore.
            }
          },
        }
        resolve(endpoint)
      })
    })
  }

  async connect(url: string, options?: TransportConnectOptions): Promise<TransportConnection> {
    const socketPath = parseUdsUrl(url)
    if (socketPath === null) {
      throw new Error(`UdsTransport: invalid URL "${url}"`)
    }

    const timeoutMs = options?.timeoutMs ?? 10_000

    return new Promise<TransportConnection>((resolve, reject) => {
      const socket = new net.Socket()

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(new Error(`UdsTransport: connect timeout after ${timeoutMs}ms (${url})`))
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
          new UdsConnection(socket, () => {
            /* client-side dispose noop */
          }),
        )
      })

      socket.connect(socketPath)
    })
  }
}

function parseUdsUrl(url: string): string | null {
  if (!url.startsWith(URL_SCHEME)) return null
  const rest = url.slice(URL_SCHEME.length)
  // Expected form: `unix:///abs/path.sock` → rest starts with `/`
  if (!rest.startsWith('/')) return null
  return rest
}

class UdsConnection implements TransportConnection {
  readonly id = randomUUID()
  readonly kind = 'uds' as const
  readonly remoteAddress: string

  private readonly dataHandlers = new Set<(chunk: Uint8Array) => void>()
  private readonly closeHandlers = new Set<(reason?: string) => void>()
  private closed = false

  constructor(
    private readonly socket: net.Socket,
    private readonly onDispose: () => void,
  ) {
    this.remoteAddress = 'unix-peer'

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
