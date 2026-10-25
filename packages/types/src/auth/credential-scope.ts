/**
 * The ONE permission vocabulary every credential is reduced to (D892).
 *
 * A credential — a login session, an account-link token, or a token
 * `auth.mintToken` issues (there is no other format, D895) — is
 * verified into a principal whose permissions are a `CredentialScope[]`, and
 * nothing else. What KIND of credential it was never decides what it may do:
 *
 *   - `'*'` — everything (the admin bypass). Held by an admin's session and
 *     a token minted with it.
 *   - a {@link TokenScope} — the v3 capability grants (`category`,
 *     `capability`, `addon`, `device`) the tRPC matcher has always applied.
 *   - `share-view` — one fail-closed embed perimeter (`grid-view` /
 *     `events-view`) over a few devices. A principal that holds one is
 *     RESTRICTED to it: the matcher honours nothing else it holds.
 *   - `addon-routes` — may reach any addon's own `authenticated` HTTP routes
 *     and data planes (never an `admin` one). A person's session has always
 *     had this; an integration token never had it and must hold
 *     `addon:<id>` instead. Only an admin may mint it into a token.
 *   - `preferences-self` — may read and write the SUBJECT's own account
 *     preferences (D894), never another user's. Every person's session holds
 *     it; a unified token holds it only when minted with it. `'*'` does NOT
 *     imply it: the hub's own mesh principal holds `'*'` and is nobody's
 *     account.
 *
 * Pure: no I/O. It lives in `@camstack/types` so the hub, the kernel and any
 * addon read the same vocabulary.
 */
import { z } from 'zod'
import { SHARE_VIEW_KINDS } from '../interfaces/addon-data-plane.js'
import { MethodAccessSchema, type UserScope, TokenScopeSchema } from '../schemas/auth-records.js'
import { ViewerTokenScopeSchema } from './viewer-access.js'

/** The admin scope: every permission. */
export const ADMIN_SCOPE = '*'

/** At most this many devices in one share-view grant (the share-link bound). */
export const SHARE_VIEW_MAX_DEVICES = 64

/** What a share-view grant lets its holder see. */
export const ShareViewGrantSchema = z.object({
  kind: z.enum(SHARE_VIEW_KINDS),
  deviceIds: z.array(z.number().int().nonnegative()).min(1).max(SHARE_VIEW_MAX_DEVICES),
  /** Talk-back, opt-in at mint time; absent means off. */
  talk: z.boolean().optional(),
})
export type ShareViewGrant = z.infer<typeof ShareViewGrantSchema>

export const ShareViewScopeSchema = z.object({
  type: z.literal('share-view'),
  grant: ShareViewGrantSchema,
})
export type ShareViewScope = z.infer<typeof ShareViewScopeSchema>

export const AddonRoutesScopeSchema = z.object({
  type: z.literal('addon-routes'),
  access: z.array(MethodAccessSchema).min(1),
})
export type AddonRoutesScope = z.infer<typeof AddonRoutesScopeSchema>

export const PreferencesSelfScopeSchema = z.object({
  type: z.literal('preferences-self'),
})
export type PreferencesSelfScope = z.infer<typeof PreferencesSelfScopeSchema>

/** The grant every person's session carries for its own account preferences. */
export const PREFERENCES_SELF_SCOPE: PreferencesSelfScope = { type: 'preferences-self' }

export const CredentialScopeSchema = z.union([
  z.literal(ADMIN_SCOPE),
  ShareViewScopeSchema,
  AddonRoutesScopeSchema,
  PreferencesSelfScopeSchema,
  // A viewer's grant (D921): decided by its own rules, alone.
  ViewerTokenScopeSchema,
  TokenScopeSchema,
])
export type CredentialScope = z.infer<typeof CredentialScopeSchema>

/** Every access flavour — what a person's session holds on addon routes. */
export const ALL_METHOD_ACCESS = ['view', 'create', 'delete'] as const

function isUserScope(scope: CredentialScope): scope is UserScope {
  return (
    scope !== ADMIN_SCOPE &&
    scope.type !== 'share-view' &&
    scope.type !== 'addon-routes' &&
    scope.type !== 'preferences-self'
  )
}

/** True iff the scope set holds `'*'`. */
export function scopesGrantAdmin(scopes: readonly CredentialScope[]): boolean {
  return scopes.includes(ADMIN_SCOPE)
}

/**
 * The share-view grant that RESTRICTS this principal, or `null` when it holds
 * none. Fail closed: a set that mixes a share-view grant with anything else
 * is still restricted to its FIRST share-view grant, never widened by the rest.
 */
export function shareViewGrantOf(scopes: readonly CredentialScope[]): ShareViewGrant | null {
  for (const scope of scopes) {
    if (scope !== ADMIN_SCOPE && scope.type === 'share-view') return scope.grant
  }
  return null
}

/** The grants the tRPC scope matcher reads: capability rows, or a viewer row (D921). */
export function capabilityScopesOf(scopes: readonly CredentialScope[]): readonly UserScope[] {
  return scopes.filter(isUserScope)
}

/** True iff the set reaches every addon's own routes at `access`. */
export function scopesAllowAddonRoutes(
  scopes: readonly CredentialScope[],
  access: z.infer<typeof MethodAccessSchema>,
): boolean {
  return scopes.some(
    (s) => s !== ADMIN_SCOPE && s.type === 'addon-routes' && s.access.includes(access),
  )
}

/**
 * True iff the set may touch its subject's own account preferences: it holds
 * `preferences-self` and no share-view grant restricts it. `'*'` alone is not
 * enough (see the vocabulary above).
 */
export function scopesAllowOwnPreferences(scopes: readonly CredentialScope[]): boolean {
  if (shareViewGrantOf(scopes) !== null) return false
  return scopes.some((s) => s !== ADMIN_SCOPE && s.type === 'preferences-self')
}

/**
 * Parse a scope array from an untrusted source (a JWT claim, a stored row).
 * Any element that does not parse makes the WHOLE set unusable — `null` — so
 * a corrupt grant can never degrade into a partial one.
 */
export function parseCredentialScopes(raw: unknown): readonly CredentialScope[] | null {
  const parsed = z.array(CredentialScopeSchema).safeParse(raw)
  return parsed.success ? parsed.data : null
}

// ── The unified token ──────────────────────────────────────────────────

/**
 * The `kind` claim of a unified token. It names the TOKEN FAMILY (so every
 * older gate that classifies a hub JWT refuses it — `classifyBearerPrincipal`
 * treats any `kind` it does not know as not-a-credential), never what the
 * token may do: that is its `scopes`, and only its `scopes`.
 */
export const CREDENTIAL_TOKEN_KIND = 'credential'

/**
 * The `aud` claim every minted token is signed with (D895). The hub's raw JWT
 * verify (`AuthManager.verifyToken`, used by every surface that wants a LOGIN
 * session — the OAuth consent page, the session cookie, health, backups)
 * refuses a token carrying it, so a minted token — a share link above all —
 * can never be replayed as a person's session. Only the credential verifier's
 * own door (`verifyCredentialToken`) accepts it.
 */
export const CREDENTIAL_TOKEN_AUDIENCE = 'camstack:credential'

/** Does a verified JWT payload belong to the minted-token family? */
export function isCredentialTokenPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false
  const kind: unknown = Reflect.get(payload, 'kind')
  const aud: unknown = Reflect.get(payload, 'aud')
  return (
    kind === CREDENTIAL_TOKEN_KIND ||
    aud === CREDENTIAL_TOKEN_AUDIENCE ||
    (Array.isArray(aud) && aud.includes(CREDENTIAL_TOKEN_AUDIENCE))
  )
}

/**
 * The claims of a unified token (`auth.mintToken`). It carries no `exp`: its
 * row (looked up by `jti` on every verify, for revocation) holds the ONE
 * expiry, so a share link can be extended and a JWT clock can never disagree
 * with the row.
 */
export const CredentialTokenClaimsSchema = z.object({
  kind: z.literal(CREDENTIAL_TOKEN_KIND),
  sub: z.string().min(1),
  jti: z.string().min(16),
  scopes: z.array(CredentialScopeSchema).min(1),
})
export type CredentialTokenClaims = z.infer<typeof CredentialTokenClaimsSchema>
