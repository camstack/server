import type { Connection, Auth as HaAuth } from 'home-assistant-js-websocket'
import { createConnection, createLongLivedTokenAuth } from 'home-assistant-js-websocket'
import type { HaAuthConfig } from './ha-types.js'

/**
 * Minimal Auth implementation for the Supervisor case. The
 * `home-assistant-js-websocket` library expects an `Auth`-shaped
 * object with `{ wsUrl, accessToken, expired, refreshAccessToken }` —
 * we provide it directly because the Supervisor token never expires
 * (it's reissued by the Supervisor itself on every container start).
 *
 * For the long-lived-token case the library ships `createLongLivedTokenAuth`
 * — we delegate to it.
 */
class SupervisorAuth {
  constructor(private readonly supervisorToken: string) {}

  // The `home-assistant-js-websocket` Auth contract uses these property
  // shapes (defined upstream in `auth.ts`). We mirror the shape exactly
  // without `implements` because Auth is a class type, not an interface.
  readonly wsUrl = 'ws://supervisor/core/websocket'
  readonly expired = false

  get accessToken(): string {
    return this.supervisorToken
  }

  async refreshAccessToken(): Promise<void> {
    // No-op — Supervisor injects a fresh token on container start.
  }

  get data(): { access_token: string; expires: number } {
    return {
      access_token: this.supervisorToken,
      // Far-future expiry — the Supervisor reissues on container start,
      // not via the token's own lifetime.
      expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    }
  }
}

/** Builds an `Auth` instance per the addon's configured strategy. */
export function buildHaAuth(config: HaAuthConfig): HaAuth {
  if (config.kind === 'supervisor') {
    return new SupervisorAuth(config.supervisorToken) as unknown as HaAuth // TECH-DEBT: home-assistant-js Auth nominal types
  }
  return createLongLivedTokenAuth(config.baseUrl, config.accessToken)
}

/**
 * Connection-lifecycle wrapper. Maintains a single live `Connection`
 * with exponential-backoff reconnect on transport drop, exposes a
 * promise-based ready signal, and surfaces state transitions through
 * caller-supplied callbacks.
 *
 * The wrapper does NOT own the entity subscription — that's
 * `subscribeEntities` in `ha-events.ts`. This class owns ONLY the
 * connection itself; consumers (HaHub in Phase E) re-subscribe in
 * the `onConnected` callback after reconnect.
 *
 * Backoff schedule:
 *   - 1s, 2s, 4s, 8s, 16s, 30s (caps at 30s).
 *   - Resets to 1s on every successful connection.
 */
export interface HaWsClientCallbacks {
  /** Called every time a new live `Connection` becomes available
   *  (initial connect + every successful reconnect). */
  onConnected: (connection: Connection) => void | Promise<void>
  /** Called every time the transport drops. The wrapper will then
   *  attempt to reconnect with backoff. */
  onDisconnected: (error?: unknown) => void
  /** Called on every failed reconnect attempt. */
  onReconnectError: (error: unknown, nextDelayMs: number) => void
}

export interface HaWsClientOptions {
  readonly auth: HaAuthConfig
  readonly callbacks: HaWsClientCallbacks
  /** Override the default backoff schedule (mostly for tests). */
  readonly backoffSchedule?: readonly number[]
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

export class HaWsClient {
  private connection: Connection | null = null
  private stopRequested = false
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private readonly backoff: readonly number[]

  constructor(private readonly opts: HaWsClientOptions) {
    this.backoff = opts.backoffSchedule ?? DEFAULT_BACKOFF_MS
  }

  /** Open the connection. Throws on the FIRST authentication failure
   *  (config error) so the caller fails fast; subsequent transport
   *  drops are recovered via backoff. */
  async start(): Promise<void> {
    this.stopRequested = false
    this.reconnectAttempt = 0
    await this.openConnectionOnce()
  }

  /** Close the connection and cancel any pending reconnect. Idempotent. */
  stop(): void {
    this.stopRequested = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.connection) {
      this.connection.close()
      this.connection = null
    }
  }

  /** Returns the current live connection, or null if not connected. */
  getConnection(): Connection | null {
    return this.connection
  }

  private async openConnectionOnce(): Promise<void> {
    const auth = buildHaAuth(this.opts.auth)
    this.connection = await createConnection({ auth })
    this.reconnectAttempt = 0

    this.connection.addEventListener('disconnected', () => {
      this.handleTransportDrop()
    })
    this.connection.addEventListener('ready', () => {
      // 'ready' fires after every successful (re)connection inside the
      // hass-js-ws's own internal reconnect — we treat it as a signal
      // to re-emit `onConnected` so subscribers re-subscribe.
      if (this.connection) {
        void this.opts.callbacks.onConnected(this.connection)
      }
    })

    await this.opts.callbacks.onConnected(this.connection)
  }

  private handleTransportDrop(): void {
    if (this.stopRequested) return
    const previousConnection = this.connection
    this.connection = null
    this.opts.callbacks.onDisconnected()
    if (previousConnection) {
      previousConnection.close()
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopRequested) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    const idx = Math.min(this.reconnectAttempt, this.backoff.length - 1)
    const delay = this.backoff[idx]!
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.attemptReconnect()
    }, delay)
  }

  private async attemptReconnect(): Promise<void> {
    if (this.stopRequested) return
    try {
      await this.openConnectionOnce()
    } catch (err: unknown) {
      const idx = Math.min(this.reconnectAttempt, this.backoff.length - 1)
      const nextDelay = this.backoff[idx]!
      this.opts.callbacks.onReconnectError(err, nextDelay)
      this.scheduleReconnect()
    }
  }
}
