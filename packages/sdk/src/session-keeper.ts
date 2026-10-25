/**
 * Keeps a refreshing CamStack session alive without the user noticing.
 *
 * The hub hands a refreshing client a short access token (default 2 h) and a
 * rotating refresh token. This schedules `auth.refreshSession` shortly before
 * the access token expires, hands every rotated pair to the app to persist,
 * and reports the end of the session only when the hub REFUSES the refresh —
 * a network failure is retried, never treated as a sign-out.
 *
 * Transport-agnostic: the caller supplies `refresh` (normally
 * `System.refreshSession`), so the keeper outlives a System that is rebuilt.
 */

export interface SessionTokens {
  /** The access token (Bearer). */
  readonly token: string
  /** The rotating refresh token, when the session is refreshable. */
  readonly refreshToken?: string
  /** When the access token expires (epoch ms); decoded from the JWT when absent. */
  readonly expiresAt?: number
}

export interface SessionKeeperOptions {
  /** Swap a refresh token for a new pair (`System.refreshSession`). */
  readonly refresh: (refreshToken: string) => Promise<SessionTokens>
  /** Persist / apply a rotated pair (also called after `ensureFresh`). */
  readonly onTokens: (tokens: SessionTokens) => void
  /** The hub refused the refresh: the session is over — sign the user out. */
  readonly onExpired: () => void
  /** Refresh this long before the access token expires (default 5 min, at most half its life). */
  readonly marginMs?: number
  readonly now?: () => number
  /** Timer hook (tests); returns a cancel function. */
  readonly setTimer?: (fn: () => void, ms: number) => () => void
}

const DEFAULT_MARGIN_MS = 5 * 60_000
const RETRY_MS = 30_000
const MIN_DELAY_MS = 1_000

/** Decode a JWT's `exp` (seconds) to epoch ms, or `null`. Never throws. */
export function jwtExpiresAt(token: string): number | null {
  const part = token.split('.')[1]
  if (part === undefined) return null
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const json =
      typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('utf8')
    const payload: unknown = JSON.parse(json)
    if (payload === null || typeof payload !== 'object') return null
    const exp: unknown = Reflect.get(payload, 'exp')
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

/** Is `error` the hub saying the session is over (as opposed to a transport failure)? */
export function isSessionRefusal(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const data: unknown = Reflect.get(error, 'data')
  const code: unknown =
    data !== null && typeof data === 'object' ? Reflect.get(data, 'code') : undefined
  return code === 'UNAUTHORIZED' || code === 'FORBIDDEN'
}

export class SessionKeeper {
  private current: SessionTokens | null = null
  private cancel: (() => void) | null = null
  private inflight: Promise<SessionTokens | null> | null = null
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => () => void

  constructor(private readonly options: SessionKeeperOptions) {
    this.now = options.now ?? Date.now
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms)
        return () => clearTimeout(handle)
      })
  }

  /** Take over `tokens` (a login, a restore from storage) and schedule its refresh. */
  adopt(tokens: SessionTokens): void {
    this.current = tokens
    this.schedule()
  }

  /** The tokens the keeper holds now. */
  tokens(): SessionTokens | null {
    return this.current
  }

  /**
   * Refresh now if the access token expires within `marginMs` (default: the
   * keeper's margin) — call it before reconnecting after the app was in the
   * background. Resolves when done; concurrent callers share one refresh.
   */
  async ensureFresh(marginMs: number = this.margin()): Promise<void> {
    const current = this.current
    if (current?.refreshToken === undefined) return
    const expiresAt = this.expiresAtOf(current)
    if (expiresAt !== null && expiresAt - this.now() > marginMs) return
    await this.refreshNow()
  }

  /** Refresh immediately. `null` when there is nothing to refresh or it failed. */
  refreshNow(): Promise<SessionTokens | null> {
    if (this.inflight !== null) return this.inflight
    const refreshToken = this.current?.refreshToken
    if (refreshToken === undefined) return Promise.resolve(null)
    this.inflight = this.options
      .refresh(refreshToken)
      .then((next) => {
        this.current = next
        this.options.onTokens(next)
        this.schedule()
        return next
      })
      .catch((error: unknown) => {
        if (isSessionRefusal(error)) {
          this.stop()
          this.current = null
          this.options.onExpired()
        } else {
          this.arm(RETRY_MS)
        }
        return null
      })
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  stop(): void {
    this.cancel?.()
    this.cancel = null
  }

  private margin(): number {
    return this.options.marginMs ?? DEFAULT_MARGIN_MS
  }

  private expiresAtOf(tokens: SessionTokens): number | null {
    return tokens.expiresAt ?? jwtExpiresAt(tokens.token)
  }

  private schedule(): void {
    this.stop()
    const current = this.current
    if (current?.refreshToken === undefined) return
    const expiresAt = this.expiresAtOf(current)
    if (expiresAt === null) return
    const remaining = expiresAt - this.now()
    const margin = Math.min(this.margin(), Math.max(0, remaining / 2))
    this.arm(Math.max(MIN_DELAY_MS, remaining - margin))
  }

  private arm(ms: number): void {
    this.stop()
    this.cancel = this.setTimer(() => {
      this.cancel = null
      void this.refreshNow()
    }, ms)
  }
}
