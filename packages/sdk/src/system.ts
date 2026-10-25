/**
 * System — single, unified entry point for the camstack client API.
 *
 * Devices are returned as typed `DeviceProxy` objects (auto-injecting
 * `deviceId` + `nodeId`), system caps are exposed as typed namespaces
 * (`system.userManagement`, `system.storage`, etc.), and live events
 * flow through a single `subscribeEvent` helper.
 *
 * The escape hatches (`trpcClient`, `wsClient`) are still public so the
 * ui-library Provider can seed React Query with the same WS connection
 * — a future phase will narrow the surface further.
 */

import {
  createTRPCClient,
  createWSClient,
  wsLink,
  httpLink,
  splitLink,
  type TRPCClient,
} from '@trpc/client'
import superjson from 'superjson'
import { SystemMirror, createSystemProxy } from '@camstack/types/client'
import type {
  DeviceBinding,
  DeviceProxy,
  DeviceInfo,
  DeviceQueryFilters,
  DeviceLifecycleListener,
  SystemMirrorApi,
  SystemProxy,
  AddonApi,
  PasskeySummary,
} from '@camstack/types'
import type { BackendAppRouter } from './backend-router.js'
import type { BackendConnectionState } from './types.js'
import { jwtExpiresAt } from './session-keeper.js'

/**
 * Second-factor kinds reported by `auth.login`. Kept in the SDK (not
 * imported from a cap) because it's a login-flow contract, not a cap
 * surface. `totp` → the `user-management` TOTP surface; `passkey` → any
 * `user-passkeys` cap provider.
 */
export type SecondFactorKind = 'totp' | 'passkey'

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Canonical user-info shape returned by `getMe()`. Mirrors the server's
 * `auth.me` output — kept narrow so SDK consumers don't need the full
 * tRPC inference chain to type a login flow.
 */
export interface UserInfo {
  readonly id: string
  readonly username: string
  readonly isAdmin: boolean
  readonly permissions?: {
    readonly allowedAddons?: ReadonlyArray<string> | '*'
    readonly allowedDevices?: Readonly<Record<string, ReadonlyArray<string> | '*'>>
  }
}

export interface SystemConfig {
  /** Backend server URL (e.g. "http://localhost:4443"). */
  readonly serverUrl: string
  /** JWT token for authentication. */
  readonly token?: string
  /** Use WebSocket transport (default: true in browser, false in Node). */
  readonly useWebSocket?: boolean
  /** Optional per-event connection-state callback. */
  readonly onConnectionChange?: (state: BackendConnectionState) => void
  /** Initial WS reconnect delay in ms (default 2000, capped via maxRetryDelayMs). */
  readonly retryDelayMs?: number
  /** Max WS reconnect delay in ms (default 30_000). */
  readonly maxRetryDelayMs?: number
  /**
   * The client's current UI language (e.g. `'it'`), read on EVERY request so a
   * language switch applies without a reconnect. Sent as the `x-camstack-lang`
   * header (HTTP) and the `lang` connection param (WS); the hub answers settings
   * labels and error messages in it (D863). Absent / `undefined` = the hub decides
   * from `Accept-Language`.
   */
  readonly getLanguage?: () => string | undefined
  /**
   * Obtain a fresh access token (normally `SessionKeeper.refreshNow` /
   * `ensureFresh`, which ends in `setToken`). Called BEFORE a socket handshake
   * whose token is expired or was just refused with close code 4401. The
   * refresh itself runs over HTTP (`refreshSession` never uses the socket). A
   * rejection is swallowed: the handshake then goes out anonymous rather than
   * carrying a token the hub is known to refuse.
   */
  readonly refreshCredential?: (reason: CredentialRefreshReason) => Promise<void>
}

/** Why `SystemConfig.refreshCredential` is asked: the token's own `exp`, or a 4401 close. */
export type CredentialRefreshReason = 'expired' | 'rejected'

type ConnectionListener = (state: BackendConnectionState, version: number) => void

/** Options of every login leg. */
export interface LoginOptions {
  /** Ask for a short access token + a rotating refresh token (recommended). */
  readonly refreshable?: boolean
}

/** What a login leg returns: a session, or a second-factor challenge. */
export interface LoginOutcome {
  readonly token: string
  readonly requiresTotp?: boolean
  readonly secondFactors?: readonly SecondFactorKind[]
  /** When the access token expires (epoch ms). */
  readonly expiresAt?: number
  /** The server-side login session. */
  readonly sessionId?: string
  /** When the session expires unless refreshed (epoch ms). */
  readonly sessionExpiresAt?: number
  /** Only for `refreshable: true` — swap it at `refreshSession` before `expiresAt`. */
  readonly refreshToken?: string
}

/** What `refreshSession` returns. */
export interface RefreshedSession {
  readonly token: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly sessionId: string
  readonly sessionExpiresAt: number
  readonly user: { readonly id: string; readonly username: string; readonly isAdmin: boolean }
}

function refreshFlag(options: LoginOptions): { refreshable?: true } {
  return options.refreshable === true ? { refreshable: true } : {}
}

// Dispatch shape for the live.onEvent subscription callback. The
// underlying tRPC procedure pushes `{ id, timestamp, source, category,
// data }` per event. Consumers usually only care about `data` typed
// per-category; the SDK exposes the raw envelope so categories with
// custom routing fields stay accessible.
export interface SystemLiveEvent<TData = unknown> {
  readonly id: string
  readonly timestamp: Date | string
  readonly source: { readonly type: string; readonly id: string | number }
  readonly category: string
  readonly data: TData
}

export type SystemLiveEventListener<TData = unknown> = (event: SystemLiveEvent<TData>) => void

// ─── Constants ──────────────────────────────────────────────────────

const WS_KEEP_ALIVE_INTERVAL_MS = 10_000
// 6s (was 3s): a 3s pong window tripped "server unreachable" on any brief hub
// event-loop hiccup under load. 6s tolerates a transient stall while still
// detecting a real disconnect well within one keepalive interval.
const WS_KEEP_ALIVE_PONG_TIMEOUT_MS = 6_000
const WS_RECONNECT_RETRY_DELAY_MS = 2_000
/** Close code the hub sends a socket whose bearer resolved to nobody. */
const SESSION_ENDED_CLOSE_CODE = 4401
/** A token this close to its `exp` is refreshed before it rides a handshake. */
const HANDSHAKE_EXPIRY_SKEW_MS = 15_000
/**
 * Procedures a client calls BEFORE it holds a usable credential (login legs,
 * the refresh itself, the login-method list). They run over anonymous HTTP:
 * the socket answers a dead bearer by closing, and these calls are exactly
 * what recovers from one.
 */
const PRE_AUTH_PATHS: ReadonlySet<string> = new Set([
  'auth.refreshSession',
  'auth.listLoginMethods',
  'auth.getServerName',
  'auth.login',
  'auth.loginVerifyTotp',
  'auth.loginBeginPasskey',
  'auth.loginVerifyPasskey',
  'auth.passkeyLoginBegin',
  'auth.passkeyLoginFinish',
])
const WS_RECONNECT_MAX_RETRY_DELAY_MS = 30_000

// ─── Class ──────────────────────────────────────────────────────────

type TrpcClient = TRPCClient<BackendAppRouter>
type TrpcWsClient = ReturnType<typeof createWSClient>

export class System {
  /** Active server base URL. Mutable via `switchServerUrl()` so the
   *  endpoint-race helper can pivot the transport onto a LAN candidate
   *  after the initial public-URL bootstrap. */
  private _serverUrl: string
  private readonly useWs: boolean
  private readonly baseRetryMs: number
  private readonly maxRetryMs: number
  private readonly onConnectionChange: ((state: BackendConnectionState) => void) | undefined

  private token: string | undefined
  private readonly getLanguage: () => string | undefined
  private readonly refreshCredential:
    | ((reason: CredentialRefreshReason) => Promise<void>)
    | undefined
  private _trpcClient: TrpcClient
  private _wsClient: TrpcWsClient | null = null
  /**
   * One underlying `live.onEvent` subscription per DISTINCT category, fanned
   * out to every listener.
   *
   * Measured on the viewer's boot: ~40 subscriptions, of which 24 were twelve
   * cameras subscribing to the SAME two motion categories and filtering by
   * deviceId in their own callbacks. Each was its own WS handshake on a
   * transport that does not batch. Deduping here needs no protocol change and
   * no cooperation from callers — `subscribeEvent` keeps its exact shape.
   */
  private readonly _eventSubs = new Map<
    string,
    { readonly listeners: Set<(event: unknown) => void>; unsubscribe: () => void }
  >()

  // Mirror — owns binding cache + state mirror + lifecycle listeners.
  // Lazily initialised on `init()`. Subsequent `reconnect()` disposes
  // the old mirror and rebuilds against the new tRPC client.
  private mirror: SystemMirror | null = null
  private mirrorInit: Promise<void> | null = null

  // Transport-readiness probe state. `connected` flips true the first
  // time `auth.me` succeeds against the current tRPC client; resets
  // on every `reconnect()` / `close()` so the next consumer waits for
  // a fresh handshake before issuing queries.
  private connected = false
  /**
   * The token the current socket's handshake carried (`undefined` token =
   * anonymous handshake); `null` until a handshake has been attempted.
   */
  private _wsHandshake: { readonly token: string | undefined } | null = null
  /** The token the hub closed a socket for (4401): never handshaken again. */
  private _rejectedToken: string | undefined
  private connectedPromise: Promise<void> | null = null

  // System-cap namespaces — populated in the constructor from
  // `createSystemProxy(api)`. Each namespace is a `Pick<InferProvider<typeof cap>, …>`
  // shape generated by `scripts/generate-system-proxy.ts`.
  private _systemProxy: SystemProxy

  // Connection-version + listener bookkeeping for the admin UI's
  // reconnect watchdog.
  private _connectionVersion = 0
  /**
   * Bumped on every `reconnect()` BEFORE the previous socket is closed.
   * WS `onOpen`/`onClose` close over the epoch at `createWSClient` time
   * so a delayed close from a torn-down socket cannot mark the replacement
   * as disconnected (the LAN-switch shape: health 3/3, APIs then "offline").
   */
  private _wsEpoch = 0
  private readonly connectionListeners = new Set<ConnectionListener>()

  constructor(config: SystemConfig) {
    this._serverUrl = config.serverUrl.replace(/\/+$/, '')
    this.token = config.token
    this.getLanguage = config.getLanguage ?? (() => undefined)
    this.refreshCredential = config.refreshCredential

    const isBrowser = typeof window !== 'undefined'
    this.useWs = config.useWebSocket ?? isBrowser
    this.onConnectionChange = config.onConnectionChange
    this.baseRetryMs = config.retryDelayMs ?? WS_RECONNECT_RETRY_DELAY_MS
    this.maxRetryMs = config.maxRetryDelayMs ?? WS_RECONNECT_MAX_RETRY_DELAY_MS

    this._trpcClient = this.buildTrpcClient()
    this._systemProxy = createSystemProxy(this._trpcClient as AddonApi)
  }

  // ── Connection state ─────────────────────────────────────────────

  /** Active server base URL (no trailing slash). */
  get serverUrl(): string {
    return this._serverUrl
  }

  get connectionVersion(): number {
    return this._connectionVersion
  }

  /**
   * Subscribe to connection-state transitions. Called with `('connected'
   * | 'disconnected' | 'connecting', version)` whenever the SDK opens,
   * closes, or starts a manual reconnect. Listener errors are swallowed
   * so a misbehaving consumer cannot break the SDK's event loop.
   */
  subscribeConnectionEvents(cb: ConnectionListener): () => void {
    this.connectionListeners.add(cb)
    return () => {
      this.connectionListeners.delete(cb)
    }
  }

  private emitConnectionEvent(state: BackendConnectionState): void {
    try {
      this.onConnectionChange?.(state)
    } catch {
      /* swallow caller errors */
    }
    for (const l of this.connectionListeners) {
      try {
        l(state, this._connectionVersion)
      } catch {
        /* swallow listener errors */
      }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Wait until the underlying tRPC transport is connected AND the
   * server has responded to a cheap auth round-trip (`auth.me`). This
   * is the canonical "ready to issue queries" gate.
   *
   * Why a probe, not just `ws.readyState === OPEN`?
   *   The WS handshake completes asynchronously: tRPC's `wsLink`
   *   queues outgoing messages and only flushes them after `open()`
   *   resolves (post `connectionParams` send). On the server, the
   *   tRPC context is created lazily once the connectionParams
   *   message is received. A query fired between WS-open and
   *   connection-params-processed is technically queued by tRPC, but
   *   the auth context for that query is only resolved once the
   *   handshake message is decoded server-side. A probe round-trip is
   *   the safest way to confirm both sides have agreed on the auth
   *   identity before the React tree starts firing parallel queries
   *   (which can otherwise land before any addon-side service
   *   discovery has settled, returning empty results that get cached).
   *
   * Idempotent — concurrent callers await the same in-flight Promise.
   * Bounded by `timeoutMs` (default 15s) — beyond which a
   * `Error('System.awaitConnected: probe timed out after Xms')` is
   * thrown so the host can render a clear error state instead of
   * hanging on a bricked socket.
   */
  async awaitConnected(timeoutMs?: number): Promise<void> {
    if (this.connected) return
    if (this.connectedPromise) return this.connectedPromise
    const effectiveTimeoutMs = timeoutMs ?? 15_000
    this.connectedPromise = (async () => {
      const probe = this._trpcClient.auth.me.query()
      if (!Number.isFinite(effectiveTimeoutMs)) {
        await probe
      } else {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(`System.awaitConnected: probe timed out after ${effectiveTimeoutMs}ms`),
              ),
            effectiveTimeoutMs,
          )
          probe.then(
            () => {
              clearTimeout(timer)
              resolve()
            },
            (err: unknown) => {
              clearTimeout(timer)
              reject(err instanceof Error ? err : new Error(String(err)))
            },
          )
        })
      }
      this.connected = true
    })()
    try {
      await this.connectedPromise
    } finally {
      this.connectedPromise = null
    }
  }

  /**
   * Warm-boot the device mirror. Awaits the transport probe first
   * (`awaitConnected`) so the three mirror round-trips
   * (`getAllBindings` + `getAllSnapshots` + `listAll`) cannot race
   * against the WS auth handshake. Subsequent `getDevice(id)` calls
   * are sync; live `device.*` event subscriptions keep the caches
   * fresh.
   *
   * Idempotent — concurrent callers await the same in-flight Promise.
   */
  async init(timeoutMs?: number): Promise<void> {
    if (this.mirror?.isReady()) return
    if (this.mirrorInit) return this.mirrorInit
    const m = new SystemMirror(this._trpcClient as SystemMirrorApi)
    this.mirror = m
    this.mirrorInit = (async () => {
      await this.awaitConnected(timeoutMs)
      await m.init(timeoutMs)
    })().finally(() => {
      this.mirrorInit = null
    })
    return this.mirrorInit
  }

  /** Promise that resolves once `init()` has completed. */
  async awaitReady(): Promise<void> {
    if (this.mirror?.isReady()) return
    if (this.mirrorInit) return this.mirrorInit
    return this.init()
  }

  /** True after `init()` resolves. */
  isReady(): boolean {
    return this.mirror?.isReady() ?? false
  }

  /** True after the transport probe has succeeded at least once. */
  isConnected(): boolean {
    return this.connected
  }

  /**
   * Force a fresh WebSocket handshake. Tears down the wsClient + tRPC
   * client + mirror (the mirror captures the tRPC reference at
   * construction time and would otherwise dispatch through a closed
   * client) and rebuilds them. No-op for HTTP transport.
   */
  reconnect(): void {
    if (!this.useWs) return
    this._wsEpoch += 1
    this.emitConnectionEvent('connecting')
    this._wsClient?.close()
    this.disposeMirror()
    this.resetEventSubs()
    this.connected = false
    this.connectedPromise = null
    this._wsHandshake = null
    this._trpcClient = this.buildTrpcClient()
    this._systemProxy = createSystemProxy(this._trpcClient as AddonApi)
  }

  /**
   * Pivot the underlying tRPC transport onto a different base URL.
   * Used by the endpoint-race flow: the SDK opens against the public
   * URL the operator provided, calls `localNetwork.getConnectionEndpoints`
   * to discover LAN candidates, races them, and (when a faster one wins)
   * calls `switchServerUrl(winner)` to migrate every subsequent query
   * onto the LAN path without losing auth state.
   *
   * Keeps the auth token. Tears down the WS + mirror and rebuilds them
   * against the new URL — same machinery as `reconnect()` but with a
   * different target.
   */
  switchServerUrl(nextUrl: string): void {
    const normalized = nextUrl.replace(/\/+$/, '')
    if (normalized === this._serverUrl) return
    this._serverUrl = normalized
    this.reconnect()
  }

  /**
   * Race the candidate base URLs reported by the hub's `local-network`
   * cap, pick the fastest one that responds, and (if it's different
   * from the current URL) pivot the transport onto it.
   *
   * Flow:
   *   1. Query `localNetwork.getConnectionEndpoints({ port })` over the
   *      already-authenticated tRPC channel — the cap is auth-gated,
   *      so the LAN IPs never leak to anonymous callers.
   *   2. For each candidate, fire a GET on `{baseUrl}/health` (the
   *      auth-free liveness route) with a short timeout (default 1500ms).
   *      The first 2xx wins.
   *   3. If the winner differs from `this.serverUrl`, call
   *      `switchServerUrl(winner)` and return it. Otherwise return
   *      the current URL unchanged.
   *
   * Bounded — if every candidate times out we keep the current URL.
   * Idempotent — safe to call on every connect / reconnect / network
   * change event.
   */
  async raceConnectionEndpoints(options?: {
    /** Per-candidate probe timeout. Default 1500ms. */
    readonly perCandidateTimeoutMs?: number
    /** Skip IPv6 candidates. Default `false`. */
    readonly ipv4Only?: boolean
  }): Promise<{ winner: string; switched: boolean }> {
    const timeoutMs = options?.perCandidateTimeoutMs ?? 1500
    // Derive the port + scheme the SDK is currently using. The scheme is
    // advisory (mixed-content preview). LAN URLs come back from the hub as
    // http:// when LAN HTTP is on — do not rewrite them to match this URL.
    const url = (() => {
      try {
        return new URL(this._serverUrl)
      } catch {
        return null
      }
    })()
    const port = url?.port ? Number(url.port) : url?.protocol === 'https:' ? 443 : 80
    const scheme: 'http' | 'https' = url?.protocol === 'https:' ? 'https' : 'http'

    const proxy = this._trpcClient as {
      localNetwork?: {
        getConnectionEndpoints: {
          query: (input: {
            port: number
            ipv4Only?: boolean
            includeLoopback?: boolean
            scheme?: 'http' | 'https'
          }) => Promise<{
            endpoints: ReadonlyArray<{
              baseUrl: string
              priority: number
              kind: string
              label: string
            }>
          }>
        }
      }
    }
    const cap = proxy.localNetwork?.getConnectionEndpoints
    if (!cap) {
      return { winner: this._serverUrl, switched: false }
    }

    let endpoints: ReadonlyArray<{ baseUrl: string; priority: number; kind: string; label: string }>
    try {
      const res = await cap.query({
        port,
        ipv4Only: options?.ipv4Only,
        scheme,
        includeLoopback: false,
      })
      endpoints = res.endpoints
    } catch {
      // Cap unavailable (older hub, network blip) — keep current URL.
      return { winner: this._serverUrl, switched: false }
    }

    if (endpoints.length === 0) {
      return { winner: this._serverUrl, switched: false }
    }

    const winner = await raceFastestEndpoint(
      endpoints.map((e) => e.baseUrl),
      timeoutMs,
    )
    if (!winner || winner === this._serverUrl) {
      return { winner: winner ?? this._serverUrl, switched: false }
    }
    this.switchServerUrl(winner)
    return { winner, switched: true }
  }

  /** Tear down WS connection + mirror. The instance is unusable afterwards. */
  close(): void {
    this.disposeMirror()
    this.connected = false
    this.connectedPromise = null
    this._wsClient?.close()
  }

  private disposeMirror(): void {
    this.mirror?.dispose()
    this.mirror = null
    this.mirrorInit = null
  }

  // ── Auth ──────────────────────────────────────────────────────────
  //
  // Every login leg takes `{ refreshable: true }` to ask for the
  // refresh-token flow: a short access token plus a rotating `refreshToken`
  // (persist it like a password; keep the session alive with
  // `SessionKeeper` + `refreshSession`). Without it the hub issues one
  // session-long token, as before.

  async login(
    username: string,
    password: string,
    options: LoginOptions = {},
  ): Promise<LoginOutcome> {
    const result = await this._trpcClient.auth.login.mutate({
      username,
      password,
      ...refreshFlag(options),
    })
    if (typeof result === 'object' && result !== null && 'token' in result) {
      const r = result as {
        token?: unknown
        requiresTotp?: unknown
        secondFactors?: unknown
      }
      const token = r.token
      // Only persist when the server granted a real session. A challenge
      // token (any enrolled second factor) is short-lived bridge state and
      // must NOT be set as the active auth header — the second leg
      // (`loginVerifyTotp` / `loginVerifyPasskey`) doesn't need auth, and a
      // stray challenge would expire while sitting in localStorage.
      const requiresSecondFactor =
        r.requiresTotp === true || (Array.isArray(r.secondFactors) && r.secondFactors.length > 0)
      if (typeof token === 'string' && !requiresSecondFactor) this.setToken(token)
    }
    return result as LoginOutcome
  }

  /**
   * Second leg of the 2FA login. The caller passes the challenge
   * token returned by `login` (when `requiresTotp: true`) plus the
   * 6-digit code from the user's authenticator app. On success the
   * server mints the real session JWT, which we set as the active
   * token on this client.
   */
  async loginVerifyTotp(
    challengeToken: string,
    code: string,
    options: LoginOptions = {},
  ): Promise<LoginOutcome> {
    const result = await this._trpcClient.auth.loginVerifyTotp.mutate({
      challengeToken,
      code,
      ...refreshFlag(options),
    })
    if (typeof result === 'object' && result !== null && 'token' in result) {
      const token = (result as { token?: unknown }).token
      if (typeof token === 'string') this.setToken(token)
    }
    return result as LoginOutcome
  }

  /**
   * Passkey second leg — step 1. Exchanges the login challenge token for
   * the WebAuthn assertion options; the caller feeds `optionsJSON` to
   * `@simplewebauthn/browser` `startAuthentication`. PUBLIC (pre-session).
   */
  async loginBeginPasskey(
    challengeToken: string,
  ): Promise<{ optionsJSON: Record<string, unknown> }> {
    const result = await this._trpcClient.auth.loginBeginPasskey.mutate({ challengeToken })
    return result as { optionsJSON: Record<string, unknown> }
  }

  /**
   * Passkey second leg — step 2. Submits the browser assertion; on
   * success the server mints the real session JWT, which we set as the
   * active token on this client.
   */
  async loginVerifyPasskey(
    challengeToken: string,
    response: Record<string, unknown>,
    options: LoginOptions = {},
  ): Promise<LoginOutcome> {
    const result = await this._trpcClient.auth.loginVerifyPasskey.mutate({
      challengeToken,
      response,
      ...refreshFlag(options),
    })
    if (typeof result === 'object' && result !== null && 'token' in result) {
      const token = (result as { token?: unknown }).token
      if (typeof token === 'string') this.setToken(token)
    }
    return result as LoginOutcome
  }

  /**
   * Usernameless (passkey-FIRST) login — step 1. Fetches discoverable-
   * credential assertion options (EMPTY `allowCredentials`); the caller
   * feeds `optionsJSON` to `@simplewebauthn/browser` `startAuthentication`
   * and the browser's own passkey picker takes over. PUBLIC (pre-session,
   * no challenge token — the WebAuthn challenge is the whole state).
   */
  async passkeyLoginBegin(): Promise<{ optionsJSON: Record<string, unknown> }> {
    const result = await this._trpcClient.auth.passkeyLoginBegin.mutate()
    return result as { optionsJSON: Record<string, unknown> }
  }

  /**
   * Usernameless login — step 2. Submits the browser assertion; on
   * success the server resolves the credential's owner and mints the
   * real session JWT, which we set as the active token on this client.
   *
   * Second-factor aware (mirrors `login`): when the account still has a
   * second factor to satisfy (TOTP — 2FA applies uniformly after any
   * primary method), the server returns a short-lived CHALLENGE token +
   * `secondFactors`. That token is NOT persisted as the active session
   * — the caller completes the remaining factor via `loginVerifyTotp`.
   */
  async passkeyLoginFinish(
    response: Record<string, unknown>,
    options: LoginOptions = {},
  ): Promise<LoginOutcome> {
    const result = await this._trpcClient.auth.passkeyLoginFinish.mutate({
      response,
      ...refreshFlag(options),
    })
    if (typeof result === 'object' && result !== null && 'token' in result) {
      const r = result as { token?: unknown; requiresTotp?: unknown; secondFactors?: unknown }
      const requiresSecondFactor =
        r.requiresTotp === true || (Array.isArray(r.secondFactors) && r.secondFactors.length > 0)
      if (typeof r.token === 'string' && !requiresSecondFactor) this.setToken(r.token)
    }
    return result as LoginOutcome
  }

  /**
   * Swap a refresh token for a new access token and a ROTATED refresh token
   * (the old one stops working). Sets the new access token on this client.
   * Throws a tRPC UNAUTHORIZED when the session is over — sign in again.
   */
  async refreshSession(refreshToken: string): Promise<RefreshedSession> {
    const result = (await this._trpcClient.auth.refreshSession.mutate({
      refreshToken,
    })) as RefreshedSession
    this.setToken(result.token)
    return result
  }

  /**
   * End this session on the hub (its tokens stop working at once);
   * `everywhere: true` ends every session of the user.
   */
  async logout(options: { readonly everywhere?: boolean } = {}): Promise<void> {
    await this._trpcClient.auth.logout.mutate(
      options.everywhere === true ? { everywhere: true } : undefined,
    )
  }

  async getMe(): Promise<UserInfo> {
    const me = await this._trpcClient.auth.me.query()
    return me as UserInfo
  }

  // ── Self-service auth (the signed-in user acting on themselves) ─────
  //
  // The hand-written `auth.*` router exposes 5 procedures that operate
  // on `ctx.user` (the JWT-bound identity), distinct from the admin
  // `user-management` cap that operates on arbitrary userIds. They live
  // on `System` rather than as codegen'd hooks because `auth.*` is a
  // legacy core router, not a `.cap.ts` — see the no-restricted-imports
  // rule in `eslint.config.mjs` for the canonical entry-point design.

  async changeOwnPassword(input: {
    currentPassword: string
    newPassword: string
  }): Promise<{ success: true }> {
    const result = await this._trpcClient.auth.changeOwnPassword.mutate(input)
    return result as { success: true }
  }

  async setupOwnTotp(): Promise<{ secret: string; otpauthUrl: string }> {
    const result = await this._trpcClient.auth.setupOwnTotp.mutate()
    return result as { secret: string; otpauthUrl: string }
  }

  async confirmOwnTotp(input: { code: string }): Promise<{ success: true }> {
    const result = await this._trpcClient.auth.confirmOwnTotp.mutate(input)
    return result as { success: true }
  }

  /** Needs a fresh `reauthToken` from {@link reauthenticate}. */
  async disableOwnTotp(input: { reauthToken: string }): Promise<{ success: true }> {
    const result = await this._trpcClient.auth.disableOwnTotp.mutate(input)
    return result as { success: true }
  }

  /**
   * Re-authentication, passkey path step 1: assertion options for the
   * caller's own passkeys. Feed `optionsJSON` to `startAuthentication`, then
   * pass the result to {@link reauthenticate} as `passkeyResponse`.
   */
  async reauthBeginPasskey(): Promise<{ optionsJSON: Record<string, unknown> }> {
    const result = await this._trpcClient.auth.reauthBeginPasskey.mutate()
    return result as { optionsJSON: Record<string, unknown> }
  }

  /**
   * Prove it is you — the current password or a passkey assertion — for a
   * 5-minute `reauthToken`, required by `disableOwnTotp`, `removeOwnPasskey`
   * and `auth.beginExternalLink` (valid only in this session).
   */
  async reauthenticate(
    input: { readonly password: string } | { readonly passkeyResponse: Record<string, unknown> },
  ): Promise<{ reauthToken: string; expiresAt: number; method: 'password' | 'passkey' }> {
    const result = await this._trpcClient.auth.reauthenticate.mutate(input)
    return result as { reauthToken: string; expiresAt: number; method: 'password' | 'passkey' }
  }

  async getOwnTotpStatus(): Promise<{ enabled: boolean; confirmedAt: number | null }> {
    const result = await this._trpcClient.auth.getOwnTotpStatus.query()
    return result as { enabled: boolean; confirmedAt: number | null }
  }

  // ── Self-service passkeys (the signed-in user acting on themselves) ─
  //
  // Mirror the TOTP self-service block: bound to `ctx.user.id` server-side
  // so a non-admin can enroll / revoke their own passkeys. Resolved
  // through the `user-passkeys` cap on the hub — cap-agnostic.

  async beginOwnPasskeyRegistration(): Promise<{ optionsJSON: Record<string, unknown> }> {
    const result = await this._trpcClient.auth.beginOwnPasskeyRegistration.mutate()
    return result as { optionsJSON: Record<string, unknown> }
  }

  async finishOwnPasskeyRegistration(input: {
    response: Record<string, unknown>
    label: string
  }): Promise<{ success: true; credentialId: string }> {
    const result = await this._trpcClient.auth.finishOwnPasskeyRegistration.mutate(input)
    return result as { success: true; credentialId: string }
  }

  async listOwnPasskeys(): Promise<readonly PasskeySummary[]> {
    const result = await this._trpcClient.auth.listOwnPasskeys.query()
    return result as readonly PasskeySummary[]
  }

  /** Needs a fresh `reauthToken` from {@link reauthenticate}. */
  async removeOwnPasskey(input: {
    credentialId: string
    reauthToken: string
  }): Promise<{ success: true }> {
    const result = await this._trpcClient.auth.removeOwnPasskey.mutate(input)
    return result as { success: true }
  }

  /**
   * Own passkey second-factor preference (opt-in, default OFF).
   * Enrolling a passkey only enables passkey-first sign-in; this flag
   * additionally demands the passkey after every password login.
   */
  async getOwnPasskeySecondFactorPreference(): Promise<{ enabled: boolean }> {
    const result = await this._trpcClient.auth.getOwnPasskeySecondFactorPreference.query()
    return result as { enabled: boolean }
  }

  async setOwnPasskeySecondFactorPreference(input: {
    enabled: boolean
  }): Promise<{ success: true }> {
    const result = await this._trpcClient.auth.setOwnPasskeySecondFactorPreference.mutate(input)
    return result as { success: true }
  }

  /** Update the auth token (e.g. after login or token refresh). */
  setToken(token: string): void {
    this.token = token
  }

  /**
   * True when the live WebSocket was handshaken with a token other than the
   * current one (anonymous, or rotated since). The socket authenticates once,
   * at the handshake, so such a socket answers every protected call
   * UNAUTHORIZED until `reconnect()`. Always false for HTTP transport.
   */
  isSocketTokenStale(): boolean {
    if (!this.useWs || this._wsHandshake === null) return false
    return this._wsHandshake.token !== this.token
  }

  // ── Devices ──────────────────────────────────────────────────────

  /**
   * Synchronous snapshot of every device matching the optional filters.
   * Backed by the `SystemMirror` warm-boot cache — call `init()` first
   * (or `awaitReady()`) before invoking. Returns an empty array if the
   * mirror has not yet been booted.
   *
   * Each returned proxy has `binding` populated from the mirror's
   * binding cache (Phase 5 dedup), so consumers no longer need to
   * make a separate `deviceManager.getBindings` round-trip.
   */
  listDevices(filters?: DeviceQueryFilters): readonly DeviceProxy[] {
    if (!this.mirror) return []
    const proxies = filters ? this.mirror.query(filters) : this.mirror.getAllDevices()
    return proxies.map((p) => this.attachBinding(p))
  }

  /**
   * Sync `DeviceInfo` snapshot (name, canonical type, online, …) for one device
   * from the warm-boot mirror — `null` if the mirror isn't booted or the device
   * is unknown. Unlike a `DeviceProxy` (cap accessors only), this carries the
   * display identity the UI needs to render a device on first paint.
   */
  getDeviceInfo(deviceId: number): DeviceInfo | null {
    return this.mirror?.getDeviceInfo(deviceId) ?? null
  }

  /**
   * The `DeviceInfo` snapshots for the current device set (the warm-boot cache),
   * honouring the same `filters` as {@link listDevices}. Lets a UI render a named
   * device list immediately without waiting for per-device lifecycle events.
   */
  listDeviceInfos(filters?: DeviceQueryFilters): readonly DeviceInfo[] {
    const mirror = this.mirror
    if (!mirror) return []
    const proxies = filters ? mirror.query(filters) : mirror.getAllDevices()
    const out: DeviceInfo[] = []
    for (const p of proxies) {
      const info = mirror.getDeviceInfo(p.deviceId)
      if (info) out.push(info)
    }
    return out
  }

  /**
   * Sync lookup by numeric id. `null` if the mirror has not been booted
   * or the device is unknown.
   */
  getDevice(deviceId: number): DeviceProxy | null {
    const proxy = this.mirror?.getDeviceById(deviceId) ?? null
    return proxy ? this.attachBinding(proxy) : null
  }

  /** Sync lookup by display name (exact match). */
  getDeviceByName(name: string): DeviceProxy | null {
    const proxy = this.mirror?.getDeviceByName(name) ?? null
    return proxy ? this.attachBinding(proxy) : null
  }

  /** Sync lookup by stableId. */
  getDeviceByStableId(stableId: string): DeviceProxy | null {
    const proxy = this.mirror?.getDeviceByStableId(stableId) ?? null
    return proxy ? this.attachBinding(proxy) : null
  }

  /**
   * Resolve when a device with `deviceId` becomes available. Resolves
   * immediately if already known; rejects with a timeout error
   * otherwise (default 30s).
   */
  async waitForDevice(deviceId: number, timeoutMs?: number): Promise<DeviceProxy> {
    if (!this.mirror) await this.init()
    const proxy = await this.mirror!.waitForDevice(deviceId, timeoutMs ?? 30_000)
    return this.attachBinding(proxy)
  }

  /** Subscribe to `device.registered` events. */
  onDeviceAdded(cb: DeviceLifecycleListener): () => void {
    if (!this.mirror) {
      // Mirror not ready yet — buffer the listener until init() runs.
      // The cleanest path is to require init() first; throw a clear
      // error so callers don't silently miss the first events.
      throw new Error('System.onDeviceAdded: call init() before subscribing')
    }
    return this.mirror.onDeviceAdded(cb)
  }

  /** Subscribe to `device.unregistered` events. */
  onDeviceRemoved(cb: DeviceLifecycleListener): () => void {
    if (!this.mirror) {
      throw new Error('System.onDeviceRemoved: call init() before subscribing')
    }
    return this.mirror.onDeviceRemoved(cb)
  }

  /**
   * Patch the proxy's `binding` field from the mirror's cache. The
   * generated `createDeviceProxy()` already sets `binding` to the
   * binding it was constructed with — this is a defensive overwrite
   * that uses the latest cached entry in case a `binding-changed`
   * event landed between proxy creation and access.
   */
  private attachBinding(proxy: DeviceProxy): DeviceProxy {
    const binding = this.lookupBinding(proxy.deviceId)
    if (binding === proxy.binding) return proxy
    const writable = proxy as { binding: DeviceBinding | null }
    writable.binding = binding
    return proxy
  }

  /** Fetch the latest cached binding from the mirror, or `null`. */
  private lookupBinding(deviceId: number): DeviceBinding | null {
    if (!this.mirror) return null
    // Mirror exposes bindings via the proxy itself — read it back
    // through `getDeviceById` so we don't have to widen the public
    // SystemMirror surface just for the cache lookup.
    const proxy = this.mirror.getDeviceById(deviceId)
    return proxy?.binding ?? null
  }

  // ── System caps ──────────────────────────────────────────────────
  //
  // One getter per `scope: 'system'` capability. The actual surface
  // comes from `createSystemProxy(api)` (codegen). Adding a new
  // system cap regenerates the proxy and the new namespace surfaces
  // automatically via `system.<newCap>.<method>(input)`.

  get addonPages(): SystemProxy['addonPages'] {
    return this._systemProxy.addonPages
  }
  get addonSettings(): SystemProxy['addonSettings'] {
    return this._systemProxy.addonSettings
  }
  get alerts(): SystemProxy['alerts'] {
    return this._systemProxy.alerts
  }
  get audioAnalyzer(): SystemProxy['audioAnalyzer'] {
    return this._systemProxy.audioAnalyzer
  }
  get audioCodec(): SystemProxy['audioCodec'] {
    return this._systemProxy.audioCodec
  }
  get backup(): SystemProxy['backup'] {
    return this._systemProxy.backup
  }
  get decoder(): SystemProxy['decoder'] {
    return this._systemProxy.decoder
  }
  get deviceManager(): SystemProxy['deviceManager'] {
    return this._systemProxy.deviceManager
  }
  get deviceProvider(): SystemProxy['deviceProvider'] {
    return this._systemProxy.deviceProvider
  }
  get deviceState(): SystemProxy['deviceState'] {
    return this._systemProxy.deviceState
  }
  get metricsProvider(): SystemProxy['metricsProvider'] {
    return this._systemProxy.metricsProvider
  }
  get notificationOutput(): SystemProxy['notificationOutput'] {
    return this._systemProxy.notificationOutput
  }
  get pipelineExecutor(): SystemProxy['pipelineExecutor'] {
    return this._systemProxy.pipelineExecutor
  }
  get pipelineOrchestrator(): SystemProxy['pipelineOrchestrator'] {
    return this._systemProxy.pipelineOrchestrator
  }
  get pipelineRunner(): SystemProxy['pipelineRunner'] {
    return this._systemProxy.pipelineRunner
  }
  // `platform-probe` is infra (addon-to-addon via `api.platformProbe`), not a
  // client-facing system cap — it isn't on SystemProxy, so no getter here.
  get settingsStore(): SystemProxy['settingsStore'] {
    return this._systemProxy.settingsStore
  }
  get storage(): SystemProxy['storage'] {
    return this._systemProxy.storage
  }
  get streamBroker(): SystemProxy['streamBroker'] {
    return this._systemProxy.streamBroker
  }
  get turnProvider(): SystemProxy['turnProvider'] {
    return this._systemProxy.turnProvider
  }
  get userManagement(): SystemProxy['userManagement'] {
    return this._systemProxy.userManagement
  }

  // ── Live events ──────────────────────────────────────────────────

  /**
   * Subscribe to a single event category. Returns an unsubscribe
   * handle. Errors thrown by the listener are swallowed so a single
   * misbehaving consumer cannot tear down the WS subscription.
   *
   * Categories should be values from the `EventCategory` enum
   * (`@camstack/types`) — passing a raw string works for forward-compat
   * but loses type safety. The SDK forwards the value verbatim to the
   * server's `live.onEvent` subscription.
   *
   * **N callers on one category share ONE subscription.** The caller's shape
   * is unchanged, and it is not asked to coordinate: twelve camera cards each
   * subscribing to the motion category and filtering by deviceId is the normal
   * pattern, and it used to open twelve WS subscriptions.
   */
  subscribeEvent<TData = unknown>(
    category: string,
    cb: SystemLiveEventListener<TData>,
  ): () => void {
    const listener = cb as (event: unknown) => void
    let entry = this._eventSubs.get(category)
    if (entry === undefined) {
      const listeners = new Set<(event: unknown) => void>()
      const sub = this._trpcClient.live.onEvent.subscribe(
        { category },
        {
          onData: (event) => {
            // Iterate a COPY: a listener that unsubscribes itself on receipt
            // (a one-shot waiter) would otherwise mutate the set mid-loop.
            for (const fn of [...listeners]) {
              try {
                fn(event)
              } catch {
                /* swallow listener errors */
              }
            }
          },
        },
      )
      entry = {
        listeners,
        unsubscribe: () => {
          try {
            sub.unsubscribe()
          } catch {
            /* swallow — already unsubscribed */
          }
        },
      }
      this._eventSubs.set(category, entry)
    }
    entry.listeners.add(listener)

    let released = false
    return () => {
      // Idempotent: React effects call their cleanup more than once under
      // StrictMode, and a second call must not tear down a subscription the
      // NEXT mount is already using.
      if (released) return
      released = true
      const current = this._eventSubs.get(category)
      if (current === undefined) return
      current.listeners.delete(listener)
      if (current.listeners.size === 0) {
        current.unsubscribe()
        this._eventSubs.delete(category)
      }
    }
  }

  /**
   * Drop every shared subscription.
   *
   * Called when the tRPC client is rebuilt: the handles above belong to the
   * OLD client and unsubscribing them is meaningless, while keeping them in
   * the map would make the next `subscribeEvent` attach a listener to a dead
   * socket and go silent — the worst outcome, because it looks like "no
   * events happened".
   */
  private resetEventSubs(): void {
    for (const entry of this._eventSubs.values()) entry.unsubscribe()
    this._eventSubs.clear()
  }

  // ── Escape hatches ───────────────────────────────────────────────
  //
  // Kept public so the ui-library `<TrpcProvider>` can seed React
  // Query with the same WebSocket connection during Phase 2. Phase 4
  // is expected to revisit whether either field can be hidden.

  /** Direct tRPC client. Read once per call; rebuilt on `reconnect()`. */
  get trpcClient(): TrpcClient {
    return this._trpcClient
  }

  /**
   * Underlying WSClient (or `null` for HTTP transport). Used by
   * advanced consumers that need direct access to the WebSocket
   * (e.g. for keep-alive metrics). Rebuilt on `reconnect()`.
   */
  get wsClient(): TrpcWsClient | null {
    return this._wsClient
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * The token the next socket handshake may carry. An expired token, or one
   * the hub just closed with 4401, is never sent: the credential is refreshed
   * over HTTP first, and when that does not yield a usable token the
   * handshake is anonymous (the app learns of a refused refresh from its
   * session keeper and routes to login; a transient failure retries later).
   */
  private async handshakeToken(): Promise<string | undefined> {
    const dead = (token: string): boolean => {
      if (token === this._rejectedToken) return true
      const exp = jwtExpiresAt(token)
      return exp !== null && exp - Date.now() <= HANDSHAKE_EXPIRY_SKEW_MS
    }
    const initial = this.token
    if (initial === undefined || !dead(initial)) return initial
    if (this.refreshCredential !== undefined) {
      try {
        await this.refreshCredential(initial === this._rejectedToken ? 'rejected' : 'expired')
      } catch {
        /* refused or unreachable: decided below, from the token we now hold */
      }
    }
    const current = this.token
    return current !== undefined && !dead(current) ? current : undefined
  }

  private buildTrpcClient(): TrpcClient {
    const headers = (): Record<string, string> => {
      const h: Record<string, string> = {}
      if (this.token) h['Authorization'] = `Bearer ${this.token}`
      const lang = this.getLanguage()
      if (lang) h['x-camstack-lang'] = lang
      return h
    }

    if (this.useWs) {
      const wsUrl = this._serverUrl.replace(/^http/, 'ws') + '/trpc'
      const baseRetryMs = this.baseRetryMs
      const maxRetryMs = this.maxRetryMs
      const epoch = this._wsEpoch
      this._wsClient = createWSClient({
        url: wsUrl,
        connectionParams: async () => {
          const token = await this.handshakeToken()
          if (epoch === this._wsEpoch) this._wsHandshake = { token }
          const lang = this.getLanguage()
          return {
            ...(token !== undefined ? { token } : {}),
            ...(lang ? { lang } : {}),
          }
        },
        retryDelayMs: (attemptIndex: number) =>
          Math.min(baseRetryMs * Math.pow(2, attemptIndex), maxRetryMs),
        keepAlive: {
          enabled: true,
          intervalMs: WS_KEEP_ALIVE_INTERVAL_MS,
          pongTimeoutMs: WS_KEEP_ALIVE_PONG_TIMEOUT_MS,
        },
        onOpen: () => {
          if (epoch !== this._wsEpoch) return
          this._connectionVersion += 1
          this.emitConnectionEvent('connected')
        },
        onClose: (cause) => {
          if (epoch !== this._wsEpoch) return
          // The hub refused this socket's credential: the next handshake must
          // not carry the same token (it refreshes over HTTP first).
          if (cause?.code === SESSION_ENDED_CLOSE_CODE) {
            this._rejectedToken = this._wsHandshake?.token ?? this._rejectedToken
          }
          this.emitConnectionEvent('disconnected')
        },
      })

      const anonymousHeaders = (): Record<string, string> => {
        const lang = this.getLanguage()
        return lang ? { 'x-camstack-lang': lang } : {}
      }
      return createTRPCClient<BackendAppRouter>({
        links: [
          splitLink({
            condition: (op) => PRE_AUTH_PATHS.has(op.path),
            true: httpLink({
              url: `${this._serverUrl}/trpc`,
              headers: anonymousHeaders,
              transformer: superjson,
            }),
            false: wsLink({ client: this._wsClient, transformer: superjson }),
          }),
        ],
      })
    }

    this._wsClient = null
    return createTRPCClient<BackendAppRouter>({
      links: [httpLink({ url: `${this._serverUrl}/trpc`, headers, transformer: superjson })],
    })
  }
}

/** Create a `System` instance. Convenience factory. */
export function createSystem(config: SystemConfig): System {
  return new System(config)
}

/**
 * Race a list of candidate base URLs and return the first one that
 * responds to `GET {baseUrl}/health` with a 2xx within
 * `timeoutMs`. Returns `null` if every candidate fails / times out.
 *
 * Implementation notes:
 *   - Uses `fetch` with `AbortController` for per-candidate cutoff so a
 *     stalled candidate doesn't pin the wallclock for the whole race.
 *   - Cancels every still-pending probe as soon as the first one
 *     succeeds — no wasted bandwidth on the loser candidates.
 *   - `/health` is the hub's auth-free liveness route (`{"ok":true}`),
 *     the one load balancers and uptime probes already watch. NOT
 *     `/trpc/health`: under `/trpc/*` the tRPC plugin resolves `health` as
 *     a procedure name and answers 404 on a HEALTHY hub (the fastify route
 *     of that name exists only on the degraded branch taken when tRPC fails
 *     to register), so every race over it rejected and fell back.
 *   - HEAD would be nicer but Cloudflare Tunnel + some browsers
 *     mishandle HEAD on the ingress path; GET is safer.
 *
 * Exported so non-System callers (CLI helpers, tests) can race their
 * own candidate lists without instantiating a full System.
 */
export async function raceFastestEndpoint(
  candidates: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<string | null> {
  if (candidates.length === 0) return null
  if (typeof fetch !== 'function') return candidates[0] ?? null

  // Defense in depth: when running in a browser loaded over HTTPS, the
  // browser blocks every `http://` request as mixed content. Filter
  // those out before probing so we don't waste timeouts on candidates
  // that would have been rejected anyway. The cap is supposed to emit
  // matching-scheme URLs given `scheme: 'https'` — this guard catches
  // any leftover http candidates from older hubs / misconfigured
  // proxies.
  const pageIsHttps =
    typeof window !== 'undefined' &&
    typeof window.location !== 'undefined' &&
    window.location.protocol === 'https:'
  const reachable = pageIsHttps
    ? candidates.filter((u) => u.toLowerCase().startsWith('https://'))
    : candidates
  if (reachable.length === 0) return null

  const controllers = reachable.map(() => new AbortController())
  const probes = reachable.map(async (baseUrl, i) => {
    const ctrl = controllers[i]!
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
        method: 'GET',
        signal: ctrl.signal,
        // Cross-origin probes from a browser sandbox depend on the hub's
        // CORS answer for /health; a refused probe simply loses the race.
        // No credentials needed (this is a transport-quality probe,
        // not an auth round-trip).
        credentials: 'omit',
      })
      if (!res.ok) throw new Error(`${res.status}`)
      return baseUrl
    } finally {
      clearTimeout(timer)
    }
  })

  // `Promise.any` returns the first fulfilled — exactly what we want.
  try {
    const winner = await Promise.any(probes)
    // Cancel every other in-flight probe.
    for (const c of controllers) {
      try {
        c.abort()
      } catch {
        /* already settled */
      }
    }
    return winner
  } catch {
    return null
  }
}
