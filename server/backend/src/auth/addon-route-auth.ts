/**
 * `/addon/:addonId/*` authentication + authorization — the hub's addon
 * routes and data planes ask exactly the questions tRPC asks (D892): the ONE
 * verifier turns the bearer into a principal, the ONE matcher
 * (`authorizeAddonRoute`) reads its scopes. There is no prefix check here.
 *
 * Every refusal is logged with its reason: it is a request an operator will
 * be asking about ("why did Home Assistant stop actuating?"), and a branch
 * that drops a request silently reads as "never happened" (D103).
 */
import type { CredentialScope, TokenScope } from '@camstack/types'
import { capabilityScopesOf } from '@camstack/types'
import { type AddonRouteTarget, authorizeAddonRoute } from '../api/trpc/principal-authorization.js'
import type { CredentialVerifier, Principal, RequestFacts } from './credential-verifier.js'

export interface AddonRouteAuthLogger {
  warn(message: string, options?: { meta?: Record<string, unknown> }): void
}

export type AddonRouteAuthResult =
  | {
      readonly ok: true
      readonly principal: Principal
      readonly shareHeaders: Readonly<Record<string, string>> | null
    }
  | { readonly ok: false; readonly status: 401 | 403; readonly error: string }

export async function authorizeAddonBearer(input: {
  readonly bearer: string
  readonly verifier: CredentialVerifier
  readonly target: AddonRouteTarget
  readonly facts?: RequestFacts
  readonly logger: AddonRouteAuthLogger
}): Promise<AddonRouteAuthResult> {
  const principal = await input.verifier.verify(input.bearer, input.facts ?? {})
  if (principal === null) {
    input.logger.warn('addon route: refused a bearer that authenticates nobody', {
      meta: { addonId: input.target.addonId, method: input.target.method },
    })
    return { ok: false, status: 401, error: 'Invalid token' }
  }
  const verdict = authorizeAddonRoute(principal.scopes, input.target)
  if (!verdict.ok) {
    input.logger.warn('addon route: refused a principal outside its scopes', {
      meta: {
        addonId: input.target.addonId,
        method: input.target.method,
        reason: verdict.reason,
        credential: principal.auditTag,
        credentialId: principal.credentialId,
      },
    })
    return { ok: false, status: verdict.status, error: verdict.error }
  }
  return { ok: true, principal, shareHeaders: verdict.shareHeaders }
}

/** Who the addon's handler is told is calling. */
export interface AddonRouteCaller {
  readonly user: { readonly id: string; readonly username: string; readonly isAdmin: boolean }
  /** A principal whose reach is its token's grants (not a person, not admin). */
  readonly scopedToken?: {
    readonly id: string
    readonly userId: string
    readonly scopes: TokenScope[]
  }
}

export function addonRouteCaller(principal: Principal): AddonRouteCaller {
  const scoped: readonly CredentialScope[] = principal.scopes
  return {
    user: { id: principal.subjectId, username: principal.username, isAdmin: principal.isAdmin },
    ...(principal.isAdmin || principal.userDelegated
      ? {}
      : {
          scopedToken: {
            id: principal.credentialId,
            userId: principal.subjectId,
            // Capability rows only: an addon reads grants, never a viewer row (D921).
            scopes: capabilityScopesOf(scoped).flatMap((s) => (s.type === 'viewer' ? [] : [s])),
          },
        }),
  }
}
