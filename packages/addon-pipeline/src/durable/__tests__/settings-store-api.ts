/**
 * The `ctx.api.settingsStore` these specs hand the recorder / stream-broker.
 *
 * It is the REAL `SqliteSettingsBackend` on an in-memory database, wrapped in
 * the tRPC-shaped namespace an addon reaches for — the same choice the
 * device-manager flatten made (`packages/system/src/builtins/device-manager/
 * __tests__/settings-store-api.ts`), for the same reason: the row stores depend
 * on column semantics the ENGINE owns — `NOT NULL DEFAULT`, `BOOLEAN` ↔ `0|1`,
 * a `JSON` column serialised on write and parsed on read, `ON CONFLICT DO
 * UPDATE SET` touching only the columns a write NAMES, and the silent 2 000-row
 * query cap. A hand-rolled table is free to get any of those right by accident.
 * This repo has twice shipped a green suite whose fake supplied the value
 * production forgot to fetch.
 */

import type { SettingsStoreClient } from '@camstack/types'
// eslint-disable-next-line no-restricted-imports -- test-only: the specs mount
// the REAL settings engine rather than a fake (see the header). The SOURCE and
// not `@camstack/system`'s barrel: the barrel drags every builtin in (and its
// ESM copy fails to resolve `@camstack/types/node` under vitest), while this is
// one file with no addon graph behind it. Nothing under `src/` imports it.
import { SqliteSettingsBackend } from '../../../../system/src/builtins/sqlite-storage/sqlite-settings-backend.js'

export interface FakeSettingsStore {
  /** The object a spec assigns to `ctx.api.settingsStore`. */
  readonly api: SettingsStoreClient
  /** The engine underneath, for assertions about what actually landed. */
  readonly backend: SqliteSettingsBackend
  /** Every call that reached the store, in order — the read/write SHAPE. */
  readonly calls: readonly StoreCall[]
}

/** One call against a collection. `key` is set for a keyed get/upsert/delete. */
export interface StoreCall {
  readonly op: 'get' | 'set' | 'query' | 'delete' | 'deleteWhere' | 'count'
  readonly collection: string
  readonly key?: string
}

/**
 * The tRPC namespace shape (`x.query(input)` / `x.mutate(input)`) over the
 * engine's plain methods.
 *
 * Narrower than the full `settingsStore` router — it carries the six procedures
 * the row stores reach for and nothing else, so a NEW dependency shows up as a
 * missing-method crash in the spec rather than as silence. That narrowing is
 * the documented type boundary the single assertion below stands on.
 */
function toTrpcNamespace(backend: SqliteSettingsBackend, calls: StoreCall[]): SettingsStoreClient {
  const namespace = {
    declareCollection: {
      mutate: (input: Parameters<SqliteSettingsBackend['declareCollection']>[0]) =>
        backend.declareCollection(input),
    },
    get: {
      query: (input: Parameters<SqliteSettingsBackend['get']>[0]) => {
        calls.push({ op: 'get', collection: input.collection, key: input.key })
        return backend.get(input)
      },
    },
    set: {
      mutate: (input: Parameters<SqliteSettingsBackend['set']>[0]) => {
        calls.push({ op: 'set', collection: input.collection, key: input.key })
        return backend.set(input)
      },
    },
    query: {
      query: (input: Parameters<SqliteSettingsBackend['query']>[0]) => {
        calls.push({ op: 'query', collection: input.collection })
        return backend.query(input)
      },
    },
    delete: {
      mutate: (input: Parameters<SqliteSettingsBackend['delete']>[0]) => {
        calls.push({ op: 'delete', collection: input.collection, key: input.key })
        return backend.delete(input)
      },
    },
    deleteWhere: {
      mutate: (input: Parameters<SqliteSettingsBackend['deleteWhere']>[0]) => {
        calls.push({ op: 'deleteWhere', collection: input.collection })
        return backend.deleteWhere(input)
      },
    },
    count: {
      query: (input: Parameters<SqliteSettingsBackend['count']>[0]) => {
        calls.push({ op: 'count', collection: input.collection })
        return backend.count(input)
      },
    },
  }
  return namespace as unknown as SettingsStoreClient
}

/** A fresh in-memory settings store. No files, no cleanup. */
export async function makeSettingsStoreApi(): Promise<FakeSettingsStore> {
  const backend = new SqliteSettingsBackend(':memory:')
  await backend.initialize()
  const calls: StoreCall[] = []
  return { api: toTrpcNamespace(backend, calls), backend, calls }
}

/** Calls that landed on one collection since `from` (default: all of them). */
export function callsOn(
  store: FakeSettingsStore,
  collection: string,
  from = 0,
): readonly StoreCall[] {
  return store.calls.slice(from).filter((c) => c.collection === collection)
}
