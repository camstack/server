import { randomBytes } from 'node:crypto'

/** A sign-in code is only valid for a few minutes; the attempt dies with it. */
export const SIGN_IN_ATTEMPT_TTL_MS = 10 * 60 * 1000

export type SignInAttemptFailure = 'missing' | 'expired'

export interface SignInAttempt {
  readonly verifier: string
  readonly state: string
}

interface StoredAttempt extends SignInAttempt {
  readonly expiresAtMs: number
}

/**
 * PKCE verifier and OAuth state for one sign-in. The form receives only the
 * attempt id. `take` consumes the attempt so a code cannot be replayed here.
 */
export interface SignInAttemptStore {
  put(verifier: string, state: string, nowMs: number): string
  take(
    attemptId: string,
    nowMs: number,
  ):
    | { readonly ok: true; readonly attempt: SignInAttempt }
    | { readonly ok: false; readonly reason: SignInAttemptFailure }
}

export function createSignInAttemptStore(
  ttlMs: number = SIGN_IN_ATTEMPT_TTL_MS,
): SignInAttemptStore {
  const attempts = new Map<string, StoredAttempt>()
  return {
    put(verifier: string, state: string, nowMs: number): string {
      const attemptId = randomBytes(16).toString('base64url')
      attempts.set(attemptId, { verifier, state, expiresAtMs: nowMs + ttlMs })
      return attemptId
    },
    take(attemptId: string, nowMs: number) {
      const stored = attempts.get(attemptId)
      if (stored === undefined) return { ok: false as const, reason: 'missing' as const }
      attempts.delete(attemptId)
      if (nowMs > stored.expiresAtMs) return { ok: false as const, reason: 'expired' as const }
      return {
        ok: true as const,
        attempt: { verifier: stored.verifier, state: stored.state },
      }
    },
  }
}

/** Expired attempts use the same operator text as an expired authorization code. */
export function loginFailureForAttempt(
  reason: SignInAttemptFailure,
): 'state-mismatch' | 'code-rejected' {
  return reason === 'expired' ? 'code-rejected' : 'state-mismatch'
}
