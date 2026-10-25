/**
 * The ONE credential verifier (D892).
 *
 * Every bearer the hub accepts — on tRPC, on `/addon/:addonId/*`, on the
 * upload and whoami routes — is turned into a {@link Principal} here, and its
 * permissions are a `CredentialScope[]`. Nothing downstream asks which kind of
 * credential arrived: authorization reads `principal.scopes` through one
 * matcher (`principal-authorization.ts`).
 *
 * What each credential carries:
 *
 *   | credential                  | scopes                                         |
 *   |-----------------------------|------------------------------------------------|
 *   | session JWT, admin          | `'*'`                                          |
 *   | session JWT, non-admin      | the viewer row alone (or nothing) + `addon-routes` |
 *   | `oauth-access` account link | the grant's scopes                             |
 *   | token (`auth.mintToken`)    | its row's `scopes`                             |
 *
 * There is no other format: a bearer that is not a hub JWT authenticates
 * nobody (D895 removed the pre-D892 opaque formats outright).
 */
import type {
  BearerPayloadShape,
  CredentialScope,
  CredentialTokenClaims,
  UserScope,
} from '@camstack/types'
import {
  ADMIN_SCOPE,
  ALL_METHOD_ACCESS,
  classifyBearerPrincipal,
  normalizeTokenScopes,
  PREFERENCES_SELF_SCOPE,
  scopesGrantAdmin,
} from '@camstack/types'
import type { UserManagementInternal } from '@camstack/system'
import type { DeviceScopeLookup } from '../api/trpc/scope-access.js'
import { readCredentialIdentity } from '../api/trpc/trpc-error-principal.js'
import { personSessionScopes } from './person-session-scopes.js'
import { intersectScopes } from './scope-escalation.js'

/**
 * Where the credential came from — for ATTRIBUTION (logs, the audit) only. No
 * gate reads it.
 */
export type PrincipalAuditTag = 'session' | 'integration' | 'token'

export interface Principal {
  /** The user the credential acts for. */
  readonly subjectId: string
  /** A display label (`alice`, `token:nightly backup`); never a secret. */
  readonly username: string
  /** Every permission the credential carries. */
  readonly scopes: readonly CredentialScope[]
  /** `scopes` holds `'*'`. */
  readonly isAdmin: boolean
  /** The id of the row that backs the credential: session, token, link. Revocation names it. */
  readonly credentialId: string
  readonly auditTag: PrincipalAuditTag
  /**
   * A person signed in through a login session (a session JWT). This is the
   * credential's PROVENANCE, not a permission: it is what lets a principal
   * re-authenticate, mint a token, or manage its own sessions — a token can
   * never mint a token (D816).
   */
  readonly interactive: boolean
  /**
   * The user holds this credential THEMSELVES — a login session, or an
   * account link they consented to — rather than a token minted from one.
   * Provenance again: such a principal may manage its share links and hand
   * itself a code; a minted token may not widen its own reach.
   */
  readonly userDelegated: boolean
  /** The login session (`sid`) behind a session JWT. */
  readonly sessionId?: string
  /** The OAuth session behind an account-link token. Diagnostics only. */
  readonly oauthSessionId?: string
  /** The `provider` claim of an account-link token, e.g. `oauth-access`. Diagnostics only. */
  readonly credential?: string
}

/** What the audit of an admin-capable token's use records about the request. */
export interface RequestFacts {
  readonly path?: string
  readonly ip?: string
}

export interface VerifierLogger {
  warn(message: string, options?: { meta?: Record<string, unknown> }): void
}

/** The user-management surface the verifier reads: who exists, who is admin, live scopes. */
export interface VerifierUserDirectory {
  listUsers?(): Promise<readonly { id: string; isAdmin: boolean; scopes?: readonly UserScope[] }[]>
}

/** A live unified-token row, as the verifier needs it. */
export interface VerifiedTokenRow {
  readonly id: string
  readonly subjectId: string
  readonly label: string
  readonly scopes: readonly CredentialScope[]
}

/** The unified-token store: the row behind a `jti`, or `null` (unknown, revoked, expired). */
export interface VerifierTokenRows {
  lookupLive(jti: string): Promise<VerifiedTokenRow | null>
}

/**
 * The claims of a verified hub JWT, as signed — every field unknown until read
 * (a session, an account link, a unified token, or something to refuse).
 */
export interface VerifiedJwtClaims extends BearerPayloadShape {
  readonly username?: unknown
  readonly sid?: unknown
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export interface CredentialVerifierDeps {
  /**
   * Verify a hub session-family JWT (signature, expiry, the login session
   * behind a session JWT). Throws when invalid — and for a minted token, which
   * carries its own audience and is refused by every raw verify (D895).
   */
  readonly verifyJwt: (token: string) => VerifiedJwtClaims
  /** Verify a minted token (`auth.mintToken`): signature + its audience. Throws when invalid. */
  readonly verifyCredentialJwt: (token: string) => CredentialTokenClaims
  readonly users: () => VerifierUserDirectory | null
  readonly internal: () => UserManagementInternal | null
  readonly tokenRows: () => VerifierTokenRows | null
  readonly logger?: VerifierLogger | null
  readonly now?: () => number
  /** The live-scope memo; shared across verifiers so it outlives a request. */
  readonly scopeMemo?: ScopeMemo
  /** The user-list memo; shared across verifiers so it outlives a request. */
  readonly usersMemo?: UsersMemo
  /** Ancestor / type / location lookups for device selectors (tRPC passes it). */
  readonly deviceScopeLookup?: DeviceScopeLookup
}

export interface CredentialVerifier {
  /** The principal behind `bearer`, or `null` when it authenticates nobody. Never throws. */
  verify(bearer: string | null | undefined, facts?: RequestFacts): Promise<Principal | null>
}

/** What a non-admin person's session reaches on addon routes: every flavour, as before D892. */
const SESSION_ADDON_ROUTES: CredentialScope = {
  type: 'addon-routes',
  access: [...ALL_METHOD_ACCESS],
}

// ── Live scopes for a non-admin session ────────────────────────────────

/**
 * The JWT embeds scopes at login, so an admin's scope edit reached a live
 * session only at the next login (2026-08-15). The store is re-read per user,
 * memoized: a change propagates within the TTL and a busy session costs one
 * store read per window. The JWT's copy is the fallback when the store is
 * unreachable, so a hiccup never locks anybody out mid-request.
 */
const SCOPE_REFRESH_TTL_MS = 30_000
const SCOPE_REFRESH_MISS_TTL_MS = 5_000
const SCOPE_MEMO_MAX = 512

export interface ScopeMemoEntry {
  readonly at: number
  readonly scopes: readonly UserScope[] | null
}

/** userId -> the scopes last read from the store (or `null`: unreadable). */
export type ScopeMemo = Map<string, ScopeMemoEntry>

/**
 * The user list, read at most once per {@link USERS_MEMO_TTL_MS}: every token
 * and account-link verify asks whether its subject still exists and is still
 * an admin, and that must not cost a full store read per request. A deletion
 * or a demotion therefore applies within the window.
 */
const USERS_MEMO_TTL_MS = 5_000

type DirectoryUser = { id: string; isAdmin: boolean; scopes?: readonly UserScope[] }

export interface UsersMemo {
  entry: {
    readonly at: number
    /** The directory the list came from: another directory never reuses it. */
    readonly source: VerifierUserDirectory
    readonly users: readonly DirectoryUser[]
  } | null
}

/** Is `userId` still a user, and still an admin? `null` when it cannot be read. */
interface SubjectFacts {
  readonly exists: boolean
  readonly isAdmin: boolean
}

export function createCredentialVerifier(deps: CredentialVerifierDeps): CredentialVerifier {
  const now = deps.now ?? Date.now
  const scopeMemo: ScopeMemo = deps.scopeMemo ?? new Map()
  const usersMemo: UsersMemo = deps.usersMemo ?? { entry: null }

  const listUsersOnce = async (): Promise<readonly DirectoryUser[] | null> => {
    const at = now()
    const users = deps.users()
    if (users === null || typeof users.listUsers !== 'function') return null
    const cached = usersMemo.entry
    if (cached !== null && cached.source === users && at - cached.at < USERS_MEMO_TTL_MS) {
      return cached.users
    }
    try {
      const fresh = await users.listUsers()
      usersMemo.entry = { at, source: users, users: fresh }
      return fresh
    } catch {
      return null
    }
  }

  const liveScopes = async (userId: string): Promise<readonly UserScope[] | null> => {
    const at = now()
    const cached = scopeMemo.get(userId)
    if (
      cached !== undefined &&
      at - cached.at < (cached.scopes === null ? SCOPE_REFRESH_MISS_TTL_MS : SCOPE_REFRESH_TTL_MS)
    ) {
      return cached.scopes
    }
    const fresh = (await listUsersOnce())?.find((u) => u.id === userId)
    const scopes = fresh === undefined ? null : normalizeTokenScopes(fresh.scopes ?? [])
    scopeMemo.set(userId, { at, scopes })
    if (scopeMemo.size > SCOPE_MEMO_MAX) {
      for (const [key, entry] of scopeMemo) {
        if (at - entry.at > SCOPE_REFRESH_TTL_MS * 4) scopeMemo.delete(key)
      }
    }
    return scopes
  }

  const subjectFacts = async (userId: string): Promise<SubjectFacts | null> => {
    const all = await listUsersOnce()
    if (all === null) return null
    const user = all.find((u) => u.id === userId)
    return user === undefined
      ? { exists: false, isAdmin: false }
      : { exists: true, isAdmin: user.isAdmin }
  }

  const auditAdminUse = (principal: Principal, facts: RequestFacts, name: string): void => {
    const internal = deps.internal()
    if (internal === null) return
    void internal.audit
      .record({
        action: 'admin-token-used',
        userId: principal.subjectId,
        ...(facts.ip !== undefined ? { ip: facts.ip } : {}),
        detail: {
          tokenId: principal.credentialId,
          name,
          ...(facts.path !== undefined ? { path: facts.path } : {}),
        },
      })
      .catch(() => {})
  }

  // ── The unified token ────────────────────────────────────────────────

  /** `row`'s scopes cut down to what its (non-admin) subject holds now; `null` when unreadable. */
  const narrowedToSubject = async (
    row: VerifiedTokenRow,
  ): Promise<readonly CredentialScope[] | null> => {
    const live = await liveScopes(row.subjectId)
    if (live === null) return null
    return intersectScopes(row.scopes, live, deps.deviceScopeLookup)
  }

  const unifiedToken = async (
    claims: CredentialTokenClaims,
    facts: RequestFacts,
  ): Promise<Principal | null> => {
    const rows = deps.tokenRows()
    if (rows === null) return null
    // Revocation and expiry live on the row, looked up by `jti` every time.
    const row = await rows.lookupLive(claims.jti).catch(() => null)
    if (row === null || row.subjectId !== claims.sub) return null
    // The subject must still exist; an admin token dies with its subject's admin bit.
    const subject = await subjectFacts(row.subjectId)
    if (subject === null || !subject.exists) return null
    if (scopesGrantAdmin(row.scopes) && !subject.isAdmin) return null
    // The ROW's scopes, never the claim's: the row is what the operator listed.
    // A non-admin's token never outgrows its subject: an admin who narrows the
    // user narrows every token the user minted, at the next verify.
    const scopes = subject.isAdmin ? row.scopes : await narrowedToSubject(row)
    if (scopes === null || scopes.length === 0) return null
    const principal: Principal = {
      subjectId: row.subjectId,
      username: `token:${row.label}`,
      scopes,
      isAdmin: scopesGrantAdmin(scopes),
      credentialId: row.id,
      auditTag: 'token',
      interactive: false,
      userDelegated: false,
    }
    if (principal.isAdmin) auditAdminUse(principal, facts, row.label)
    return principal
  }

  // ── Session and account-link JWTs ────────────────────────────────────

  /** A minted token's claims, or `null` when `token` is not one (D895: its own audience). */
  const credentialClaims = (token: string): CredentialTokenClaims | null => {
    try {
      return deps.verifyCredentialJwt(token)
    } catch {
      return null
    }
  }

  const hubJwt = async (token: string, facts: RequestFacts): Promise<Principal | null> => {
    let payload: VerifiedJwtClaims
    try {
      payload = deps.verifyJwt(token)
    } catch {
      // Not a session-family JWT. A minted token is refused by `verifyJwt` by
      // construction (its audience), and verifies only through its own door.
      const claims = credentialClaims(token)
      return claims === null ? null : unifiedToken(claims, facts)
    }
    // A pre-v2 JWT (no `isAdmin`) would degrade into "non-admin, no scopes";
    // refuse it so the client signs in again.
    if (typeof payload.isAdmin !== 'boolean') return null
    // Every token this hub mints verifies under one key, so a valid signature
    // means "we minted this", never "this is an API credential" (D103). Only a
    // session and an `oauth-access` link are credentials; a code, a refresh
    // token, a bridge, a TOTP challenge are refused.
    const classified = classifyBearerPrincipal(payload)
    if (classified.kind === 'not-a-credential') {
      deps.logger?.warn('auth: refused a bearer that is not an API credential', {
        meta: { reason: classified.reason, userId: stringClaim(payload.userId) ?? 'unknown' },
      })
      return null
    }
    const userId = stringClaim(payload.userId) ?? 'unknown'
    const username = stringClaim(payload.username) ?? 'unknown'
    if (classified.kind === 'integration') {
      // An account link is governed by the grant the operator consented to,
      // never by the linking user's record (2026-08-19), and never admin. Its
      // subject must still be a user: a link minted for nobody (an empty
      // `userId`) or for a deleted account authenticates nobody.
      const subject = userId === 'unknown' || userId === '' ? null : await subjectFacts(userId)
      if (subject === null || !subject.exists) return null
      const identity = readCredentialIdentity(payload)
      return {
        subjectId: userId,
        username,
        scopes: normalizeTokenScopes(payload.scopes ?? []),
        isAdmin: false,
        credentialId: identity.sessionId ?? `oauth:${userId}`,
        auditTag: 'integration',
        interactive: false,
        userDelegated: true,
        ...(identity.sessionId !== undefined ? { oauthSessionId: identity.sessionId } : {}),
        ...(identity.credential !== undefined ? { credential: identity.credential } : {}),
      }
    }
    const sessionId = stringClaim(payload.sid)
    const base = {
      subjectId: userId,
      username,
      credentialId: sessionId ?? `session:${userId}`,
      auditTag: 'session' as const,
      interactive: true,
      userDelegated: true,
      ...(sessionId !== undefined ? { sessionId } : {}),
    }
    // A person's session always reaches its OWN account preferences (D894);
    // `'*'` does not imply that grant, so the admin session names it too.
    if (payload.isAdmin) {
      return { ...base, scopes: [ADMIN_SCOPE, PREFERENCES_SELF_SCOPE], isAdmin: true }
    }
    const fresh = await liveScopes(userId)
    const capability = fresh ?? normalizeTokenScopes(payload.scopes ?? [])
    return {
      ...base,
      // The stored rows may still be a pre-viewer grant set. A person is
      // decided by the viewer row alone; the rest is not a role.
      scopes: personSessionScopes([...capability, SESSION_ADDON_ROUTES, PREFERENCES_SELF_SCOPE]),
      isAdmin: false,
    }
  }

  return {
    async verify(bearer, facts = {}) {
      if (bearer === null || bearer === undefined || bearer === '') return null
      try {
        return await hubJwt(bearer, facts)
      } catch {
        return null
      }
    },
  }
}
