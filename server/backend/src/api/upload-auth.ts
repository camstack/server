/**
 * Shared auth guard for the REST upload routes (`/api/addons/upload` and
 * `/api/server-upload`).
 *
 * Every credential goes through the hub's one verifier. An upload installs
 * code that runs on the hub, so it is ADMIN only: the principal's scopes must
 * hold `'*'`. A grant of `create` on the `addons` capability is NOT enough —
 * that reach is a capability permission, and an addon tarball or a server
 * closure is arbitrary code execution (security review 2026-10-21).
 */
import { hubCredentialVerifier } from './trpc/trpc.context.js'
import type { CredentialTokenClaims } from '@camstack/types'
import type { VerifiedJwtClaims } from '../auth/credential-verifier.js'

/** Structural slice of `AuthService` the guard needs (session JWT and minted-token verification). */
export interface UploadAuthTokenVerifier {
  verifyToken(token: string): VerifiedJwtClaims
  verifyCredentialToken(token: string): CredentialTokenClaims
}

/** Structural slice of the capability registry the guard needs. */
export interface UploadAuthCapRegistry {
  getSingleton(capability: string): unknown
}

/** Structural slice of `AddonRegistryService` the guard needs. */
export interface UploadAuthAddonRegistry {
  getCapabilityRegistry(): UploadAuthCapRegistry
}

export type UploadAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403; readonly error: string }

export interface AuthorizeUploadArgs {
  readonly authHeader: string | undefined
  readonly authService: UploadAuthTokenVerifier
  readonly addonRegistry: UploadAuthAddonRegistry
}

/**
 * The upload gate: the ONE verifier, then `'*'` (D892, D895). Answers:
 *   - 401 `Unauthorized` when no Authorization header is present, or the
 *     bearer authenticates nobody (revoked, expired, never issued),
 *   - 403 `Forbidden: admin only` for a principal that is not an admin.
 */
export async function authorizeUploadRequest(args: AuthorizeUploadArgs): Promise<UploadAuthResult> {
  const { authHeader, authService, addonRegistry } = args
  if (!authHeader) {
    return { ok: false, status: 401, error: 'Unauthorized' }
  }
  const token = authHeader.replace('Bearer ', '')
  const principal = await hubCredentialVerifier({ authService, addonRegistry }).verify(token)
  if (principal === null) {
    return { ok: false, status: 401, error: 'Unauthorized: token not recognised' }
  }
  if (!principal.isAdmin) return { ok: false, status: 403, error: 'Forbidden: admin only' }
  return { ok: true }
}
