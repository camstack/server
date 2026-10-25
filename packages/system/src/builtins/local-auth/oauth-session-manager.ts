import * as crypto from 'node:crypto'
import type { RecordKindHandle, TokenScope } from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import type { OauthSessionBody } from './record-kinds.js'
import { localAuthRecordKinds } from './record-kinds.js'

export interface OauthSession {
  readonly id: string
  readonly userId: string
  readonly username: string
  readonly integrationId: string
  readonly scopes: TokenScope[]
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly revokedAt: number | null
}

interface CreateInput {
  readonly userId: string
  readonly username: string
  readonly integrationId: string
  readonly scopes: TokenScope[]
}

function sessionToBody(session: OauthSession): OauthSessionBody {
  return {
    userId: session.userId,
    username: session.username,
    integrationId: session.integrationId,
    scopes: session.scopes,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    revokedAt: session.revokedAt,
  }
}

function rowToSession(id: string, body: OauthSessionBody): OauthSession {
  return {
    id,
    userId: body.userId,
    username: body.username,
    integrationId: body.integrationId,
    scopes: body.scopes,
    createdAt: body.createdAt,
    lastUsedAt: body.lastUsedAt,
    revokedAt: typeof body.revokedAt === 'number' ? body.revokedAt : null,
  }
}

export interface OauthSessionRecordsDeps {
  readonly oauthSessionsKind: RecordKindHandle<OauthSessionBody>
}

/**
 * The OAuth account links (one row per redeemed code), kept in local-auth's
 * `oauth-sessions` records kind (D881, D902). There is no table: the
 * `oauth_sessions` collection and its settings-store path are gone.
 */
export class OauthSessionManager {
  private readonly kind: RecordKindHandle<OauthSessionBody>

  constructor(deps: OauthSessionRecordsDeps) {
    this.kind = deps.oauthSessionsKind
  }

  private async write(session: OauthSession): Promise<void> {
    const parsed = localAuthRecordKinds['oauth-sessions'].schema.safeParse(sessionToBody(session))
    if (!parsed.success) throw new Error(parsed.error.message)
    await this.kind.put({ id: session.id, data: parsed.data })
  }

  async create(input: CreateInput): Promise<OauthSession> {
    const now = Date.now()
    const session: OauthSession = {
      id: crypto.randomUUID(),
      userId: input.userId,
      username: input.username,
      integrationId: input.integrationId,
      scopes: input.scopes.map((s) => ({ ...s })),
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null,
    }
    await this.write(session)
    return session
  }

  async list(): Promise<OauthSession[]> {
    return (await readAllRows(this.kind)).map((row) => rowToSession(row.id, row.data))
  }

  async getById(id: string): Promise<OauthSession | null> {
    const row = await this.kind.get(id)
    return row === null ? null : rowToSession(row.id, row.data)
  }

  async markRevoked(id: string): Promise<boolean> {
    const existing = await this.getById(id)
    if (existing === null) return false
    if (existing.revokedAt !== null) return true
    await this.write({ ...existing, revokedAt: Date.now() })
    return true
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.getById(id)
    if (existing === null) return false
    await this.kind.delete(id)
    return true
  }

  /**
   * Delete the sessions revoked at or before `horizonMs`. An active session
   * (`revokedAt` null) is never matched: it has no lifetime of its own, which
   * is why this is the owner's sweep and not an engine TTL.
   */
  async reapRevoked(horizonMs: number): Promise<number> {
    return this.kind.deleteWhere({
      where: { revokedAt: { gte: 1, lte: horizonMs } },
    })
  }

  async touch(id: string): Promise<void> {
    const existing = await this.getById(id)
    if (existing === null) return
    const parsed = localAuthRecordKinds['oauth-sessions'].schema.safeParse(
      sessionToBody({ ...existing, lastUsedAt: Date.now() }),
    )
    if (!parsed.success) return
    await this.kind.put({ id, data: parsed.data })
  }
}
