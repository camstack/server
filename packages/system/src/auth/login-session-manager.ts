/**
 * Login sessions — the server-side record behind every session token.
 *
 * A session token used to be a self-contained 30-day JWT: nothing on the hub
 * knew it existed, so logout revoked nothing, a password change left every
 * other device signed in, and a deleted user's sessions lived until they
 * expired. Now every login creates a row here and the token carries its id
 * (`sid`); the hub checks the row on every request (`check`, an in-memory
 * lookup), so revoking a row ends the session at once.
 *
 * Two kinds of client:
 *  - **refreshable** — gets a short access token (default 2 h) and an opaque
 *    refresh token (`csr_…`, stored hashed). `refresh` rotates the refresh
 *    token and slides the session's expiry; presenting a rotated-out refresh
 *    token after a short grace window is treated as theft and revokes the
 *    whole session.
 *  - **legacy** — a client from before refresh tokens: its access token lives
 *    as long as the session, and it renews through the handoff-code pair
 *    (`extend`). Kept for one release so installed viewer apps keep working.
 *
 * `legacyCutoff(userId)` covers tokens minted before sessions existed (no
 * `sid`): a token of that user issued before the cutoff is refused. Revoking
 * all of a user's sessions moves the cutoff, so a password change or a user
 * deletion also ends their pre-session tokens.
 *
 * Mirror: every row is held in memory (a homelab hub has tens of sessions) and
 * written through to the store; revocations update the mirror FIRST, so a
 * store hiccup can delay persistence but never the revocation itself.
 */
import * as crypto from 'node:crypto'
import type {
  CollectionColumn,
  IScopedLogger,
  RecordKindHandle,
  SettingsStoreClient,
} from '@camstack/types'
import { readAllRows } from '../records/read-all-rows.js'
import type {
  LoginSessionBody,
  LoginSessionCutoffBody,
} from '../builtins/local-auth/record-kinds.js'
import { localAuthRecordKinds } from '../builtins/local-auth/record-kinds.js'
import { announceSessionsRevoked } from './session-revocation-bus.js'

/**
 * @durable class=ledger owner=local-auth
 *   write="one row per login (password, passkey, SSO, handoff, session exchange);
 *     rewritten on every refresh / renewal (expiry slides, refresh hash rotates)
 *     and on revocation"
 *   retention="the daily reap deletes rows expired more than 7 days ago and rows
 *     revoked more than 30 days ago. A session the user keeps refreshing lives as
 *     long as it is used."
 */
export const LOGIN_SESSIONS_COLLECTION = 'login_sessions'

/**
 * @durable class=config owner=local-auth
 *   write="revoking all of a user's sessions (logout everywhere, password change or
 *     reset, user deletion) sets that user's cutoff to now"
 *   retention="none — one row per user who ever had all sessions revoked; it only
 *     ever matters for tokens minted before sessions existed, and is harmless after."
 */
export const LOGIN_SESSION_CUTOFFS_COLLECTION = 'login_session_cutoffs'

export const LOGIN_SESSIONS_COLUMNS: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'userId', type: 'TEXT' as const, notNull: true },
  { name: 'method', type: 'TEXT' as const, notNull: true },
  { name: 'refreshable', type: 'BOOLEAN' as const, notNull: true },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
  { name: 'lastUsedAt', type: 'INTEGER' as const, notNull: true },
  { name: 'expiresAt', type: 'INTEGER' as const, notNull: true },
  { name: 'revokedAt', type: 'INTEGER' as const },
  { name: 'revokedReason', type: 'TEXT' as const },
  { name: 'refreshHash', type: 'TEXT' as const },
  { name: 'previousRefreshHash', type: 'TEXT' as const },
  { name: 'rotatedAt', type: 'INTEGER' as const },
  { name: 'client', type: 'TEXT' as const },
  { name: 'ip', type: 'TEXT' as const },
  { name: 'credentialId', type: 'TEXT' as const },
]

export const LOGIN_SESSION_CUTOFFS_COLUMNS: readonly CollectionColumn[] = [
  { name: 'userId', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'notBefore', type: 'INTEGER' as const, notNull: true },
]

/** How a session began — shown on the sessions list. */
export type LoginSessionMethod =
  | 'password'
  | 'passkey'
  | 'sso'
  | 'handoff'
  | 'exchange'
  | 'device-certificate'

const METHODS: readonly LoginSessionMethod[] = [
  'password',
  'passkey',
  'sso',
  'handoff',
  'exchange',
  'device-certificate',
]

/** Why a session ended. */
export type LoginSessionRevocation =
  | 'logout'
  | 'logout-everywhere'
  | 'password-changed'
  | 'password-reset'
  | 'user-deleted'
  | 'refresh-reuse'
  | 'revoked-by-user'
  | 'revoked-by-admin'
  | 'credential-revoked'
  | 'credential-expired'

export interface LoginSessionRecord {
  readonly id: string
  readonly userId: string
  readonly method: LoginSessionMethod
  readonly refreshable: boolean
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly expiresAt: number
  readonly revokedAt: number | null
  readonly revokedReason: string | null
  readonly refreshHash: string | null
  readonly previousRefreshHash: string | null
  readonly rotatedAt: number | null
  readonly client: string | null
  readonly ip: string | null
  /** The device credential (D855) that opened this session; `null` for every other login. */
  readonly credentialId: string | null
}

/** A session as the UI sees it — no refresh hashes. */
export type LoginSessionSummary = Omit<
  LoginSessionRecord,
  'refreshHash' | 'previousRefreshHash' | 'rotatedAt'
>

export interface CreateLoginSessionInput {
  readonly userId: string
  readonly lifetimeMs: number
  readonly refreshable: boolean
  readonly method: LoginSessionMethod
  readonly client?: string
  readonly ip?: string
  /** Set by a device-certificate login; the refresh path re-checks it. */
  readonly credentialId?: string
}

export type LoginSessionCheck =
  | { readonly state: 'active'; readonly session: LoginSessionRecord }
  | { readonly state: 'unknown' | 'revoked' | 'expired' }

export type LoginSessionRefresh =
  | { readonly ok: true; readonly session: LoginSessionRecord; readonly refreshToken: string }
  | { readonly ok: false; readonly reason: 'unknown' | 'expired' | 'revoked' | 'reused' }

export const REFRESH_TOKEN_PREFIX = 'csr_'

/**
 * A rotated-out refresh token is still honoured this long: two tabs (or a
 * retry after a dropped response) may present the same token a moment apart.
 * After it, the old token is evidence of a copy and ends the session.
 */
const REFRESH_REUSE_GRACE_MS = 30_000
const EXPIRED_RETENTION_MS = 7 * 86_400_000
const REVOKED_RETENTION_MS = 30 * 86_400_000
/** Longest client label kept (a User-Agent can be huge). */
const MAX_CLIENT_LABEL = 200

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function str(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(data: Record<string, unknown>, key: string): number | null {
  const value = data[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseSession(data: Record<string, unknown>): LoginSessionRecord | null {
  const id = str(data, 'id')
  const userId = str(data, 'userId')
  const createdAt = num(data, 'createdAt')
  const lastUsedAt = num(data, 'lastUsedAt')
  const expiresAt = num(data, 'expiresAt')
  const method = METHODS.find((m) => m === data['method'])
  if (id === null || userId === null || createdAt === null || expiresAt === null) return null
  return {
    id,
    userId,
    method: method ?? 'password',
    refreshable: data['refreshable'] === true || data['refreshable'] === 1,
    createdAt,
    lastUsedAt: lastUsedAt ?? createdAt,
    expiresAt,
    revokedAt: num(data, 'revokedAt'),
    revokedReason: str(data, 'revokedReason'),
    refreshHash: str(data, 'refreshHash'),
    previousRefreshHash: str(data, 'previousRefreshHash'),
    rotatedAt: num(data, 'rotatedAt'),
    client: str(data, 'client'),
    ip: str(data, 'ip'),
    credentialId: str(data, 'credentialId'),
  }
}

export function toLoginSessionSummary(record: LoginSessionRecord): LoginSessionSummary {
  const { refreshHash: _r, previousRefreshHash: _p, rotatedAt: _t, ...summary } = record
  return summary
}

export interface LoginSessionManagerOptions {
  readonly now?: () => number
  readonly logger?: IScopedLogger
}

export interface LoginSessionRecordsDeps {
  readonly sessionsKind: RecordKindHandle<LoginSessionBody>
  readonly cutoffsKind: RecordKindHandle<LoginSessionCutoffBody>
  readonly legacyStore?: SettingsStoreClient
}

function sessionToBody(session: LoginSessionRecord): LoginSessionBody {
  const { id: _id, ...body } = session
  return body
}

export class LoginSessionManager {
  private readonly sessions = new Map<string, LoginSessionRecord>()
  /** refresh hash (current or previous) → session id */
  private readonly byRefreshHash = new Map<string, string>()
  private readonly cutoffs = new Map<string, number>()
  private readonly now: () => number
  private readonly logger: IScopedLogger | null
  private readonly sessionsKind: RecordKindHandle<LoginSessionBody> | null
  private readonly cutoffsKind: RecordKindHandle<LoginSessionCutoffBody> | null
  private readonly store: SettingsStoreClient | null

  constructor(
    deps: SettingsStoreClient | LoginSessionRecordsDeps,
    options: LoginSessionManagerOptions = {},
  ) {
    if ('sessionsKind' in deps) {
      this.sessionsKind = deps.sessionsKind
      this.cutoffsKind = deps.cutoffsKind
      this.store = deps.legacyStore ?? null
    } else {
      this.sessionsKind = null
      this.cutoffsKind = null
      this.store = deps
    }
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? null
  }

  /** Load every row into the mirror. Call once at init, before serving. */
  async load(): Promise<void> {
    const sessionsKind = this.sessionsKind
    if (sessionsKind !== null) {
      const rows = await readAllRows(sessionsKind)
      for (const row of rows) {
        const record = parseSession({ id: row.id, ...row.data })
        if (record !== null) this.remember(record)
      }
      const cutoffs = await readAllRows(this.cutoffsKind!)
      for (const row of cutoffs) {
        this.cutoffs.set(row.id, row.data.notBefore)
      }
      return
    }
    const rows = await this.store!.query.query({ collection: LOGIN_SESSIONS_COLLECTION })
    for (const row of rows) {
      const record = parseSession(row.data)
      if (record !== null) this.remember(record)
    }
    const cutoffs = await this.store!.query.query({ collection: LOGIN_SESSION_CUTOFFS_COLLECTION })
    for (const row of cutoffs) {
      const userId = str(row.data, 'userId')
      const notBefore = num(row.data, 'notBefore')
      if (userId !== null && notBefore !== null) this.cutoffs.set(userId, notBefore)
    }
  }

  async create(
    input: CreateLoginSessionInput,
  ): Promise<{ readonly session: LoginSessionRecord; readonly refreshToken: string | null }> {
    const at = this.now()
    const refreshToken = input.refreshable ? this.newRefreshToken() : null
    const session: LoginSessionRecord = {
      id: crypto.randomUUID(),
      userId: input.userId,
      method: input.method,
      refreshable: input.refreshable,
      createdAt: at,
      lastUsedAt: at,
      expiresAt: at + input.lifetimeMs,
      revokedAt: null,
      revokedReason: null,
      refreshHash: refreshToken === null ? null : hashToken(refreshToken),
      previousRefreshHash: null,
      rotatedAt: null,
      client: input.client === undefined ? null : input.client.slice(0, MAX_CLIENT_LABEL),
      ip: input.ip ?? null,
      credentialId: input.credentialId ?? null,
    }
    const sessionsKind = this.sessionsKind
    if (sessionsKind !== null) {
      const parsed = localAuthRecordKinds['login-sessions'].schema.safeParse(sessionToBody(session))
      if (!parsed.success) throw new Error(parsed.error.message)
      await sessionsKind.put({
        id: session.id,
        at: session.createdAt,
        expiresAt: session.expiresAt,
        data: parsed.data,
      })
    } else {
      await this.store!.insert.mutate({
        collection: LOGIN_SESSIONS_COLLECTION,
        record: { id: session.id, data: { ...session } },
      })
    }
    this.remember(session)
    return { session, refreshToken }
  }

  /** Is `sessionId` a live session right now? Synchronous: the hub asks on every request. */
  check(sessionId: string): LoginSessionCheck {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return { state: 'unknown' }
    if (session.revokedAt !== null) return { state: 'revoked' }
    if (session.expiresAt <= this.now()) return { state: 'expired' }
    return { state: 'active', session }
  }

  /** Epoch ms before which a pre-session (no `sid`) token of `userId` is refused; 0 = none. */
  legacyCutoff(userId: string): number {
    return this.cutoffs.get(userId) ?? 0
  }

  /**
   * The session a refresh token belongs to, WITHOUT rotating it - so the
   * refresh path can judge the session (its device credential) before it
   * spends the token. `null` when the token names no session.
   */
  peekByRefreshToken(refreshToken: string): LoginSessionRecord | null {
    if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return null
    const sessionId = this.byRefreshHash.get(hashToken(refreshToken))
    return sessionId === undefined ? null : (this.sessions.get(sessionId) ?? null)
  }

  /** Swap a refresh token for a rotated one, sliding the session's expiry to now + `lifetimeMs`. */
  async refresh(refreshToken: string, lifetimeMs: number): Promise<LoginSessionRefresh> {
    if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return { ok: false, reason: 'unknown' }
    const presented = hashToken(refreshToken)
    const sessionId = this.byRefreshHash.get(presented)
    const session = sessionId === undefined ? undefined : this.sessions.get(sessionId)
    if (session === undefined) return { ok: false, reason: 'unknown' }
    if (session.revokedAt !== null) return { ok: false, reason: 'revoked' }
    const at = this.now()
    if (session.expiresAt <= at) return { ok: false, reason: 'expired' }
    if (presented !== session.refreshHash) {
      const inGrace =
        presented === session.previousRefreshHash &&
        session.rotatedAt !== null &&
        at - session.rotatedAt <= REFRESH_REUSE_GRACE_MS
      if (!inGrace) {
        await this.revoke(session.id, 'refresh-reuse')
        this.logger?.warn('A rotated-out refresh token was presented — session revoked', {
          meta: { sessionId: session.id, userId: session.userId },
        })
        return { ok: false, reason: 'reused' }
      }
    }
    const next = this.newRefreshToken()
    const updated: LoginSessionRecord = {
      ...session,
      lastUsedAt: at,
      expiresAt: at + lifetimeMs,
      previousRefreshHash: session.refreshHash,
      refreshHash: hashToken(next),
      rotatedAt: at,
    }
    this.replace(session, updated)
    await this.persist(updated)
    return { ok: true, session: updated, refreshToken: next }
  }

  /** Renew an active session (legacy client): slide its expiry. `null` when it is not active. */
  async extend(sessionId: string, lifetimeMs: number): Promise<LoginSessionRecord | null> {
    const check = this.check(sessionId)
    if (check.state !== 'active') return null
    const at = this.now()
    const updated: LoginSessionRecord = {
      ...check.session,
      lastUsedAt: at,
      expiresAt: at + lifetimeMs,
    }
    this.replace(check.session, updated)
    await this.persist(updated)
    return updated
  }

  /** End one session. `false` when it was unknown or already ended. */
  async revoke(sessionId: string, reason: LoginSessionRevocation): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.revokedAt !== null) return false
    const updated: LoginSessionRecord = { ...session, revokedAt: this.now(), revokedReason: reason }
    this.replace(session, updated)
    this.announce([updated.id], session.userId, false, null, reason)
    await this.persist(updated)
    return true
  }

  /**
   * End every live session of `userId` except `exceptSessionId`, and move the
   * user's legacy cutoff to now (pre-session tokens die too). Returns how many
   * sessions ended.
   */
  async revokeAllForUser(
    userId: string,
    options: { readonly exceptSessionId?: string; readonly reason: LoginSessionRevocation },
  ): Promise<number> {
    const at = this.now()
    this.cutoffs.set(userId, at)
    const ended: LoginSessionRecord[] = []
    for (const session of this.sessions.values()) {
      if (session.userId !== userId || session.revokedAt !== null) continue
      if (session.id === options.exceptSessionId) continue
      const updated: LoginSessionRecord = {
        ...session,
        revokedAt: at,
        revokedReason: options.reason,
      }
      this.replace(session, updated)
      ended.push(updated)
    }
    this.announce(
      ended.map((s) => s.id),
      userId,
      true,
      options.exceptSessionId ?? null,
      options.reason,
    )
    await this.persistCutoff(userId, at)
    for (const session of ended) await this.persist(session)
    return ended.length
  }

  /** End every live session opened by device credential `credentialId`. Returns how many. */
  async revokeByCredential(
    credentialId: string,
    reason: LoginSessionRevocation = 'credential-revoked',
  ): Promise<number> {
    const at = this.now()
    const ended: LoginSessionRecord[] = []
    for (const session of this.sessions.values()) {
      if (session.credentialId !== credentialId || session.revokedAt !== null) continue
      const updated: LoginSessionRecord = { ...session, revokedAt: at, revokedReason: reason }
      this.replace(session, updated)
      ended.push(updated)
    }
    this.announce(
      ended.map((s) => s.id),
      null,
      false,
      null,
      reason,
    )
    for (const session of ended) await this.persist(session)
    return ended.length
  }

  /** `userId`'s live sessions, newest first. */
  listForUser(userId: string): readonly LoginSessionSummary[] {
    return this.listActive().filter((s) => s.userId === userId)
  }

  /** Every live session, newest first. */
  listActive(): readonly LoginSessionSummary[] {
    const at = this.now()
    return [...this.sessions.values()]
      .filter((s) => s.revokedAt === null && s.expiresAt > at)
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .map(toLoginSessionSummary)
  }

  /** Delete rows expired more than 7 days ago or revoked more than 30. Returns how many. */
  async reap(): Promise<number> {
    const at = this.now()
    const dead = [...this.sessions.values()].filter(
      (s) =>
        (s.revokedAt !== null && at - s.revokedAt > REVOKED_RETENTION_MS) ||
        (s.revokedAt === null && at - s.expiresAt > EXPIRED_RETENTION_MS),
    )
    for (const session of dead) {
      this.forget(session)
      const sessionsKind = this.sessionsKind
      if (sessionsKind !== null) await sessionsKind.delete(session.id)
      else
        await this.store!.delete.mutate({ collection: LOGIN_SESSIONS_COLLECTION, key: session.id })
    }
    return dead.length
  }

  /** Tell the hub which sessions just ended — right after the mirror, before the store write. */
  private announce(
    sessionIds: readonly string[],
    userId: string | null,
    allOfUser: boolean,
    exceptSessionId: string | null,
    reason: LoginSessionRevocation,
  ): void {
    announceSessionsRevoked({ sessionIds, userId, allOfUser, exceptSessionId, reason }, (error) =>
      this.logger?.error('A session-revocation listener threw — the revoke stands', {
        meta: { error: error instanceof Error ? error.message : String(error) },
      }),
    )
  }

  private newRefreshToken(): string {
    return `${REFRESH_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`
  }

  private remember(session: LoginSessionRecord): void {
    this.sessions.set(session.id, session)
    if (session.refreshHash !== null) this.byRefreshHash.set(session.refreshHash, session.id)
    if (session.previousRefreshHash !== null) {
      this.byRefreshHash.set(session.previousRefreshHash, session.id)
    }
  }

  private forget(session: LoginSessionRecord): void {
    this.sessions.delete(session.id)
    if (session.refreshHash !== null) this.byRefreshHash.delete(session.refreshHash)
    if (session.previousRefreshHash !== null) this.byRefreshHash.delete(session.previousRefreshHash)
  }

  private replace(previous: LoginSessionRecord, next: LoginSessionRecord): void {
    this.forget(previous)
    this.remember(next)
  }

  private async persist(session: LoginSessionRecord): Promise<void> {
    try {
      const sessionsKind = this.sessionsKind
      if (sessionsKind !== null) {
        const parsed = localAuthRecordKinds['login-sessions'].schema.safeParse(
          sessionToBody(session),
        )
        if (!parsed.success) throw new Error(parsed.error.message)
        await sessionsKind.put({
          id: session.id,
          at: session.createdAt,
          expiresAt: session.expiresAt,
          data: parsed.data,
        })
      } else {
        await this.store!.update.mutate({
          collection: LOGIN_SESSIONS_COLLECTION,
          id: session.id,
          data: { ...session },
        })
      }
    } catch (error: unknown) {
      // The mirror already holds the change (a revocation applies NOW); only
      // its survival across a restart is at risk, and that is worth saying.
      this.logger?.error('Login session write failed — the change holds until restart', {
        meta: {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private async persistCutoff(userId: string, notBefore: number): Promise<void> {
    try {
      const cutoffsKind = this.cutoffsKind
      if (cutoffsKind !== null) {
        const parsed = localAuthRecordKinds['login-session-cutoffs'].schema.safeParse({ notBefore })
        if (!parsed.success) throw new Error(parsed.error.message)
        await cutoffsKind.put({ id: userId, data: parsed.data })
      } else {
        await this.store!.delete.mutate({
          collection: LOGIN_SESSION_CUTOFFS_COLLECTION,
          key: userId,
        })
        await this.store!.insert.mutate({
          collection: LOGIN_SESSION_CUTOFFS_COLLECTION,
          record: { id: userId, data: { userId, notBefore } },
        })
      }
    } catch (error: unknown) {
      this.logger?.error('Login session cutoff write failed — it holds until restart', {
        meta: { userId, error: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}
