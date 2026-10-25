/**
 * External sign-in identities linked to local users (D782).
 */
import type { RecordKindHandle, SettingsStoreClient } from '@camstack/types'
import { readAllRows } from '../records/read-all-rows.js'
import type { ExternalIdentityBody } from '../builtins/local-auth/record-kinds.js'
import { localAuthRecordKinds } from '../builtins/local-auth/record-kinds.js'
import { USER_EXTERNAL_IDENTITIES_COLLECTION } from '../builtins/local-auth/auth-schema.js'

export interface ExternalIdentityRecord {
  readonly provider: string
  readonly subject: string
  readonly issuer: string
  readonly userId: string
  readonly label?: string
  readonly linkedAt: number
}

export interface ExternalIdentityKey {
  readonly provider: string
  readonly subject: string
}

export class ExternalIdentityConflictError extends Error {
  constructor() {
    super('This sign-in account is already linked to another CamStack user')
    this.name = 'ExternalIdentityConflictError'
  }
}

function rowId(key: ExternalIdentityKey): string {
  return JSON.stringify([key.provider, key.subject])
}

function parseRow(data: Record<string, unknown>): ExternalIdentityRecord | null {
  const { provider, subject, issuer, userId, label, linkedAt } = data
  if (typeof provider !== 'string' || typeof subject !== 'string') return null
  if (typeof issuer !== 'string') return null
  if (typeof userId !== 'string' || typeof linkedAt !== 'number') return null
  return {
    provider,
    subject,
    issuer,
    userId,
    linkedAt,
    ...(typeof label === 'string' && label.length > 0 ? { label } : {}),
  }
}

function recordToBody(record: ExternalIdentityRecord): ExternalIdentityBody {
  return {
    provider: record.provider,
    subject: record.subject,
    issuer: record.issuer,
    userId: record.userId,
    label: record.label ?? null,
    linkedAt: record.linkedAt,
  }
}

export interface ExternalIdentityRecordsDeps {
  readonly identitiesKind: RecordKindHandle<ExternalIdentityBody>
  readonly legacyStore?: SettingsStoreClient
}

export class ExternalIdentityManager {
  private readonly kind: RecordKindHandle<ExternalIdentityBody> | null
  private readonly store: SettingsStoreClient | null

  constructor(deps: SettingsStoreClient | ExternalIdentityRecordsDeps) {
    if ('identitiesKind' in deps) {
      this.kind = deps.identitiesKind
      this.store = deps.legacyStore ?? null
    } else {
      this.kind = null
      this.store = deps
    }
  }

  private async find(key: ExternalIdentityKey): Promise<ExternalIdentityRecord | null> {
    const kind = this.kind
    if (kind !== null) {
      const page = await kind.query({
        where: { provider: key.provider, subject: key.subject },
        limit: 1,
      })
      const row = page.records[0]
      return row === undefined ? null : parseRow({ ...row.data })
    }
    const rows = await this.store!.query.query({
      collection: USER_EXTERNAL_IDENTITIES_COLLECTION,
      filter: { where: { provider: key.provider, subject: key.subject } },
    })
    for (const row of rows) {
      const parsed = parseRow(row.data as Record<string, unknown>)
      if (parsed !== null) return parsed
    }
    return null
  }

  async findLink(provider: string, subject: string): Promise<ExternalIdentityRecord | null> {
    return this.find({ provider, subject })
  }

  async findUser(provider: string, subject: string): Promise<string | null> {
    return (await this.find({ provider, subject }))?.userId ?? null
  }

  async listForUser(userId: string): Promise<readonly ExternalIdentityRecord[]> {
    const kind = this.kind
    if (kind !== null) {
      const rows = await readAllRows(kind, { where: { userId } })
      return rows.flatMap((row) => {
        const parsed = parseRow(row.data as Record<string, unknown>)
        return parsed === null ? [] : [parsed]
      })
    }
    const rows = await this.store!.query.query({
      collection: USER_EXTERNAL_IDENTITIES_COLLECTION,
      filter: { where: { userId } },
    })
    return rows.flatMap((row) => {
      const parsed = parseRow(row.data as Record<string, unknown>)
      return parsed === null ? [] : [parsed]
    })
  }

  async link(
    input: ExternalIdentityKey & { userId: string; issuer: string; label?: string },
  ): Promise<void> {
    const existing = await this.find(input)
    if (existing !== null) {
      if (existing.userId === input.userId) return
      throw new ExternalIdentityConflictError()
    }
    const record: ExternalIdentityRecord = {
      provider: input.provider,
      subject: input.subject,
      issuer: input.issuer,
      userId: input.userId,
      linkedAt: Date.now(),
      ...(input.label !== undefined && input.label.length > 0 ? { label: input.label } : {}),
    }
    const id = rowId(input)
    const kind = this.kind
    try {
      if (kind !== null) {
        const parsed = localAuthRecordKinds['user-external-identities'].schema.safeParse(
          recordToBody(record),
        )
        if (!parsed.success) throw new Error(parsed.error.message)
        await kind.put({ id, data: parsed.data })
      } else {
        await this.store!.insert.mutate({
          collection: USER_EXTERNAL_IDENTITIES_COLLECTION,
          record: { id, data: { ...record } },
        })
      }
    } catch (err: unknown) {
      const winner = await this.find(input)
      if (winner?.userId === input.userId) return
      if (winner !== null) throw new ExternalIdentityConflictError()
      throw err
    }
  }

  async unlink(input: ExternalIdentityKey & { userId: string }): Promise<boolean> {
    const existing = await this.find(input)
    if (existing === null || existing.userId !== input.userId) return false
    const id = rowId(input)
    const kind = this.kind
    if (kind !== null) {
      await kind.delete(id)
      return true
    }
    await this.store!.delete.mutate({
      collection: USER_EXTERNAL_IDENTITIES_COLLECTION,
      key: id,
    })
    return true
  }

  async removeAllForUser(userId: string): Promise<number> {
    const links = await this.listForUser(userId)
    const kind = this.kind
    for (const link of links) {
      const id = rowId(link)
      if (kind !== null) await kind.delete(id)
      else
        await this.store!.delete.mutate({
          collection: USER_EXTERNAL_IDENTITIES_COLLECTION,
          key: id,
        })
    }
    return links.length
  }
}
