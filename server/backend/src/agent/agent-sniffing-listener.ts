/**
 * One port, two protocols (D856): the agent's HTTP port also speaks TLS.
 *
 * The first byte of a connection decides. A TLS ClientHello starts with the
 * handshake record type `0x16`; HTTP starts with an ASCII method letter. So a
 * plain `curl http://agent:4444` and an `https://agent:4444` both reach the same
 * Fastify instance on the SAME port - the container contract (ports, volumes,
 * the templates that mirror them) does not change.
 *
 * Why this is safe: no HTTP method begins with 0x16 (all are upper-case ASCII
 * letters), and no TLS record begins with a letter, so the two cannot be
 * confused. A client that sends nothing is dropped after {@link SNIFF_TIMEOUT_MS}.
 * A TLS client when no certificate is installed is closed (and counted), never
 * served in the clear. Fastify's `http.Server` is used as-is: both paths hand it a
 * socket through its `connection` event.
 *
 * The serving certificate is swapped with `setSecureContext` - new handshakes use
 * it at once, existing connections keep the old one, nothing restarts.
 */
import * as net from 'node:net'
import { Duplex } from 'node:stream'
import * as tls from 'node:tls'
import type { Server as HttpServer } from 'node:http'

export const TLS_HANDSHAKE_RECORD = 0x16
export const SNIFF_TIMEOUT_MS = 10_000
export const HANDSHAKE_TIMEOUT_MS = 10_000
const STALL_WARN_EVERY_MS = 60_000
/** On shutdown, connections still open after this long are destroyed. */
const CLOSE_GRACE_MS = 2_000

/**
 * The raw socket once its first chunk has been read. Node's HTTP parser and TLS
 * wrapper both read a net.Socket NATIVELY (`socket._handle`), bypassing any bytes
 * already pulled into JS - so handing them the raw socket loses the byte(s) we
 * sniffed. This duplex replays the first chunk and then forwards the socket, and
 * exposes the address fields the servers (and the agent's loopback check) read.
 */
class ReplayDuplex extends Duplex {
  private pending: Buffer | null

  constructor(
    private readonly socket: net.Socket,
    first: Buffer,
  ) {
    super()
    this.pending = first
    socket.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) socket.pause()
    })
    socket.on('end', () => this.push(null))
    socket.on('error', (err) => this.destroy(err))
    socket.on('close', () => this.destroy())
    socket.on('timeout', () => this.emit('timeout'))
  }

  get remoteAddress(): string | undefined {
    return this.socket.remoteAddress
  }
  get remotePort(): number | undefined {
    return this.socket.remotePort
  }
  get remoteFamily(): string | undefined {
    return this.socket.remoteFamily
  }
  get localAddress(): string | undefined {
    return this.socket.localAddress
  }
  get localPort(): number | undefined {
    return this.socket.localPort
  }
  setTimeout(ms: number, callback?: () => void): this {
    this.socket.setTimeout(ms)
    if (callback !== undefined) this.once('timeout', callback)
    return this
  }
  setNoDelay(noDelay?: boolean): this {
    this.socket.setNoDelay(noDelay)
    return this
  }
  setKeepAlive(enable?: boolean, delay?: number): this {
    this.socket.setKeepAlive(enable, delay)
    return this
  }
  ref(): this {
    this.socket.ref()
    return this
  }
  unref(): this {
    this.socket.unref()
    return this
  }

  override _read(): void {
    if (this.pending !== null) {
      const first = this.pending
      this.pending = null
      this.push(first)
    }
    this.socket.resume()
  }
  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (e?: Error | null) => void,
  ): void {
    this.socket.write(chunk, encoding, callback)
  }
  override _final(callback: (e?: Error | null) => void): void {
    this.socket.end(callback)
  }
  override _destroy(error: Error | null, callback: (e?: Error | null) => void): void {
    this.socket.destroy(error ?? undefined)
    callback(error)
  }
}

export interface ServingMaterial {
  readonly keyPem: string
  readonly certPem: string
}

export interface SniffingListener {
  /**
   * Install or replace the TLS certificate (hot swap). Returns `false` - and keeps what was
   * serving - when the material is unusable; a bad file must never take the API down.
   */
  setMaterial(material: ServingMaterial): boolean
  readonly port: number
  /** TLS connections refused because no certificate was installed yet. */
  tlsRefusedCount(): number
  close(): Promise<void>
}

export interface SniffingListenerOptions {
  readonly httpServer: HttpServer
  readonly port: number
  readonly host: string
  readonly material?: ServingMaterial | null
  readonly onTlsRefused?: () => void
  /** Warnings and errors (bad material, stalled handshakes). */
  readonly log?: {
    warn(message: string, extras?: { meta?: Record<string, unknown> }): void
    error(message: string, extras?: { meta?: Record<string, unknown> }): void
  }
  /** A connection that sends nothing is dropped after this long (default 10 s). */
  readonly sniffTimeoutMs?: number
  /** A TLS handshake that is not finished after this long is destroyed (default 10 s). */
  readonly handshakeTimeoutMs?: number
}

export function startSniffingListener(options: SniffingListenerOptions): Promise<SniffingListener> {
  // The serving context. A swap replaces it: every NEW handshake uses the new one,
  // connections already established keep what they negotiated.
  let secureContext: tls.SecureContext | null = null
  let refused = 0

  const sniffTimeoutMs = options.sniffTimeoutMs ?? SNIFF_TIMEOUT_MS
  /** Every live connection, so shutdown can end them instead of waiting on idle keep-alives. */
  const live = new Set<{ destroy(): unknown }>()
  const track = (socket: net.Socket): void => {
    live.add(socket)
    socket.once('close', () => live.delete(socket))
  }
  // A scanner opening many half handshakes must not fill the log: one warning a minute,
  // with how many were suppressed.
  let lastStallWarnAt = 0
  let suppressedStalls = 0
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS

  const setMaterial = (material: ServingMaterial): boolean => {
    try {
      secureContext = tls.createSecureContext({ key: material.keyPem, cert: material.certPem })
      return true
    } catch (error: unknown) {
      options.log?.error(
        'HTTPS material rejected - the previous certificate (or plain HTTP) keeps serving',
        {
          meta: { error: error instanceof Error ? error.message : String(error) },
        },
      )
      return false
    }
  }
  if (options.material !== undefined && options.material !== null) {
    setMaterial(options.material)
  }

  /** A server-side TLS socket over the replayed raw socket, handed to HTTP once secure. */
  const serveTls = (replayed: ReplayDuplex, context: tls.SecureContext): void => {
    const secure = new tls.TLSSocket(replayed, {
      isServer: true,
      secureContext: context,
      minVersion: 'TLSv1.2',
    })
    // The decrypted socket does not carry the peer address of the stream under it, and
    // the agent's auth gate reads it (loopback is trusted, a remote caller is not).
    Object.defineProperty(secure, 'remoteAddress', { value: replayed.remoteAddress })
    Object.defineProperty(secure, 'remotePort', { value: replayed.remotePort })
    secure.on('error', () => undefined)
    // A client that starts a handshake and stalls must not hold a socket for ever.
    const stalled = setTimeout(() => {
      const at = Date.now()
      if (at - lastStallWarnAt >= STALL_WARN_EVERY_MS) {
        options.log?.warn('TLS handshake did not finish in time - connection destroyed', {
          meta: {
            remote: replayed.remoteAddress ?? null,
            afterMs: handshakeTimeoutMs,
            alsoSuppressed: suppressedStalls,
          },
        })
        lastStallWarnAt = at
        suppressedStalls = 0
      } else {
        suppressedStalls += 1
      }
      secure.destroy()
      replayed.destroy()
    }, handshakeTimeoutMs)
    secure.once('close', () => clearTimeout(stalled))
    secure.once('secure', () => {
      clearTimeout(stalled)
      options.httpServer.emit('connection', secure)
    })
  }

  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    track(socket)
    const timer = setTimeout(() => socket.destroy(), sniffTimeoutMs)
    socket.on('error', () => undefined)
    // `data` (not `readable`): the chunk is handed back to the stream with `unshift`
    // before the chosen server takes the socket, so the protocol parser sees every byte.
    socket.once('data', (chunk: Buffer) => {
      clearTimeout(timer)
      socket.pause()
      if (chunk[0] === TLS_HANDSHAKE_RECORD) {
        if (secureContext === null) {
          refused += 1
          options.onTlsRefused?.()
          socket.destroy()
          return
        }
        serveTls(new ReplayDuplex(socket, chunk), secureContext)
      } else {
        options.httpServer.emit('connection', new ReplayDuplex(socket, chunk))
      }
    })
    // The connection arrived paused (`pauseOnConnect`); start reading to see the first byte.
    socket.resume()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: options.port, host: options.host }, () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : options.port
      resolve({
        port,
        setMaterial,
        tlsRefusedCount: () => refused,
        close: () =>
          new Promise<void>((done) => {
            // Stop listening, give in-flight requests a moment, then end every connection:
            // an idle keep-alive would otherwise keep the process (and the port) alive.
            server.close(() => done())
            const grace = setTimeout(() => {
              for (const socket of live) socket.destroy()
            }, CLOSE_GRACE_MS)
            grace.unref?.()
            server.once('close', () => clearTimeout(grace))
          }),
      })
    })
  })
}
