/**
 * The `hubUrl` routing claim of an Alexa-bound token. The skill Lambda routes a directive back
 * to this hub on it.
 *
 * Rule (planning#378 option B, amended after the 2026-11-21 restart incident, D49): a hub that
 * genuinely MOVED is refused once (INVALID_AUTHORIZATION_CREDENTIAL, the operator re-links),
 * but never on a transient. The directive reached this hub, so a claim naming ANY origin the
 * hub currently knows as its own (palette rows, listener origins, the resolved role) is served,
 * even when the role resolves elsewhere for a moment. A role that resolves to nothing, or a
 * palette that cannot be read, is a retryable answer, because that error code makes Amazon
 * revoke the account link and cannot be undone. Only a claim that matches NO known origin,
 * on a successful read, is stale. The claim is read from a token `oauthVerifyAccessToken` has
 * ALREADY verified; the token itself is never logged.
 */
import { z } from 'zod'
import {
  normaliseOrigin,
  type KnownOriginsResult,
  type PublicEndpointResult,
} from './public-endpoint.js'

const ClaimsSchema = z.object({ hubUrl: z.string().optional() })

/** The claim, or null when the token carries none (or is not a JWT). */
export function readRoutingClaim(token: string): string | null {
  const payload = token.split('.')[1]
  if (payload === undefined) return null
  try {
    const parsed = ClaimsSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString()))
    const claim = parsed.success ? normaliseOrigin(parsed.data.hubUrl ?? '') : ''
    return claim.length > 0 ? claim : null
  } catch {
    return null
  }
}

export type RoutingClaimVerdict =
  | { readonly kind: 'current' }
  | { readonly kind: 'unclaimed' }
  /** The claim names an origin this hub knows, though not the resolved role: serve it. */
  | { readonly kind: 'known-elsewhere'; readonly claim: string; readonly current: string | null }
  | { readonly kind: 'stale'; readonly claim: string; readonly current: string }
  /** The role or the palette is unavailable right now: answer a retryable error. */
  | { readonly kind: 'unavailable'; readonly claim: string; readonly reason: string }

export function judgeRoutingClaim(
  claim: string | null,
  endpoint: PublicEndpointResult,
  known: KnownOriginsResult,
): RoutingClaimVerdict {
  if (claim === null) return { kind: 'unclaimed' }
  const normalised = normaliseOrigin(claim)
  if (endpoint.ok && normalised === endpoint.origin) return { kind: 'current' }
  const current = endpoint.ok ? endpoint.origin : null
  if (known.ok && known.origins.has(normalised)) {
    return { kind: 'known-elsewhere', claim: normalised, current }
  }
  if (!endpoint.ok) return { kind: 'unavailable', claim: normalised, reason: endpoint.reason.code }
  if (!known.ok) return { kind: 'unavailable', claim: normalised, reason: 'palette-unreadable' }
  return { kind: 'stale', claim: normalised, current: endpoint.origin }
}
