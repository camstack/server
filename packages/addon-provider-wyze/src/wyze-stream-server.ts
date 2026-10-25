/**
 * Per-camera RFC 4571 server lifecycle manager.
 *
 * Wraps the lib's `createWyzeRfc4571Server`, which opens the P2P/DTLS
 * session eagerly (it `await conn.connect()` + waits for the first
 * keyframe to build the SDP) and exposes a loopback `tcp://host:port`
 * RFC 4571 RTP stream — byte-for-byte the broker's `pull-rfc4571` source
 * contract.
 *
 * Lifecycle (mirrors Reolink's `ensureRfc4571Server`):
 *   - open ONLY in `ensure()` (broker-demand-driven, never at catalog
 *     pull time), so idle cameras stay un-connected.
 *   - self-heal: the lib's 10s health monitor closes a dead stream and
 *     fires `onServerClose`; we evict the cache so the next `ensure()`
 *     re-dials a fresh server.
 *   - idle teardown: on the last client disconnect, schedule an explicit
 *     `close()` after a grace window.
 */

import { createWyzeRfc4571Server } from '@apocaliss92/wyze-bridge-js'
import type { WyzeCamera, WyzeRfc4571Server } from '@apocaliss92/wyze-bridge-js'
import type { IScopedLogger } from '@camstack/types'

export interface WyzeStreamServerDeps {
  readonly logger: IScopedLogger
  /** Idle grace before tearing down a server with no clients (ms). */
  readonly idleTimeoutMs?: number
}

export interface MaterializeParams {
  readonly camera: WyzeCamera
  readonly frameSize: number
  readonly bitrate: number
}

/** A console-shaped logger adapter the lib expects (`.log`/`.error`/…). */
function libLogger(logger: IScopedLogger): Console {
  const child = logger.child('wyze-lib')
  const wrap =
    (level: 'info' | 'warn' | 'error' | 'debug') =>
    (...args: unknown[]) => {
      const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      child[level](message)
    }
  const adapter: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'> = {
    log: wrap('info'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    debug: wrap('debug'),
  }
  // The lib only calls `.log`/`.info`/`.warn`/`.error`/`.debug`. Coerce
  // structurally through `unknown` — documented type boundary.
  return adapter as Console
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000

export class WyzeStreamServerManager {
  private readonly deps: WyzeStreamServerDeps
  private server: WyzeRfc4571Server | null = null
  private materializing: Promise<WyzeRfc4571Server | null> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: WyzeStreamServerDeps) {
    this.deps = deps
  }

  /**
   * Ensure a live RFC 4571 server, opening the P2P session on demand.
   * Idempotent + single-flighted: concurrent broker dials share one
   * open. Returns `null` when the P2P session could not be established.
   */
  async ensure(params: MaterializeParams): Promise<WyzeRfc4571Server | null> {
    if (this.server) return this.server
    if (this.materializing) return this.materializing
    const run = this.open(params).finally(() => {
      this.materializing = null
    })
    this.materializing = run
    return run
  }

  private async open(params: MaterializeParams): Promise<WyzeRfc4571Server | null> {
    this.clearIdleTimer()
    let server: WyzeRfc4571Server
    try {
      server = await createWyzeRfc4571Server({
        camera: params.camera,
        frameSize: params.frameSize,
        bitrate: params.bitrate,
        host: '127.0.0.1',
        logger: libLogger(this.deps.logger),
      })
    } catch (err) {
      this.deps.logger.error('wyze rfc4571: failed to open P2P stream server', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }

    this.server = server

    // Self-heal: when the lib's health monitor (or an external close)
    // tears the server down, drop our cached reference so the next
    // `ensure()` re-dials a fresh server on a new ephemeral port.
    server.onServerClose((reason: string) => {
      if (this.server === server) {
        this.server = null
        this.clearIdleTimer()
        this.deps.logger.info('wyze rfc4571: server closed — evicting cache', {
          meta: { reason },
        })
      }
    })

    // Idle teardown: when the last broker client disconnects, schedule an
    // explicit close after the grace window. A re-dial inside the window
    // cancels it (clients > 0).
    server.onClientDisconnect((remaining: number) => {
      if (remaining > 0) {
        this.clearIdleTimer()
        return
      }
      this.scheduleIdleTeardown()
    })

    this.deps.logger.info('wyze rfc4571: server listening', {
      meta: {
        host: server.host,
        port: server.port,
        videoType: server.videoType,
        camera: params.camera.nickname,
      },
    })
    return server
  }

  private scheduleIdleTeardown(): void {
    this.clearIdleTimer()
    const ms = this.deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.idleTimer = setTimeout(() => {
      const server = this.server
      if (!server) return
      if (server.clientCount > 0) return
      this.deps.logger.debug('wyze rfc4571: idle teardown', {})
      void this.close('idle')
    }, ms)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** Current live server (for snapshot / intercom access), if any. */
  get current(): WyzeRfc4571Server | null {
    return this.server
  }

  /** Close the active server (closes the underlying WyzeDTLSConn). */
  async close(reason: string): Promise<void> {
    this.clearIdleTimer()
    const server = this.server
    this.server = null
    if (!server) return
    try {
      await server.close()
    } catch (err) {
      this.deps.logger.debug('wyze rfc4571: close failed', {
        meta: { reason, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
