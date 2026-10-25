/**
 * The `ctx.api.settingsStore` these specs hand the device-manager.
 *
 * It is the REAL `SqliteSettingsBackend` on an in-memory database, wrapped in
 * the tRPC-shaped namespace the addon reaches for. That is deliberate and it is
 * not convenience: the device row store depends on column semantics the engine
 * owns — `NOT NULL DEFAULT`, `BOOLEAN` ↔ `0|1`, JSON columns parsed on read,
 * `ON CONFLICT DO UPDATE SET` touching only the columns a write NAMES — and a
 * hand-rolled table would be free to get any of them right by accident. This
 * repo has twice shipped a green suite whose fake supplied the value production
 * forgot to fetch; a fake with its own idea of what a column does is exactly
 * that shape.
 */

import type { SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '../../sqlite-storage/sqlite-settings-backend.js'
import { DEVICE_ROWS_COLUMNS, DEVICE_ROWS_INDEXES } from '../device-row-store.js'

export interface FakeSettingsStore {
  /** The object a spec assigns to `ctx.api.settingsStore`. */
  readonly api: SettingsStoreClient
  /** The engine underneath, for assertions about what actually landed. */
  readonly backend: SqliteSettingsBackend
  /** Collections passed to `declareCollection` during boot. */
  readonly declared: ReadonlySet<string>
  /**
   * Every write that reached a collection, in order.
   *
   * Exists for the assertions that are about the NUMBER of writes rather than
   * the result — "one row write per batch setter" is the whole point of
   * `applyInitialMeta`, and it was previously asserted by counting
   * `writeAddonStore` calls carrying a `deviceMeta` key.
   */
  readonly writes: readonly CollectionWrite[]
}

/** One write against a collection. `key` is set for a keyed upsert/delete. */
export interface CollectionWrite {
  readonly op: 'set' | 'updateWhere' | 'delete'
  readonly collection: string
  readonly key?: string
  readonly columns?: readonly string[]
}

/**
 * The tRPC namespace shape (`x.query(input)` / `x.mutate(input)`) over the
 * engine's plain methods.
 *
 * The returned object is narrower than the full `settingsStore` router — it
 * carries the seven procedures `DeviceRowStore` reaches for and nothing else, so
 * a new dependency shows up as a missing-method crash in the spec rather than
 * as silence. That narrowing is the documented type boundary the assertion
 * below stands on.
 */
function toTrpcNamespace(
  backend: SqliteSettingsBackend,
  writes: CollectionWrite[],
  declared: Set<string>,
): SettingsStoreClient {
  const namespace = {
    declareCollection: {
      mutate: (input: Parameters<SqliteSettingsBackend['declareCollection']>[0]) => {
        declared.add(input.collection)
        return backend.declareCollection(input)
      },
    },
    get: {
      query: (input: Parameters<SqliteSettingsBackend['get']>[0]) => backend.get(input),
    },
    set: {
      mutate: (input: Parameters<SqliteSettingsBackend['set']>[0]) => {
        writes.push({
          op: 'set',
          collection: input.collection,
          key: input.key,
          columns:
            input.value !== null && typeof input.value === 'object' ? Object.keys(input.value) : [],
        })
        return backend.set(input)
      },
    },
    query: {
      query: (input: Parameters<SqliteSettingsBackend['query']>[0]) => backend.query(input),
    },
    updateWhere: {
      mutate: (input: Parameters<SqliteSettingsBackend['updateWhere']>[0]) => {
        writes.push({
          op: 'updateWhere',
          collection: input.collection,
          columns: Object.keys(input.data),
        })
        return backend.updateWhere(input)
      },
    },
    delete: {
      mutate: (input: Parameters<SqliteSettingsBackend['delete']>[0]) => {
        writes.push({ op: 'delete', collection: input.collection, key: input.key })
        return backend.delete(input)
      },
    },
    count: {
      query: (input: Parameters<SqliteSettingsBackend['count']>[0]) => backend.count(input),
    },
    deleteWhere: {
      mutate: (input: Parameters<SqliteSettingsBackend['deleteWhere']>[0]) => {
        writes.push({ op: 'delete', collection: input.collection })
        return backend.deleteWhere(input)
      },
    },
  }
  return namespace as unknown as SettingsStoreClient
}

/** A fresh in-memory settings store. No files, no cleanup. */
export async function makeSettingsStoreApi(): Promise<FakeSettingsStore> {
  const backend = new SqliteSettingsBackend(':memory:')
  await backend.initialize()
  const writes: CollectionWrite[] = []
  const declared = new Set<string>()
  return { api: toTrpcNamespace(backend, writes, declared), backend, writes, declared }
}

/** Writes that landed on the device ledger since `from` (default: all of them). */
export function deviceRowWrites(store: FakeSettingsStore, from = 0): readonly CollectionWrite[] {
  return store.writes.slice(from).filter((w) => w.collection === 'device-manager:devices')
}

/** The columns a seeded device row must carry — every `NOT NULL` one. */
export interface SeedDeviceRow {
  readonly deviceId: number
  readonly type: string
  readonly addonId?: string
  readonly stableId?: string
  readonly name?: string
  readonly disabled?: boolean
  readonly registered?: boolean
  readonly location?: string | null
  readonly parentDeviceId?: number | null
  readonly integrationId?: string | null
}

/**
 * Put a device in the ledger without going through `registerDevice`.
 *
 * Replaces the `settings.writeAddonStore({ deviceMeta: … })` these specs used
 * to do. It writes through the ENGINE, so a seeded row is subject to the same
 * `NOT NULL` / `BOOLEAN` / JSON rules production writes are — a spec cannot
 * seed a shape the collection would refuse.
 */
export async function seedDeviceRow(store: FakeSettingsStore, row: SeedDeviceRow): Promise<void> {
  await store.backend.declareCollection({
    collection: 'device-manager:devices',
    columns: DEVICE_ROWS_COLUMNS,
    indexes: DEVICE_ROWS_INDEXES,
  })
  await store.backend.set({
    collection: 'device-manager:devices',
    key: String(row.deviceId),
    value: {
      deviceId: row.deviceId,
      addonId: row.addonId ?? 'provider-test',
      stableId: row.stableId ?? `stable-${row.deviceId}`,
      type: row.type,
      name: row.name ?? `device-${row.deviceId}`,
      disabled: row.disabled ?? false,
      registered: row.registered ?? true,
      location: row.location ?? null,
      parentDeviceId: row.parentDeviceId ?? null,
      integrationId: row.integrationId ?? null,
    },
  })
}

/**
 * The persisted row for one device, exactly as it sits in the collection.
 *
 * Replaces the `store.deviceMeta[String(id)]` reads these specs used to do
 * against the blob. Absent columns come back as `null` (SQL), not missing — so
 * "the override was cleared" is asserted as `display === null`, not as
 * `'display' in row === false`.
 */
export async function readDeviceRow(
  store: FakeSettingsStore,
  deviceId: number,
): Promise<Record<string, unknown>> {
  const raw = await store.backend.get({
    collection: 'device-manager:devices',
    key: String(deviceId),
  })
  return raw !== null && typeof raw === 'object' ? { ...raw } : {}
}

/** Every persisted device row, ordered by numeric id. */
export async function readDeviceRows(
  store: FakeSettingsStore,
): Promise<readonly Record<string, unknown>[]> {
  const records = await store.backend.query({
    collection: 'device-manager:devices',
    filter: { orderBy: { field: 'deviceId', direction: 'asc' } },
  })
  return records.map((r) => r.data)
}

/** Empty the device ledger — the "store has not been restored" state. */
export async function clearDeviceRows(store: FakeSettingsStore): Promise<void> {
  await store.backend.declareCollection({
    collection: 'device-manager:devices',
    columns: DEVICE_ROWS_COLUMNS,
    indexes: DEVICE_ROWS_INDEXES,
  })
  for (const record of await store.backend.query({ collection: 'device-manager:devices' })) {
    await store.backend.delete({ collection: 'device-manager:devices', key: record.id })
  }
}
