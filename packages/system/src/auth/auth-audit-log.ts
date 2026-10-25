/**
 * The authentication audit trail: what an operator must be able to answer
 * after the fact — "who skipped 2FA from the LAN, and from where?", "which
 * admin token ran this, and when?".
 *
 * One row per event, kept 90 days. Writing never throws: an audit row that
 * cannot be stored is logged loudly instead, and never blocks the action
 * (a login must not fail because the audit table is busy).
 */
import * as crypto from 'node:crypto'
import type {
  CollectionColumn,
  IScopedLogger,
  RecordKindHandle,
  SettingsStoreClient,
} from '@camstack/types'
import { readAllRows } from '../records/read-all-rows.js'
import type { AuthAuditBody } from '../builtins/local-auth/record-kinds.js'
import { localAuthRecordKinds } from '../builtins/local-auth/record-kinds.js'

/**
 * @durable class=ledger owner=local-auth
 *   write="one row per audited auth event: a second factor skipped from a trusted
 *     network, an admin token created / used / revoked, a bulk revoke of credentials"
 *   retention="the daily reap deletes rows older than 90 days"
 */
export const AUTH_AUDIT_COLLECTION = 'auth_audit'

export const AUTH_AUDIT_COLUMNS: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'at', type: 'INTEGER' as const, notNull: true },
  { name: 'action', type: 'TEXT' as const, notNull: true },
  { name: 'userId', type: 'TEXT' as const },
  { name: 'ip', type: 'TEXT' as const },
  { name: 'detail', type: 'TEXT' as const },
]

export const AUTH_AUDIT_ACTIONS = [
  'second-factor-skipped',
  'admin-token-created',
  'admin-token-used',
  'admin-token-revoked',
  'credentials-revoked',
  'agent-addon-update',
  'agent-addon-update-refused',
  'device-credential-enrolled',
  'device-credential-revoked',
  'device-credential-login',
  'device-credential-login-refused',
  'token-minted',
  'token-revoked',
] as const

export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[number]

export interface AuthAuditEvent {
  readonly action: AuthAuditAction
  /** The user the event is about (the one signing in; the token's owner). */
  readonly userId?: string
  /** The real client address, when there was a request. */
  readonly ip?: string
  /** Short, non-secret context: the method, the token's name and prefix, the path. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>
}

export interface AuthAuditRecord extends AuthAuditEvent {
  readonly id: string
  readonly at: number
}

const RETENTION_MS = 90 * 86_400_000
const MAX_LIST = 500

function parseRecord(data: Record<string, unknown>): AuthAuditRecord | null {
  const id = data['id']
  const rawAt = data['at']
  const at =
    typeof rawAt === 'number'
      ? rawAt
      : typeof rawAt === 'string' && rawAt.trim() !== '' && Number.isFinite(Number(rawAt))
        ? Number(rawAt)
        : null
  const action = data['action']
  const known = AUTH_AUDIT_ACTIONS.find((a) => a === action)
  if (typeof id !== 'string' || at === null || known === undefined) return null
  let detail: Record<string, string | number | boolean> | undefined
  if (typeof data['detail'] === 'string') {
    try {
      const parsed: unknown = JSON.parse(data['detail'])
      if (parsed !== null && typeof parsed === 'object') {
        detail = Object.fromEntries(
          Object.entries(parsed).filter(
            (e): e is [string, string | number | boolean] =>
              typeof e[1] === 'string' || typeof e[1] === 'number' || typeof e[1] === 'boolean',
          ),
        )
      }
    } catch {
      detail = undefined
    }
  }
  return {
    id,
    at,
    action: known,
    ...(typeof data['userId'] === 'string' ? { userId: data['userId'] } : {}),
    ...(typeof data['ip'] === 'string' ? { ip: data['ip'] } : {}),
    ...(detail !== undefined ? { detail } : {}),
  }
}

export interface AuthAuditRecordsDeps {
  readonly authAuditKind: RecordKindHandle<AuthAuditBody>
  readonly legacyStore?: SettingsStoreClient
}

export class AuthAuditLog {
  private readonly kind: RecordKindHandle<AuthAuditBody> | null
  private readonly store: SettingsStoreClient | null

  constructor(
    deps: SettingsStoreClient | AuthAuditRecordsDeps,
    private readonly logger: IScopedLogger | null = null,
    private readonly now: () => number = Date.now,
  ) {
    if ('authAuditKind' in deps) {
      this.kind = deps.authAuditKind
      this.store = deps.legacyStore ?? null
    } else {
      this.kind = null
      this.store = deps
    }
  }

  /** Record `event`. Never throws. */
  async record(event: AuthAuditEvent): Promise<void> {
    const row = {
      id: crypto.randomUUID(),
      at: this.now(),
      action: event.action,
      userId: event.userId ?? null,
      ip: event.ip ?? null,
      detail: event.detail === undefined ? null : JSON.stringify(event.detail),
    }
    // The log line is the audit's second copy — and the only one if the row fails.
    this.logger?.info(`auth audit: ${event.action}`, {
      meta: { userId: event.userId, ip: event.ip, ...event.detail },
    })
    try {
      const kind = this.kind
      if (kind !== null) {
        const body: AuthAuditBody = {
          action: event.action,
          userId: event.userId,
          ip: event.ip,
          detail: row.detail ?? undefined,
        }
        const parsed = localAuthRecordKinds['auth-audit'].schema.safeParse(body)
        if (!parsed.success) throw new Error(parsed.error.message)
        await kind.put({ id: row.id, at: row.at, data: parsed.data })
      } else {
        await this.store!.insert.mutate({
          collection: AUTH_AUDIT_COLLECTION,
          record: { id: row.id, data: row },
        })
      }
    } catch (error: unknown) {
      this.logger?.error('auth audit row not written', {
        meta: {
          action: event.action,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /** Newest first, at most `limit` (≤ 500), optionally one user's. */
  async list(
    input: { readonly limit?: number; readonly userId?: string } = {},
  ): Promise<readonly AuthAuditRecord[]> {
    const limit = Math.min(MAX_LIST, Math.max(1, input.limit ?? 100))
    const kind = this.kind
    if (kind !== null) {
      const page = await kind.query({
        ...(input.userId !== undefined ? { where: { userId: input.userId } } : {}),
        order: 'at',
        desc: true,
        limit,
      })
      return page.records
        .map((row) =>
          parseRecord({
            id: row.id,
            at: row.at,
            action: row.data.action,
            userId: row.data.userId,
            ip: row.data.ip,
            detail: row.data.detail,
          }),
        )
        .filter((r): r is AuthAuditRecord => r !== null)
    }
    const rows = await this.store!.query.query({
      collection: AUTH_AUDIT_COLLECTION,
      ...(input.userId !== undefined ? { filter: { where: { userId: input.userId } } } : {}),
    })
    return rows
      .map((row) => parseRecord(row.data))
      .filter((r): r is AuthAuditRecord => r !== null)
      .toSorted((a, b) => b.at - a.at)
      .slice(0, limit)
  }

  /** Delete rows older than 90 days. Returns how many. */
  async reap(): Promise<number> {
    const horizon = this.now() - RETENTION_MS
    const kind = this.kind
    if (kind !== null) {
      const rows = await readAllRows(kind, { atTo: horizon - 1 })
      for (const row of rows) await kind.delete(row.id)
      return rows.length
    }
    const rows = await this.store!.query.query({ collection: AUTH_AUDIT_COLLECTION })
    let deleted = 0
    for (const row of rows) {
      const at = row.data['at']
      if (typeof at === 'number' && at < horizon) {
        await this.store!.delete.mutate({ collection: AUTH_AUDIT_COLLECTION, key: String(row.id) })
        deleted++
      }
    }
    return deleted
  }
}
