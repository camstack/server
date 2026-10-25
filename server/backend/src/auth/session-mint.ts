/**
 * THE session mint (D712): the only place in the codebase that signs a
 * session JWT. Every login leg — password, TOTP / passkey second factor,
 * passkey-first, session exchange, handoff code AND the SSO finish redirect —
 * ends here, so a session always carries the claims of the user record AS IT
 * IS NOW, read at mint time.
 *
 * Why one path: `/api/auth/sso/finish` used to sign its own session from the
 * bridge's claims, with `allowedDevices: {}`, no scopes and the bridge's
 * `isAdmin`. An SSO bridge for a user deleted (or demoted) after it was
 * mailed still minted a session — and with the bridge's stale `isAdmin` — and
 * the live scope refresh in `trpc.context.ts` cannot repair that afterwards:
 * it refreshes only a NON-admin session's scopes, falls back to the JWT on a
 * missing user, and never touches `isAdmin` or `allowedDevices`.
 *
 * Every session token belongs to a server-side login session (`sid`, the
 * `login_sessions` table): the mint opens one, or continues one (a refresh,
 * a legacy renewal). A refreshing client gets a short access token and a
 * rotating refresh token; a legacy client — one that predates refresh tokens
 * and renews through the handoff-code pair — gets an access token that lives
 * as long as its session (kept for one release).
 *
 * `scripts/check-session-jwt-single-mint.ts` keeps `signToken(` out of every
 * other production file.
 */
import type { LoginSessionMethod } from '@camstack/system'
import type { TokenPayload, UserScope } from '@camstack/types'

/** The user-record fields a session is minted from (`user-management` `UserSummary`). */
export interface SessionUserRecord {
  readonly id: string
  readonly username: string
  readonly isAdmin: boolean
  readonly allowedProviders?: TokenPayload['allowedProviders']
  readonly allowedDevices?: TokenPayload['allowedDevices']
  readonly scopes?: readonly UserScope[]
}

/** How a login was made — recorded on its session. */
export interface SessionIssue {
  readonly method: LoginSessionMethod
  /**
   * The client renews with a refresh token: it gets a short access token
   * (`auth.accessTokenExpiry`) and a rotating refresh token. Absent/false — a
   * legacy client: one long access token for the whole session.
   */
  readonly refreshable?: boolean
  /** A short client label (User-Agent) for the sessions list. */
  readonly client?: string
  /** The real client address the login came from. */
  readonly ip?: string
  /** The device credential this login proved (D855): recorded on the session and re-checked at every refresh. */
  readonly credentialId?: string
}

/** What every successful login returns: the session and who it is for. */
export interface MintedSession {
  readonly token: string
  readonly user: { readonly id: string; readonly username: string; readonly isAdmin: boolean }
  readonly requiresTotp: false
  /** When the ACCESS token expires (epoch ms). */
  readonly expiresAt?: number
  /** The server-side session this token belongs to. */
  readonly sessionId?: string
  /** When the SESSION expires unless refreshed (epoch ms). */
  readonly sessionExpiresAt?: number
  /** Present for a refreshing client: swap it at `auth.refreshSession` before `expiresAt`. */
  readonly refreshToken?: string
}

/** The slice of `user-management` the mint reads. */
export interface SessionUserDirectory {
  listUsers?(): Promise<readonly SessionUserRecord[]>
}

export interface SessionSigner {
  signToken(
    payload: Omit<TokenPayload, 'iat' | 'exp'>,
    options?: { readonly expiresInSec?: number },
  ): string
}

/** A session row as the mint needs it. */
export interface OpenedSession {
  readonly id: string
  readonly userId: string
  readonly expiresAt: number
  /** The device credential that opened the session, when one did. */
  readonly credentialId?: string | null
}

export type RotatedSession =
  | { readonly ok: true; readonly session: OpenedSession; readonly refreshToken: string }
  | { readonly ok: false; readonly reason: 'unknown' | 'expired' | 'revoked' | 'reused' }

/** The login-session table, as the mint drives it (`hub-sessions.ts`). */
export interface SessionBacking {
  open(input: {
    readonly userId: string
    readonly refreshable: boolean
    readonly method: LoginSessionMethod
    readonly client?: string
    readonly ip?: string
    readonly credentialId?: string
  }): Promise<{ readonly session: OpenedSession; readonly refreshToken: string | null }>
  /** The session a refresh token belongs to, without rotating it; `null` when none. */
  peek(refreshToken: string): OpenedSession | null
  /** End a session (a refresh refused on its credential leaves no live session behind). */
  revoke(sessionId: string, reason: 'credential-revoked' | 'credential-expired'): Promise<boolean>
  /** Slide an active session's expiry; `null` when it is not active. */
  extend(sessionId: string): Promise<OpenedSession | null>
  rotate(refreshToken: string): Promise<RotatedSession>
  /** Access-token lifetime for a refreshing client, seconds. */
  accessSec(): number
}

/** The user a credential names is not in `user-management` (deleted, or never existed). */
export class SessionUserGoneError extends Error {
  constructor(readonly userId: string) {
    super('User no longer exists')
    this.name = 'SessionUserGoneError'
  }
}

/** `user-management` is not registered: an infrastructure failure, never a 401. */
export class SessionDirectoryUnavailableError extends Error {
  constructor() {
    super('Login unavailable — `user-management` capability not registered')
    this.name = 'SessionDirectoryUnavailableError'
  }
}

export type SessionRefreshRefusal =
  | 'unknown'
  | 'expired'
  | 'revoked'
  | 'reused'
  | 'user-gone'
  | 'credential-revoked'
  | 'credential-expired'
  | 'credential-unknown'
  | 'credential-unavailable'

/** A refresh token that does not continue a live session. */
export class SessionRefreshRefusedError extends Error {
  constructor(readonly reason: SessionRefreshRefusal) {
    super('Session expired — sign in again')
    this.name = 'SessionRefreshRefusedError'
  }
}

export interface SessionMinter {
  /** Fresh record for `userId`; throws {@link SessionUserGoneError} / {@link SessionDirectoryUnavailableError}. */
  findUser(userId: string): Promise<SessionUserRecord>
  /** Like {@link findUser}, but a missing user is `null`. */
  findUserOrNull(userId: string): Promise<SessionUserRecord | null>
  /** Open a session for a record the caller JUST read from `user-management`. */
  mintForRecord(record: SessionUserRecord, issue: SessionIssue): Promise<MintedSession>
  /** Re-read `userId` and open a session for it. */
  mintForUserId(userId: string, issue: SessionIssue): Promise<MintedSession>
  /**
   * A new access token for an EXISTING session (a legacy client renewing
   * through the handoff pair): the session slides, nothing new is opened.
   * Throws {@link SessionRefreshRefusedError} when the session is not active.
   */
  continueSession(userId: string, sessionId: string): Promise<MintedSession>
  /** Swap a refresh token for a rotated one and a new access token. */
  refresh(refreshToken: string): Promise<MintedSession>
}

/** The device-credential registry, as the refresh path asks it (synchronous). */
export interface CredentialGate {
  check(credentialId: string): 'active' | 'expired' | 'revoked' | 'unknown'
}

export function createSessionMinter(deps: {
  readonly signer: SessionSigner
  readonly directory: () => SessionUserDirectory | null | undefined
  /**
   * The login-session table. Absent ONLY in specs that test the claims: then
   * a token carries no `sid` (a pre-session token). Production always wires
   * it; a backing that answers `null` (user-management not up) fails the mint.
   */
  readonly sessions?: () => SessionBacking | null
  /** The device-credential registry; `null` while it is not up (a credential session then fails closed). */
  readonly credentials?: () => CredentialGate | null
}): SessionMinter {
  const findUserOrNull = async (userId: string): Promise<SessionUserRecord | null> => {
    const directory = deps.directory()
    if (!directory) throw new SessionDirectoryUnavailableError()
    if (typeof directory.listUsers !== 'function') return null
    return (await directory.listUsers()).find((u) => u.id === userId) ?? null
  }
  const findUser = async (userId: string): Promise<SessionUserRecord> => {
    const record = await findUserOrNull(userId)
    if (record === null) throw new SessionUserGoneError(userId)
    return record
  }
  const backing = (): SessionBacking | null => {
    if (deps.sessions === undefined) return null
    const live = deps.sessions()
    if (live === null) throw new SessionDirectoryUnavailableError()
    return live
  }
  const claims = (record: SessionUserRecord, sid: string | undefined, cid?: string | null) => ({
    ...(sid !== undefined ? { sid } : {}),
    ...(cid !== undefined && cid !== null ? { cid } : {}),
    userId: record.id,
    username: record.username,
    isAdmin: record.isAdmin,
    allowedProviders: record.allowedProviders ?? '*',
    allowedDevices: record.allowedDevices ?? {},
    scopes: record.scopes ?? [],
  })
  const user = (record: SessionUserRecord) => ({
    id: record.id,
    username: record.username,
    isAdmin: record.isAdmin,
  })
  /** Sign an access token for `session`: short for a refreshing client, the session's own life otherwise. */
  const signFor = (
    record: SessionUserRecord,
    session: OpenedSession,
    refreshable: boolean,
    live: SessionBacking,
  ): { token: string; expiresAt: number } => {
    const remainingSec = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000))
    const expiresInSec = refreshable ? Math.min(live.accessSec(), remainingSec) : remainingSec
    return {
      token: deps.signer.signToken(claims(record, session.id, session.credentialId), {
        expiresInSec,
      }),
      expiresAt: Date.now() + expiresInSec * 1000,
    }
  }
  const mintForRecord = async (
    record: SessionUserRecord,
    issue: SessionIssue,
  ): Promise<MintedSession> => {
    const live = backing()
    if (live === null) {
      return {
        token: deps.signer.signToken(claims(record, undefined)),
        user: user(record),
        requiresTotp: false,
      }
    }
    const refreshable = issue.refreshable === true
    const opened = await live.open({
      userId: record.id,
      refreshable,
      method: issue.method,
      ...(issue.client !== undefined ? { client: issue.client } : {}),
      ...(issue.ip !== undefined ? { ip: issue.ip } : {}),
      ...(issue.credentialId !== undefined ? { credentialId: issue.credentialId } : {}),
    })
    const access = signFor(record, opened.session, refreshable, live)
    return {
      token: access.token,
      user: user(record),
      requiresTotp: false,
      expiresAt: access.expiresAt,
      sessionId: opened.session.id,
      sessionExpiresAt: opened.session.expiresAt,
      ...(opened.refreshToken !== null ? { refreshToken: opened.refreshToken } : {}),
    }
  }
  return {
    findUser,
    findUserOrNull,
    mintForRecord,
    mintForUserId: async (userId, issue) => mintForRecord(await findUser(userId), issue),
    continueSession: async (userId, sessionId) => {
      const live = backing()
      const record = await findUser(userId)
      if (live === null) return mintForRecord(record, { method: 'handoff' })
      const session = await live.extend(sessionId)
      if (session === null || session.userId !== userId) {
        throw new SessionRefreshRefusedError('revoked')
      }
      const access = signFor(record, session, false, live)
      return {
        token: access.token,
        user: user(record),
        requiresTotp: false,
        expiresAt: access.expiresAt,
        sessionId: session.id,
        sessionExpiresAt: session.expiresAt,
      }
    },
    refresh: async (refreshToken) => {
      const live = backing()
      if (live === null) throw new SessionRefreshRefusedError('unknown')
      // A session opened by a device certificate lives only while that
      // credential does (D855). The credential is judged BEFORE the refresh
      // token is spent: a refusal here leaves the token untouched, so a transient
      // `unavailable` can never turn into a "rotated-out token presented"
      // refresh-reuse revocation on the retry. A revoked / expired credential
      // revokes the session, so nothing is left to refresh.
      const peeked = live.peek(refreshToken)
      const credentialId = peeked?.credentialId ?? null
      if (peeked !== null && credentialId !== null) {
        const gate = deps.credentials?.() ?? null
        const state = gate === null ? 'unavailable' : gate.check(credentialId)
        if (state !== 'active') {
          if (state === 'revoked' || state === 'expired') {
            await live.revoke(peeked.id, `credential-${state}`)
          }
          throw new SessionRefreshRefusedError(`credential-${state}`)
        }
      }
      const rotated = await live.rotate(refreshToken)
      if (!rotated.ok) throw new SessionRefreshRefusedError(rotated.reason)
      const record = await findUserOrNull(rotated.session.userId)
      if (record === null) throw new SessionRefreshRefusedError('user-gone')
      const access = signFor(record, rotated.session, true, live)
      return {
        token: access.token,
        user: user(record),
        requiresTotp: false,
        expiresAt: access.expiresAt,
        sessionId: rotated.session.id,
        sessionExpiresAt: rotated.session.expiresAt,
        refreshToken: rotated.refreshToken,
      }
    },
  }
}
