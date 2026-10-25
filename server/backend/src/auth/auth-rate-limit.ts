/**
 * Public-auth rate limiting — fixed window per (bucket, client ip).
 *
 * The public auth surface (login, TOTP verify, passkey ceremonies,
 * handoff redeem, session exchange/upgrade) previously had NO
 * throttling: unlimited online credential guessing. This module is the
 * first line of defence — deliberately simple (in-memory fixed window),
 * because the deployment is a single hub process and the goal is to
 * blunt brute force, not to be a distributed quota system.
 *
 * Pure + clock-injectable so specs drive it directly. The key map is
 * BOUNDED (`maxKeys`, oldest-window evicted first) so an attacker
 * rotating spoofed source addresses cannot grow it without limit.
 */
import { type AuthNetworkPolicy, DEFAULT_AUTH_NETWORK_POLICY } from './auth-network-policy.js'

export interface RateLimiterOptions {
  /** Window length. */
  readonly windowMs: number
  /** Attempts allowed per key per window. */
  readonly max: number
  /** Key-map bound; oldest windows evicted beyond it. Default 10 000. */
  readonly maxKeys?: number
  /** Clock override for tests. */
  readonly now?: () => number
}

export interface RateLimitVerdict {
  readonly allowed: boolean
  /** Seconds until the window resets — meaningful when blocked. */
  readonly retryAfterSeconds: number
}

export interface RateLimiter {
  /** Count one attempt against `key` and answer whether it is allowed. */
  check(key: string): RateLimitVerdict
  /**
   * Whether `key` is blocked RIGHT NOW, without counting an attempt. A
   * per-account FAILURE bucket peeks before verifying and counts only a
   * failure, so a user's own successful logins never spend it.
   */
  peek(key: string): RateLimitVerdict
  /** Current tracked-key count (diagnostics + the bound spec). */
  size(): number
}

interface WindowEntry {
  windowStart: number
  count: number
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const maxKeys = options.maxKeys ?? 10_000
  const now = options.now ?? Date.now
  const entries = new Map<string, WindowEntry>()

  const evictOldest = (): void => {
    let oldestKey: string | null = null
    let oldestStart = Number.POSITIVE_INFINITY
    for (const [key, entry] of entries) {
      if (entry.windowStart < oldestStart) {
        oldestStart = entry.windowStart
        oldestKey = key
      }
    }
    if (oldestKey !== null) entries.delete(oldestKey)
  }

  return {
    check(key: string): RateLimitVerdict {
      const at = now()
      const existing = entries.get(key)
      if (!existing || at - existing.windowStart >= options.windowMs) {
        if (!entries.has(key) && entries.size >= maxKeys) evictOldest()
        entries.set(key, { windowStart: at, count: 1 })
        return { allowed: true, retryAfterSeconds: 0 }
      }
      if (existing.count < options.max) {
        existing.count += 1
        return { allowed: true, retryAfterSeconds: 0 }
      }
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.windowStart + options.windowMs - at) / 1000),
      )
      return { allowed: false, retryAfterSeconds }
    },
    peek(key: string): RateLimitVerdict {
      const at = now()
      const existing = entries.get(key)
      if (!existing || at - existing.windowStart >= options.windowMs) {
        return { allowed: true, retryAfterSeconds: 0 }
      }
      if (existing.count < options.max) return { allowed: true, retryAfterSeconds: 0 }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.windowStart + options.windowMs - at) / 1000),
        ),
      }
    },
    size(): number {
      return entries.size
    },
  }
}

/**
 * The rate-limit key of a request: its REAL client address — the forwarded
 * client behind a trusted proxy (the tunnel connector on loopback, or
 * `auth.trustedProxies`), else the socket peer (`auth-network-policy.ts`).
 * Keyed on the raw peer, every tunnelled request shared `127.0.0.1` and one
 * bucket locked the whole internet out. `null` = no originating request
 * (a mesh-internal `createCaller`) — never limited.
 */
export function clientKeyFromRequest(
  req: unknown,
  policy: AuthNetworkPolicy = DEFAULT_AUTH_NETWORK_POLICY,
): string | null {
  return policy.clientAddress(req).ip
}
