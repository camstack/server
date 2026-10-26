/**
 * The `history.db` data model (plan §4), declared through the settings door
 * with `database: 'history'` (D851). The engine turns each declaration into the
 * DDL the plan lists; a spec compares `sqlite_master` with it.
 *
 * The opt-out table is configuration, not history: it names no database and so
 * lives in `camstack.db`, which the nightly backup carries.
 */
import type { DeclareCollectionInput } from '@camstack/types'
import type { RollupTier } from '../time/bucket-time.js'

export const HISTORY_NAMESPACE = 'device-history'

export const COLLECTIONS = {
  metrics: 'metrics',
  series: 'series',
  raw: 'raw',
  rollup5m: 'rollup-5m',
  rollup1h: 'rollup-1h',
  rollup1d: 'rollup-1d',
  optOuts: 'device-opt-outs',
  departures: 'device-departures',
  /** One row per applied base-unit rescale, in history.db so it travels with the points. */
  appliedScales: 'applied-scales',
} as const

export type TierCollection = (typeof COLLECTIONS)['rollup5m' | 'rollup1h' | 'rollup1d']

export function rollupCollectionOf(tier: RollupTier): TierCollection {
  if (tier === '5m') return COLLECTIONS.rollup5m
  if (tier === '1h') return COLLECTIONS.rollup1h
  return COLLECTIONS.rollup1d
}

/** Table name the engine creates for a collection of this addon. */
export function tableNameOf(collection: string): string {
  return `${HISTORY_NAMESPACE}:${collection}`
}

function rollupDeclaration(collection: string): DeclareCollectionInput {
  return {
    namespace: HISTORY_NAMESPACE,
    collection,
    database: 'history',
    primaryKey: ['series_id', 'bucket_start'],
    withoutRowid: true,
    columns: [
      { name: 'series_id', type: 'INTEGER' },
      { name: 'bucket_start', type: 'INTEGER' },
      { name: 'samples', type: 'INTEGER', notNull: true },
      { name: 'sum', type: 'REAL', notNull: true },
      { name: 'min', type: 'REAL', notNull: true },
      { name: 'max', type: 'REAL', notNull: true },
      { name: 'last', type: 'REAL' },
      { name: 'last_ts', type: 'INTEGER' },
      { name: 'tw_sum', type: 'REAL' },
      { name: 'tw_ms', type: 'INTEGER' },
      // `enum` series only: JSON `{ "<ordinal>": ms }`, the time spent in each state.
      { name: 'state_ms', type: 'TEXT' },
    ],
  }
}

export const HISTORY_DECLARATIONS: readonly DeclareCollectionInput[] = [
  {
    namespace: HISTORY_NAMESPACE,
    collection: COLLECTIONS.metrics,
    database: 'history',
    columns: [
      { name: 'key', type: 'TEXT', primaryKey: true, notNull: true },
      { name: 'source', type: 'TEXT', notNull: true },
      { name: 'owner_addon', type: 'TEXT', notNull: true },
      { name: 'subject_kind', type: 'TEXT', notNull: true },
      { name: 'kind', type: 'TEXT', notNull: true },
      { name: 'unit', type: 'TEXT' },
      { name: 'display_name', type: 'TEXT', notNull: true },
      { name: 'ingest', type: 'TEXT', notNull: true },
      { name: 'declared_at', type: 'INTEGER', notNull: true },
      // `enum` metrics only: JSON array, index = ordinal. Append-only.
      { name: 'enum_values', type: 'TEXT' },
    ],
  },
  {
    namespace: HISTORY_NAMESPACE,
    collection: COLLECTIONS.series,
    database: 'history',
    columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'key', type: 'TEXT', notNull: true },
      { name: 'subject', type: 'TEXT', notNull: true },
      { name: 'device_id', type: 'INTEGER' },
      { name: 'scope', type: 'TEXT', notNull: true, defaultValue: '' },
      { name: 'first_ts', type: 'INTEGER', notNull: true },
      { name: 'last_ts', type: 'INTEGER', notNull: true },
    ],
    indexes: [
      { name: 'idx_dh_series_identity', columns: ['key', 'subject', 'scope'], unique: true },
      { name: 'idx_dh_series_device', columns: ['device_id'] },
    ],
  },
  {
    namespace: HISTORY_NAMESPACE,
    collection: COLLECTIONS.raw,
    database: 'history',
    primaryKey: ['series_id', 'ts'],
    withoutRowid: true,
    columns: [
      { name: 'series_id', type: 'INTEGER' },
      { name: 'ts', type: 'INTEGER' },
      { name: 'value', type: 'REAL', notNull: true },
    ],
  },
  rollupDeclaration(COLLECTIONS.rollup5m),
  rollupDeclaration(COLLECTIONS.rollup1h),
  rollupDeclaration(COLLECTIONS.rollup1d),
  {
    // Plan §4 writes `device_id INTEGER PRIMARY KEY`. The engine treats an INTEGER primary key
    // as a rowid alias it assigns itself (D473) and drops a supplied value, so the device id
    // could never be written through the door. Same columns, an engine-assigned `id`, and the
    // device id made unique by an index (the upsert's conflict target).
    namespace: HISTORY_NAMESPACE,
    collection: COLLECTIONS.optOuts,
    columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'device_id', type: 'INTEGER', notNull: true },
      { name: 'opted_out_at', type: 'INTEGER', notNull: true },
    ],
    indexes: [{ name: 'idx_dh_opt_outs_device', columns: ['device_id'], unique: true }],
  },
  {
    // Since when a device has been absent from EVERY successful device listing. Kept beside
    // the opt-outs (camstack.db): a restart must neither reset it to now nor lose it.
    namespace: HISTORY_NAMESPACE,
    collection: COLLECTIONS.departures,
    columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'device_id', type: 'INTEGER', notNull: true },
      { name: 'missing_since', type: 'INTEGER', notNull: true },
    ],
    indexes: [{ name: 'idx_dh_departures_device', columns: ['device_id'], unique: true }],
  },
  {
    namespace: HISTORY_NAMESPACE,
    collection: COLLECTIONS.appliedScales,
    database: 'history',
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
      { name: 'applied_at', type: 'INTEGER', notNull: true },
    ],
  },
]
