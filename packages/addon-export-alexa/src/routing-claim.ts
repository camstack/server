/**
 * The `hubUrl` routing claim of an Alexa-bound token. The skill Lambda routes a directive back
 * to this hub on it, so it must still name the hub's current `publicEndpoint` role.
 *
 * Operator decision (planning#378, option B): there is no transition. A token issued with a
 * claim that differs from the role is refused with a named reason and the operator re-links
 * the skill once. The claim is read from a token `oauthVerifyAccessToken` has ALREADY
 * verified, so decoding the payload here trusts nothing new; the token itself is never logged.
 */
import { z } from 'zod'
import {
  normaliseOrigin,
  type PublicEndpointRefusal,
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
  | { readonly kind: 'stale'; readonly claim: string; readonly current: string }
  | {
      readonly kind: 'no-endpoint'
      readonly claim: string
      readonly reason: PublicEndpointRefusal
    }

export function judgeRoutingClaim(
  claim: string | null,
  endpoint: PublicEndpointResult,
): RoutingClaimVerdict {
  if (claim === null) return { kind: 'unclaimed' }
  const normalised = normaliseOrigin(claim)
  if (!endpoint.ok) return { kind: 'no-endpoint', claim: normalised, reason: endpoint.reason }
  if (normalised === endpoint.origin) return { kind: 'current' }
  return { kind: 'stale', claim: normalised, current: endpoint.origin }
}
