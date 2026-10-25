/**
 * Alert persistence over the `alerts` record kind (phase 4) or legacy collection.
 */
import type { Alert, RecordKindHandle, RecordsAccess, SettingsStoreClient } from '@camstack/types'
import { AlertSchema } from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import { alertsRecordKind, ALERTS_COLLECTION, type AlertBody } from './record-kinds.js'

export { ALERTS_COLLECTION } from './record-kinds.js'

export type AlertRecord = { readonly id: string; readonly data: Record<string, unknown> }

function toRecord(row: { readonly id: string; readonly data: AlertBody }): AlertRecord {
  return { id: row.id, data: row.data as Record<string, unknown> }
}

function toRecordFromLegacy(row: {
  readonly id: string
  readonly data: Record<string, unknown>
}): AlertRecord {
  return { id: row.id, data: row.data }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacyGetData(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  if ('data' in value) {
    const data = value.data
    return isRecord(data) ? data : null
  }
  return value
}

export class AlertStore {
  constructor(
    private readonly kind: RecordKindHandle<AlertBody> | null,
    private readonly legacyStore: SettingsStoreClient | null,
  ) {}

  static of(records: Pick<RecordsAccess, 'kind'>): AlertStore {
    return new AlertStore(records.kind(alertsRecordKind), null)
  }

  static legacy(store: SettingsStoreClient): AlertStore {
    return new AlertStore(null, store)
  }

  private async legacyRows(): Promise<readonly AlertRecord[]> {
    const store = this.legacyStore
    if (store === null) return []
    const rows = await store.query.query({ collection: ALERTS_COLLECTION, filter: {} })
    return rows.map((row) => toRecordFromLegacy({ id: row.id, data: row.data }))
  }

  async list(filter?: { unreadOnly?: boolean; limit?: number }): Promise<readonly AlertRecord[]> {
    let out: AlertRecord[]
    const kind = this.kind
    if (kind !== null) {
      const rows = await readAllRows(kind, { order: 'id' })
      out = rows.map(toRecord)
    } else {
      out = [...(await this.legacyRows())]
    }
    if (filter?.unreadOnly === true) {
      out = out.filter((r) => r.data['read'] === false)
    }
    out.sort((a, b) => Number(b.data['updatedAt'] ?? 0) - Number(a.data['updatedAt'] ?? 0))
    const limit = filter?.limit ?? 100
    return out.slice(0, limit)
  }

  async countUnread(): Promise<number> {
    const rows = await this.list({ unreadOnly: true, limit: 10_000 })
    return rows.length
  }

  async countAll(): Promise<number> {
    const kind = this.kind
    if (kind !== null) {
      const rows = await readAllRows(kind)
      return rows.length
    }
    return (await this.legacyRows()).length
  }

  async getData(id: string): Promise<Record<string, unknown> | null> {
    const kind = this.kind
    if (kind !== null) {
      const row = await kind.get(id)
      if (row === null) return null
      return row.data as Record<string, unknown>
    }
    const store = this.legacyStore
    if (store === null) return null
    const row = await store.get.query({ collection: ALERTS_COLLECTION, key: id })
    return legacyGetData(row)
  }

  async mergeUpdate(id: string, patch: Record<string, unknown>): Promise<void> {
    const existing = await this.getData(id)
    if (existing === null) return
    await this.putRaw(id, { ...existing, ...patch })
  }

  async persist(alert: Alert): Promise<void> {
    const { id, ...body } = alert
    const data = alertsRecordKind.schema.parse(body)
    const kind = this.kind
    if (kind !== null) {
      await kind.put({ id, data })
      return
    }
    await this.putRaw(id, { ...body, id })
  }

  async putRaw(id: string, data: Record<string, unknown>): Promise<void> {
    const parsed = AlertSchema.parse({ id, ...data })
    const { id: _drop, ...body } = parsed
    const kind = this.kind
    if (kind !== null) {
      await kind.put({ id, data: body })
      return
    }
    const store = this.legacyStore
    if (store === null) return
    await store.set.mutate({ collection: ALERTS_COLLECTION, key: id, value: { id, ...body } })
  }

  async delete(id: string): Promise<void> {
    const kind = this.kind
    if (kind !== null) {
      await kind.delete(id)
      return
    }
    const store = this.legacyStore
    if (store === null) return
    await store.delete.mutate({ collection: ALERTS_COLLECTION, key: id })
  }

  async listAllByCreatedAtAsc(): Promise<readonly AlertRecord[]> {
    const kind = this.kind
    let out: AlertRecord[]
    if (kind !== null) {
      const rows = await readAllRows(kind)
      out = rows.map(toRecord)
    } else {
      out = [...(await this.legacyRows())]
    }
    out.sort((a, b) => Number(a.data['createdAt'] ?? 0) - Number(b.data['createdAt'] ?? 0))
    return out
  }

  async listRecent(limit: number): Promise<readonly AlertRecord[]> {
    const kind = this.kind
    let out: AlertRecord[]
    if (kind !== null) {
      const rows = await readAllRows(kind, { order: 'id' })
      out = rows.map(toRecord)
    } else {
      out = [...(await this.legacyRows())]
    }
    out.sort((a, b) => Number(b.data['updatedAt'] ?? 0) - Number(a.data['updatedAt'] ?? 0))
    return out.slice(0, limit)
  }

  async findWhereDataField(field: string, value: unknown): Promise<readonly AlertRecord[]> {
    const kind = this.kind
    if (kind !== null) {
      const rows = await readAllRows(kind)
      return rows.filter((r) => r.data[field as keyof AlertBody] === value).map(toRecord)
    }
    const rows = await this.legacyRows()
    return rows.filter((r) => r.data[field] === value)
  }
}
