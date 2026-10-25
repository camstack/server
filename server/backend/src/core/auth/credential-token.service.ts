/**
 * The unified token store (D892).
 *
 * A token is a signed JWT `{ kind: 'credential', sub, jti, scopes }` and one
 * row here: the SHA-256 of its `jti`, its label, its scopes, its ONE expiry,
 * when it was last used and whether it was revoked. The verifier reads the
 * row by `jti` on every request — that is what makes revocation immediate and
 * the expiry slidable (a share link's `extend`). The raw token leaves this
 * service exactly once, in `mint`'s answer; neither it nor the `jti` is ever
 * stored or logged.
 *
 * Rows live in the `core-auth` records (`credential-tokens`), declared by the
 * hub beside the share links. Until that binding happens the store refuses to
 * mint and authenticates nothing — it never falls back to another table.
 */
import * as crypto from 'node:crypto'
import type { CredentialScope, IScopedLogger, RecordKindHandle } from '@camstack/types'
import { CREDENTIAL_TOKEN_KIND, userError } from '@camstack/types'
import type { VerifiedTokenRow, VerifierTokenRows } from '../../auth/credential-verifier.js'
import { coreAuthRecordKinds, type CredentialTokenBody } from './record-kinds.js'

/** What a token row says about itself — never the hash. */
export interface CredentialTokenRecord {
  readonly id: string
  readonly subjectId: string
  readonly createdBy: string
  readonly label: string
  readonly scopes: readonly CredentialScope[]
  readonly createdAt: number
  /** Epoch ms, or `null` for a never-expiring share link. */
  readonly expiresAt: number | null
  readonly lastUsedAt: number | null
  readonly revokedAt: number | null
}

export interface MintCredentialTokenInput {
  readonly subjectId: string
  readonly createdBy: string
  readonly label: string
  readonly scopes: readonly CredentialScope[]
  readonly expiresAt: number | null
}

export interface CredentialTokenSigner {
  signCredentialToken(claims: {
    readonly kind: typeof CREDENTIAL_TOKEN_KIND
    readonly sub: string
    readonly jti: string
    readonly scopes: CredentialScope[]
  }): string
}

const TOUCH_EVERY_MS = 60_000
const DEAD_RETENTION_MS = 30 * 86_400_000
const LABEL_MAX = 80
const PAGE = 1000
const MAX_PAGES = 100

function hashJti(jti: string): string {
  return crypto.createHash('sha256').update(jti).digest('hex')
}

/** Constant-time equality of two hex digests. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function toRecord(id: string, body: CredentialTokenBody): CredentialTokenRecord {
  return {
    id,
    subjectId: body.subjectId,
    createdBy: body.createdBy,
    label: body.label,
    scopes: body.scopes,
    createdAt: body.createdAt,
    expiresAt: body.expiresAt,
    lastUsedAt: body.lastUsedAt ?? null,
    revokedAt: body.revokedAt ?? null,
  }
}

export class CredentialTokenService implements VerifierTokenRows {
  private resolveKind: () => RecordKindHandle<CredentialTokenBody> | null = () => null

  constructor(
    private readonly signer: CredentialTokenSigner,
    private readonly logger: IScopedLogger | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Hub wiring after `records.forOwner('core-auth').declare(...)`. */
  bindKind(resolver: () => RecordKindHandle<CredentialTokenBody> | null): void {
    this.resolveKind = resolver
  }

  private kind(): RecordKindHandle<CredentialTokenBody> {
    const kind = this.resolveKind()
    if (kind === null) {
      throw userError('auth.tokens-unavailable', undefined, 'Tokens are not available yet')
    }
    return kind
  }

  /** Issue a token. The raw token is in this answer only. */
  async mint(
    input: MintCredentialTokenInput,
  ): Promise<{ readonly token: string; readonly record: CredentialTokenRecord }> {
    const label = input.label.trim().slice(0, LABEL_MAX)
    if (label.length === 0) {
      throw userError('auth.token-label-required', undefined, 'A token needs a name')
    }
    const at = this.now()
    if (input.expiresAt !== null && input.expiresAt <= at) {
      throw userError('auth.token-expiry-past', undefined, 'A token must expire in the future')
    }
    const jti = crypto.randomBytes(32).toString('base64url')
    const id = crypto.randomUUID()
    const body: CredentialTokenBody = {
      subjectId: input.subjectId,
      createdBy: input.createdBy,
      label,
      jtiHash: hashJti(jti),
      scopes: [...input.scopes],
      createdAt: at,
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    }
    const parsed = coreAuthRecordKinds['credential-tokens'].schema.safeParse(body)
    if (!parsed.success) throw new Error(parsed.error.message)
    const kind = this.kind()
    const token = this.signer.signCredentialToken({
      kind: CREDENTIAL_TOKEN_KIND,
      sub: input.subjectId,
      jti,
      scopes: [...input.scopes],
    })
    await kind.put({
      id,
      ...(body.expiresAt !== null ? { expiresAt: body.expiresAt } : {}),
      data: parsed.data,
    })
    this.logger?.info('Token minted', {
      meta: { tokenId: id, subjectId: input.subjectId, label, expiresAt: input.expiresAt },
    })
    return { token, record: toRecord(id, parsed.data) }
  }

  /** The live row behind `jti`: unknown, revoked and expired answer `null`. */
  async lookupLive(jti: string): Promise<VerifiedTokenRow | null> {
    const kind = this.resolveKind()
    if (kind === null) return null
    const digest = hashJti(jti)
    const page = await kind.query({ where: { jtiHash: digest }, limit: 1 })
    const row = page.records[0]
    if (row === undefined || !sameDigest(row.data.jtiHash, digest)) return null
    const at = this.now()
    if (row.data.revokedAt !== null && row.data.revokedAt !== undefined) return null
    if (row.data.expiresAt !== null && row.data.expiresAt <= at) return null
    const lastUsedAt = row.data.lastUsedAt ?? null
    if (lastUsedAt === null || at - lastUsedAt > TOUCH_EVERY_MS) {
      // ONLY `lastUsedAt`, merged into the row as it is when the write lands.
      // Writing back the row read above (un-awaited) could land after a
      // revoke / an expiry move and undo it (security review 2026-10-21).
      void kind.patch(row.id, { lastUsedAt: at }).catch(() => {})
    }
    return {
      id: row.id,
      subjectId: row.data.subjectId,
      label: row.data.label,
      scopes: row.data.scopes,
    }
  }

  async get(id: string): Promise<CredentialTokenRecord | null> {
    const row = await this.kind().get(id)
    return row === null ? null : toRecord(row.id, row.data)
  }

  /** Every row not yet reaped, newest first; `subjectId` narrows to one user's. */
  async list(subjectId?: string): Promise<readonly CredentialTokenRecord[]> {
    const kind = this.resolveKind()
    if (kind === null) return []
    const out: CredentialTokenRecord[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = await kind.query({
        ...(subjectId === undefined ? {} : { where: { subjectId } }),
        limit: PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      })
      out.push(...answer.records.map((row) => toRecord(row.id, row.data)))
      if (answer.nextCursor === null) return out.toSorted((a, b) => b.createdAt - a.createdAt)
      cursor = answer.nextCursor
    }
    throw new Error('credential-tokens: row count exceeds pagination bound')
  }

  /** Revoke one token now. `false` when unknown or already revoked. */
  async revoke(id: string): Promise<boolean> {
    const row = await this.kind().get(id)
    if (row === null || (row.data.revokedAt !== null && row.data.revokedAt !== undefined)) {
      return false
    }
    await this.kind().patch(id, { revokedAt: this.now() })
    this.logger?.info('Token revoked', { meta: { tokenId: id, subjectId: row.data.subjectId } })
    return true
  }

  /** Move a live token's expiry (`null`: never). `null` when not live. */
  async setExpiry(id: string, expiresAt: number | null): Promise<CredentialTokenRecord | null> {
    const row = await this.kind().get(id)
    if (row === null) return null
    const at = this.now()
    const dead =
      (row.data.revokedAt !== null && row.data.revokedAt !== undefined) ||
      (row.data.expiresAt !== null && row.data.expiresAt <= at)
    if (dead || (expiresAt !== null && expiresAt <= at)) return null
    await this.kind().patch(id, { expiresAt }, { expiresAt })
    return toRecord(id, { ...row.data, expiresAt })
  }

  /** Revoke every live token of `subjectId` (the user was deleted). */
  async revokeAllFor(subjectId: string): Promise<number> {
    let revoked = 0
    for (const token of await this.list(subjectId)) {
      if (token.revokedAt === null && (await this.revoke(token.id))) revoked += 1
    }
    return revoked
  }

  /** Delete rows expired or revoked more than 30 days ago. */
  async reap(): Promise<number> {
    const horizon = this.now() - DEAD_RETENTION_MS
    let deleted = 0
    for (const token of await this.list()) {
      const deadAt = token.revokedAt ?? token.expiresAt
      if (deadAt !== null && deadAt < horizon) {
        await this.kind().delete(token.id)
        deleted += 1
      }
    }
    return deleted
  }
}
