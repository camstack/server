// ---------------------------------------------------------------------------
// Auth service — JWT token utilities
// ---------------------------------------------------------------------------

import type { TokenScope } from '@camstack/types'
import { grantRowsOf, normalizeTokenScopes } from '@camstack/types'

export interface TokenPayload {
  id: string
  username: string
  isAdmin: boolean
  exp: number
  /**
   * Scopes snapshot baked into the JWT at sign time. Empty for legacy
   * tokens issued before the caps-only refactor; the middleware will
   * lock those users out and they re-login to pick up fresh grants.
   */
  scopes: readonly TokenScope[]
}

/**
 * Decode a JWT token and extract the payload.
 * Returns `null` if the token is malformed or cannot be parsed.
 *
 * The `scopes` field is structurally re-validated client-side: an
 * untrusted JWT (forged or tampered) must not poison the React state
 * with a garbage shape. Anything that doesn't conform to TokenScope
 * is silently dropped; everything else passes through.
 */
export function decodeToken(token: string): TokenPayload | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2 || !parts[1]) {
      return null
    }
    const payload = JSON.parse(atob(parts[1])) as Record<string, unknown>
    return {
      id: String(payload.userId ?? ''),
      username: String(payload.username ?? 'unknown'),
      isAdmin: Boolean(payload.isAdmin),
      exp: Number(payload.exp ?? 0),
      scopes: sanitiseScopes(payload.scopes),
    }
  } catch {
    return null
  }
}

/**
 * Validate + migrate a raw JWT-carried scope array into v3 `TokenScope`s.
 * Delegates to the framework's canonical `normalizeTokenScopes` (Zod-validated,
 * v2 `device:targets` → v3 selector migration built in) rather than a
 * hand-rolled copy — this file previously reimplemented the matcher's
 * validation and drifted the moment the model changed (the D103 lesson).
 */
function sanitiseScopes(raw: unknown): TokenScope[] {
  // The admin UI edits capability rows; a viewer row (D921) has no meaning here.
  return grantRowsOf(normalizeTokenScopes(raw))
}

/**
 * Check whether a JWT token has expired.
 * Returns `true` if the token is expired or cannot be decoded.
 */
export function isTokenExpired(token: string): boolean {
  const decoded = decodeToken(token)
  if (!decoded) return true
  return decoded.exp * 1000 < Date.now()
}
