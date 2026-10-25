/**
 * `GET /api/auth/whoami` — the principal the hub resolves for the caller's
 * bearer, for EVERY credential (D892): a session, an account link, a token. A
 * client never classifies a token by its shape: it asks here and reads
 * `isAdmin` and `scopes`. Any other bearer is a 401 (D895).
 *
 * 200 `WhoamiOk`; 401 `{ ok: false, error }` when the bearer authenticates
 * nobody (revoked, expired, never issued). Never the token, never a hash.
 */
import type { CredentialScope } from '@camstack/types'
import type { FastifyInstance } from 'fastify'
import type { PrincipalAuditTag } from '../auth/credential-verifier.js'
import { hubCredentialVerifier, type HubCredentialVerifierDeps } from './trpc/trpc.context.js'

export interface WhoamiOk {
  readonly ok: true
  /** Compatibility for older CLIs: `jwt` for a person's credential, `scoped` for a minted token. */
  readonly kind: 'jwt' | 'scoped'
  readonly userId: string
  readonly username: string
  /** `scopes` holds `'*'`. */
  readonly isAdmin: boolean
  readonly scopes: readonly CredentialScope[]
  readonly credentialId: string
  /** Where the credential came from — display only. */
  readonly credential: PrincipalAuditTag
}

export interface WhoamiRefused {
  readonly ok: false
  readonly error: string
}

/** The answer for `bearer`, or `null` when it authenticates nobody. */
export async function resolveWhoami(
  deps: HubCredentialVerifierDeps,
  bearer: string,
): Promise<WhoamiOk | null> {
  const principal = await hubCredentialVerifier(deps).verify(bearer)
  if (principal === null) return null
  return {
    ok: true,
    kind: principal.userDelegated ? 'jwt' : 'scoped',
    userId: principal.subjectId,
    username: principal.username,
    isAdmin: principal.isAdmin,
    scopes: principal.scopes,
    credentialId: principal.credentialId,
    credential: principal.auditTag,
  }
}

export async function registerAuthWhoamiRoute(
  fastify: FastifyInstance,
  authService: HubCredentialVerifierDeps['authService'],
  addonRegistry: HubCredentialVerifierDeps['addonRegistry'],
): Promise<void> {
  fastify.get('/api/auth/whoami', async (request, reply) => {
    const authHeader = request.headers.authorization
    if (!authHeader) {
      const refused: WhoamiRefused = { ok: false, error: 'No Authorization header' }
      return reply.status(401).send(refused)
    }
    const answer = await resolveWhoami(
      { authService, addonRegistry },
      authHeader.replace('Bearer ', ''),
    )
    if (answer === null) {
      const refused: WhoamiRefused = {
        ok: false,
        error: 'Token not recognised (revoked, expired, or never issued)',
      }
      return reply.status(401).send(refused)
    }
    return reply.send(answer)
  })
}
