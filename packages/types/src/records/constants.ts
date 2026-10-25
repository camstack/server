/** Limits and names of `ctx.records` (D881). One authority; the engine and the facade read it. */

/** The files a kind may live in. `history` is device-history's (D850), never records. */
export const RECORD_DATABASES = ['settings', 'events'] as const
export type RecordDatabase = (typeof RECORD_DATABASES)[number]

/** The classes of a kind: the `@durable` vocabulary, one authority (replaces the annotation). */
export const RECORD_CLASSES = ['config', 'ledger', 'audit', 'mirror', 'ephemeral'] as const
export type RecordClass = (typeof RECORD_CLASSES)[number]

export const RECORD_DEFAULT_MAX_DATA_BYTES = 64 * 1024
export const RECORD_MAX_DATA_BYTES = 1024 * 1024
export const RECORD_ID_MAX_LENGTH = 256
export const RECORD_BATCH_MAX = 1000
export const RECORD_BATCH_MAX_BYTES = 4 * 1024 * 1024
export const RECORD_QUERY_MAX = 1000
/** Rows one DELETE statement removes before the serving thread yields. */
export const RECORD_DELETE_BATCH = 5000
/** A kind in the `settings` file may not bound itself above this (D447: high volume is `events`). */
export const RECORD_SETTINGS_MAX_ROWS = 50_000
export const RECORD_MAX_INDEXES = 8
export const RECORD_MAX_INDEX_FIELDS = 4

/** The engine's TTL sweep cadence. */
export const RECORD_SWEEP_INTERVAL_MS = 10 * 60_000

/** The `Column`-free proof prefix: a ref collection for a kind's secret fields. */
export const RECORD_SECRET_COLLECTION_PREFIX = 'records:'
