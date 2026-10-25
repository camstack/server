/**
 * Rate limits of the public auth surface, in one place.
 *
 * Two kinds of bucket, both fixed-window (`auth-rate-limit.ts`):
 *
 *  - **per client address** — the REAL client behind a trusted proxy
 *    (`auth-network-policy.ts`), so one remote attacker no longer shares a
 *    bucket with every other user of the tunnel:
 *      • credential tier — anything that VERIFIES a secret (password, TOTP,
 *        passkey assertion, handoff code, session exchange, refresh): 10/min;
 *      • ceremony tier — begin-legs that only mint a challenge: 30/min.
 *  - **per account** — FAILURES only, 20 per 15 min. Peeked before the secret
 *    is checked and counted only when it is wrong, so guessing one account
 *    from many addresses is slowed while the owner's own logins never spend
 *    it. The price: someone hammering a known username can hold that account
 *    at the limit for the window. That is the documented trade.
 *  - **per user** — authenticated legs a hijacked session could flood:
 *    `beginExternalLink` (5/min; its intents are a bounded shared map) and
 *    `reauthenticate` (10/min).
 *
 * Mesh-internal calls (no originating request) are never limited.
 */
import { TRPCError } from '@trpc/server'
import {
  type AuthNetworkPolicy,
  DEFAULT_AUTH_NETWORK_POLICY,
} from '../../auth/auth-network-policy.js'
import { createRateLimiter, type RateLimiter } from '../../auth/auth-rate-limit.js'

export interface AuthLimiters {
  readonly credential: RateLimiter
  readonly ceremony: RateLimiter
  readonly accountFailures: RateLimiter
  readonly link: RateLimiter
  readonly reauth: RateLimiter
}

export function createAuthLimiters(now?: () => number): AuthLimiters {
  const clock = now !== undefined ? { now } : {}
  return {
    credential: createRateLimiter({ windowMs: 60_000, max: 10, ...clock }),
    ceremony: createRateLimiter({ windowMs: 60_000, max: 30, ...clock }),
    accountFailures: createRateLimiter({ windowMs: 15 * 60_000, max: 20, ...clock }),
    link: createRateLimiter({ windowMs: 60_000, max: 5, ...clock }),
    reauth: createRateLimiter({ windowMs: 60_000, max: 10, ...clock }),
  }
}

/** The process-wide limiters: router rebuilds must not reset an attacker's budget. */
export const PROCESS_AUTH_LIMITERS: AuthLimiters = createAuthLimiters()

export function tooMany(retryAfterSeconds: number): TRPCError {
  return new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message: `Too many attempts — retry in ${retryAfterSeconds}s`,
  })
}

/** Count one attempt from the request's client address; throws when over. */
export function limitByClient(
  limiter: RateLimiter,
  bucket: string,
  req: unknown,
  network: AuthNetworkPolicy = DEFAULT_AUTH_NETWORK_POLICY,
): void {
  const ip = network.clientAddress(req).ip
  if (ip === null) return
  const verdict = limiter.check(`${bucket}:${ip}`)
  if (!verdict.allowed) throw tooMany(verdict.retryAfterSeconds)
}

/** Refuse before checking a secret when `account` already failed too often. */
export function assertAccountNotLocked(limiters: AuthLimiters, account: string): void {
  const verdict = limiters.accountFailures.peek(`account:${account.toLowerCase()}`)
  if (!verdict.allowed) throw tooMany(verdict.retryAfterSeconds)
}

/** Count one failed secret against `account`. */
export function recordAccountFailure(limiters: AuthLimiters, account: string): void {
  limiters.accountFailures.check(`account:${account.toLowerCase()}`)
}

/** Count one call of an authenticated leg against the user; throws when over. */
export function limitByUser(limiter: RateLimiter, bucket: string, userId: string): void {
  const verdict = limiter.check(`${bucket}:${userId}`)
  if (!verdict.allowed) throw tooMany(verdict.retryAfterSeconds)
}
