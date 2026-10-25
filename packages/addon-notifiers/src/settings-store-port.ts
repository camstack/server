/**
 * Legacy `SettingsStorePort` adapters — kept so external callers that imported
 * `createApiSettingsStorePort` / `createMemorySettingsStorePort` from the
 * package index continue to compile. New code must use `TargetStore.of(records)`.
 *
 * `SettingsStorePort` and `StoredRecord` are the narrow interface the OLD
 * `TargetStore` consumed; they are preserved here for backward-compatible
 * imports but no longer used internally.
 */
import type { AddonApi } from '@camstack/types'

/** One stored record: `{ id, data }` — mirrors `settings-store`'s `SettingsRecordSchema`. */
export interface StoredRecord {
  readonly id: string
  readonly data: Readonly<Record<string, unknown>>
}

/** A single typed column for `declareCollection`. */
export interface ColumnSpec {
  readonly name: string
  readonly type: 'TEXT' | 'INTEGER' | 'REAL' | 'JSON' | 'BOOLEAN'
  readonly primaryKey?: boolean
  readonly notNull?: boolean
}

/** KV JSON-blob shape — a single `data` column routes the row through the
 *  settings backend's canonical key/value path (id TEXT PK, data TEXT). */
export const KV_BLOB_COLUMNS: readonly ColumnSpec[] = [
  { name: 'data', type: 'TEXT', notNull: true },
]

/**
 * The narrow persistence surface the OLD TargetStore consumed.
 * @deprecated Use `TargetStore.of(records)` with `ctx.records` instead.
 */
export interface SettingsStorePort {
  query(collection: string): Promise<readonly StoredRecord[]>
  insert(collection: string, record: StoredRecord): Promise<void>
  update(collection: string, id: string, data: Record<string, unknown>): Promise<void>
  remove(collection: string, id: string): Promise<void>
  /** Declare the backing collection before any read/write. The SQLite settings
   *  backend fails fast on undeclared collections. Idempotent. */
  declareCollection(collection: string, columns: readonly ColumnSpec[]): Promise<void>
}

/** @deprecated Use `TargetStore.of(records)` instead. */
export function createApiSettingsStorePort(api: AddonApi): SettingsStorePort {
  return {
    query: async (collection) => {
      const rows = await api.settingsStore.query.query({ collection })
      return rows.map((r) => ({ id: r.id, data: r.data }))
    },
    insert: async (collection, record) => {
      await api.settingsStore.insert.mutate({
        collection,
        record: { id: record.id, data: { ...record.data } },
      })
    },
    update: async (collection, id, data) => {
      await api.settingsStore.update.mutate({ collection, id, data })
    },
    remove: async (collection, id) => {
      await api.settingsStore.delete.mutate({ collection, key: id })
    },
    declareCollection: async (collection, columns) => {
      await api.settingsStore.declareCollection.mutate({
        collection,
        columns: columns.map((c) => ({ ...c })),
      })
    },
  }
}

/** @deprecated Use `TargetStore.of(records)` instead. */
export function createMemorySettingsStorePort(): SettingsStorePort {
  const collections = new Map<string, Map<string, StoredRecord>>()
  const bucket = (collection: string): Map<string, StoredRecord> => {
    let map = collections.get(collection)
    if (!map) {
      map = new Map<string, StoredRecord>()
      collections.set(collection, map)
    }
    return map
  }
  return {
    query: async (collection) => [...bucket(collection).values()],
    insert: async (collection, record) => {
      bucket(collection).set(record.id, { id: record.id, data: { ...record.data } })
    },
    update: async (collection, id, data) => {
      bucket(collection).set(id, { id, data: { ...data } })
    },
    remove: async (collection, id) => {
      bucket(collection).delete(id)
    },
    declareCollection: async (collection) => {
      // Ensure the bucket exists so the memory fallback mirrors declared state.
      bucket(collection)
    },
  }
}
