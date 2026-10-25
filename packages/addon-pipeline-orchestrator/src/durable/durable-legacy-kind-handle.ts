/**
 * Wraps a legacy settings-store collection as a minimal `RecordKindHandle` for
 * {@link DurableLedger} on agent nodes (no `ctx.records`, D332).
 *
 * Maps rows through the owning spec's `toValue` / `fromRecord` — the same
 * shapes the hub records kind adopts from.
 */
import type { RecordKindHandle, RecordPut, RecordRow, SettingsStoreClient } from '@camstack/types'
import type { DurableLedgerSpec } from './durable-ledger.js'

/** Persisted body for a durable row — the legacy column map minus the pk. */
export type DurableRecordBody = Record<string, unknown>

function notImpl(method: string): never {
  throw new Error(`DurableLegacyKindHandle.${method}() is not available on the legacy (agent) path`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toRecordRow(id: string, data: DurableRecordBody): RecordRow<DurableRecordBody> {
  return { id, data, deviceId: null, at: null, expiresAt: null, rev: 0, updatedAt: 0 }
}

export interface DurableLegacyKindHandleOptions<TRow> {
  readonly spec: DurableLedgerSpec<TRow>
  readonly store: SettingsStoreClient
}

export class DurableLegacyKindHandle<TRow> implements RecordKindHandle<DurableRecordBody> {
  readonly name: string
  private readonly spec: DurableLedgerSpec<TRow>
  private readonly store: SettingsStoreClient

  constructor(opts: DurableLegacyKindHandleOptions<TRow>) {
    this.name = opts.spec.collection
    this.spec = opts.spec
    this.store = opts.store
  }

  async get(id: string): Promise<RecordRow<DurableRecordBody> | null> {
    const rows = await this.store.query.query({
      collection: this.spec.collection,
      filter: { where: { [this.pkColumn()]: id }, limit: 1 },
    })
    const row = rows[0]
    if (row === undefined || !isRecord(row.data)) return null
    const parsed = this.spec.fromRecord(row.id, row.data)
    if (parsed === null) return null
    return toRecordRow(row.id, this.spec.toValue(parsed))
  }

  async query(q: { readonly limit?: number; readonly cursor?: string }): Promise<{
    readonly records: readonly RecordRow<DurableRecordBody>[]
    readonly nextCursor: string | null
  }> {
    const rows = await this.store.query.query({
      collection: this.spec.collection,
      filter: { limit: q.limit ?? 10_000 },
    })
    const records: RecordRow<DurableRecordBody>[] = []
    for (const row of rows) {
      if (!isRecord(row.data)) continue
      const parsed = this.spec.fromRecord(row.id, row.data)
      if (parsed === null) continue
      records.push(toRecordRow(row.id, this.spec.toValue(parsed)))
    }
    return { records, nextCursor: null }
  }

  async put(input: RecordPut<DurableRecordBody>): Promise<{ readonly rev: number }> {
    await this.store.set.mutate({
      collection: this.spec.collection,
      key: input.id,
      value: input.data,
    })
    return { rev: 0 }
  }

  async delete(id: string): Promise<boolean> {
    await this.store.delete.mutate({ collection: this.spec.collection, key: id })
    return true
  }

  getMany = (): never => notImpl('getMany')
  getResolved = (): never => notImpl('getResolved')
  putMany = (): never => notImpl('putMany')
  patch = (): never => notImpl('patch')
  deleteMany = (): never => notImpl('deleteMany')
  count = (): never => notImpl('count')
  histogram = (): never => notImpl('histogram')
  aggregate = (): never => notImpl('aggregate')
  deleteWhere = (): never => notImpl('deleteWhere')
  allocateId = (): never => notImpl('allocateId')
  txPut = (): never => notImpl('txPut')
  txPatch = (): never => notImpl('txPatch')
  txDelete = (): never => notImpl('txDelete')

  private pkColumn(): string {
    const pk = this.spec.columns.find((c) => c.primaryKey === true)
    return pk?.name ?? 'id'
  }
}

/** Legacy settings-store handle for one {@link DurableLedgerSpec}. */
export function durableLegacyKind<TRow>(
  spec: DurableLedgerSpec<TRow>,
  store: SettingsStoreClient,
): RecordKindHandle<DurableRecordBody> {
  return new DurableLegacyKindHandle({ spec, store })
}

/** Agent boot: declare the SQLite collection behind a durable ledger spec. */
export function declareDurableLegacyCollection<TRow>(
  store: SettingsStoreClient,
  spec: DurableLedgerSpec<TRow>,
): Promise<void> {
  return store.declareCollection.mutate({
    collection: spec.collection,
    columns: [...spec.columns],
    ...(spec.indexes !== undefined ? { indexes: [...spec.indexes] } : {}),
  })
}
