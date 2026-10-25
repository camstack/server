/**
 * The ONE row shape of Identity → Tokens & sessions (D819).
 *
 * Every credential kind — login sessions, linked apps, tokens (share links
 * included), sign-in links, legacy API keys — is mapped into this shape, so
 * every section renders the same columns in the same order with the same
 * sort and filter rules: name, owner, kind / scope, status, created, last
 * used, expires, actions. The mappers are pure and live here, next to the
 * shape, so a spec can pin what a hub record becomes.
 */

/** `current` = the caller's own session, which no action on this page ends. */
export type CredentialStatus = 'active' | 'expired' | 'revoked' | 'current'

export interface CredentialRow {
  readonly id: string
  /** Primary label: a token's name, a session's device, a link's cameras. */
  readonly name: string
  /** Secondary line: a prefix, an IP, a subject. */
  readonly detail: string | null
  readonly ownerId: string | null
  readonly ownerName: string
  /** One short value — the facet the Kind chips filter on. */
  readonly kind: string
  /** The grant, in words (scopes, devices). Null when the kind says it all. */
  readonly scope: string | null
  readonly status: CredentialStatus
  readonly createdAt: number | null
  readonly lastUsedAt: number | null
  /** `null` = never expires (or the kind has no expiry). */
  readonly expiresAt: number | null
}

export type UserNames = ReadonlyMap<string, string>

const ownerName = (names: UserNames, id: string | null): string =>
  id === null ? '—' : (names.get(id) ?? id)

function lifecycle(expiresAt: number | null | undefined, now: number): CredentialStatus {
  return expiresAt !== null && expiresAt !== undefined && expiresAt <= now ? 'expired' : 'active'
}

// ── Login sessions (D812) ────────────────────────────────────────────────

export interface LoginSessionSource {
  readonly id: string
  readonly userId: string
  readonly method: string
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly expiresAt: number
  readonly client: string | null
  readonly ip: string | null
  readonly current: boolean
}

export function loginSessionRow(
  s: LoginSessionSource,
  names: UserNames,
  describe: {
    readonly client: (raw: string | null) => string
    readonly method: (m: string) => string
  },
): CredentialRow {
  return {
    id: s.id,
    name: describe.client(s.client),
    detail: s.ip,
    ownerId: s.userId,
    ownerName: ownerName(names, s.userId),
    kind: describe.method(s.method),
    scope: null,
    status: s.current ? 'current' : 'active',
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    expiresAt: s.expiresAt,
  }
}

// ── Linked apps (OAuth account-link sessions) ────────────────────────────

export interface LinkedAppSource {
  readonly id: string
  readonly userId: string
  readonly username: string
  readonly integrationId: string
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly revokedAt: number | null
}

export function linkedAppRow(s: LinkedAppSource, scope: string): CredentialRow {
  return {
    id: s.id,
    name: s.integrationId,
    detail: null,
    ownerId: s.userId,
    ownerName: s.username,
    kind: s.integrationId,
    scope,
    status: s.revokedAt !== null ? 'revoked' : 'active',
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    expiresAt: null,
  }
}

// ── Tokens (`auth.listTokens`, D892/D895) ───────────────────────────────
//
// One token format: what a token may do is its scopes. An admin token is a
// token holding `'*'`; a share link is a token whose only scope is a
// share-view grant. The row shows the scopes — there is no token "kind".

/** A token's one share-view grant, as `auth.listTokens` lists it. */
export interface ShareGrantSource {
  readonly kind: 'grid-view' | 'events-view'
  readonly deviceIds: readonly number[]
  readonly talk?: boolean
}

/** A capability, addon, category or device grant of a token, as listed. */
export interface GrantScopeSource {
  readonly type: string
  readonly target?: string
  readonly selector?: unknown
  readonly access?: readonly string[]
}

/** A share-view grant of a token, as listed. */
export interface ShareScopeSource {
  readonly type: 'share-view'
  readonly grant: ShareGrantSource
}

/** One scope of a token, as listed: `'*'`, a share-view grant, or another grant. */
export type TokenScopeSource = '*' | ShareScopeSource | GrantScopeSource

export interface TokenSource {
  readonly id: string
  readonly subjectId: string
  readonly label: string
  readonly scopes: readonly TokenScopeSource[]
  readonly createdAt: number
  readonly expiresAt: number | null
  readonly lastUsedAt: number | null
  readonly revokedAt: number | null
}

/** What the Scope filter chips group tokens by: the reach, in words. */
export const TOKEN_REACH_ALL = 'All permissions'
export const TOKEN_REACH_VIEW_LINK = 'View link'
export const TOKEN_REACH_SCOPED = 'Scoped'

const SHARE_KIND: Readonly<Record<ShareGrantSource['kind'], string>> = {
  'grid-view': 'Grid',
  'events-view': 'Events',
}

/** A device id the roster does not know stays visible as its id. */
export function describeCameras(
  deviceIds: readonly number[],
  nameById: ReadonlyMap<number, string>,
): string {
  return deviceIds.map((id) => nameById.get(id) ?? `#${String(id)}`).join(', ')
}

function isShareScope(scope: TokenScopeSource): scope is ShareScopeSource {
  return scope !== '*' && scope.type === 'share-view' && 'grant' in scope
}

/** One scope in words; `describeGrant` renders a capability / device grant. */
export function describeTokenScope(
  scope: TokenScopeSource,
  cameras: ReadonlyMap<number, string>,
  describeGrant: (scope: GrantScopeSource) => string,
): string {
  if (scope === '*') return TOKEN_REACH_ALL
  if (isShareScope(scope)) {
    const view = `${SHARE_KIND[scope.grant.kind]} view${scope.grant.talk === true ? ' + talk' : ''}`
    return `${view}: ${describeCameras(scope.grant.deviceIds, cameras)}`
  }
  return describeGrant(scope)
}

export function tokenReach(scopes: readonly TokenScopeSource[]): string {
  if (scopes.includes('*')) return TOKEN_REACH_ALL
  if (scopes.some(isShareScope)) return TOKEN_REACH_VIEW_LINK
  return TOKEN_REACH_SCOPED
}

/** `scope` is the scopes in words; `null` when the reach says it all (`'*'`). */
export function tokenRow(
  t: TokenSource,
  names: UserNames,
  scope: string | null,
  now: number,
): CredentialRow {
  return {
    id: t.id,
    name: t.label,
    detail: null,
    ownerId: t.subjectId,
    ownerName: ownerName(names, t.subjectId),
    kind: tokenReach(t.scopes),
    scope,
    status: t.revokedAt !== null ? 'revoked' : lifecycle(t.expiresAt, now),
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    expiresAt: t.expiresAt,
  }
}

// ── External sign-in identities (D782) ───────────────────────────────────

export interface ExternalIdentitySource {
  readonly provider: string
  readonly subject: string
  readonly issuer: string
  readonly userId: string
  readonly label?: string
  readonly linkedAt: number
}

/** Identities have no id of their own: provider + subject is the key. */
export function externalIdentityKey(i: { readonly provider: string; readonly subject: string }) {
  return `${i.provider}\u0000${i.subject}`
}

export function externalIdentityRow(i: ExternalIdentitySource, names: UserNames): CredentialRow {
  return {
    id: externalIdentityKey(i),
    name: i.label ?? i.subject,
    detail: i.issuer,
    ownerId: i.userId,
    ownerName: ownerName(names, i.userId),
    kind: i.provider,
    scope: null,
    status: 'active',
    createdAt: i.linkedAt,
    lastUsedAt: null,
    expiresAt: null,
  }
}
