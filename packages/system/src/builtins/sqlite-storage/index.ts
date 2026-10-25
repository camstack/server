// Public exports for the `sqlite-storage` builtin family.
//
// `FilesystemStorageProvider` here is the new `storage-provider` cap
// implementation (Task 7). The legacy sync `IStorageProvider` shape
// still lives in `@camstack/types/node` (`LegacyFilesystemStorageProvider`
// would be the rename — kept under its old name there for now since
// `ctx.kernel.storage` consumers haven't been migrated yet). Importers
// who need the legacy sync resolver should reach into
// `@camstack/types/node` directly.

export { ConfigStore } from './config-store.js'
export type { DeviceRow } from './device-store.js'
export { DeviceStore } from './device-store.js'
// Default export for AddonLoader
export {
  FilesystemStorageAddon,
  FilesystemStorageAddon as default,
} from './filesystem-storage.addon.js'
export { FilesystemStorageProvider } from './filesystem-storage-provider.js'
export type { SqliteOpLabel, SqliteOpSample, SqliteOpStat } from './query-profiler.js'
export {
  SQLITE_ENGINE_STORM_WALL_SHARE,
  SQLITE_PROFILE_REPORT_FLOOR_MS,
  SQLITE_PROFILE_REPORT_INTERVAL_MS,
  SQLITE_PROFILE_TOP_N,
  SQLITE_SLOW_CALL_MS,
  sqliteEngineStorm,
  SqliteOpProfiler,
} from './query-profiler.js'
export {
  SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
  SQLITE_MMAP_CEILING_BYTES,
  SQLITE_MMAP_FLOOR_BYTES,
  SQLITE_PAGE_CACHE_CEILING_KIB,
  SQLITE_PAGE_CACHE_FLOOR_KIB,
  sqliteMmapSizeFor,
  sqlitePageCacheKibFor,
} from './sqlite-pragmas.js'
export { SqliteSettingsAddon } from './sqlite-settings.addon.js'
export { SqliteSettingsBackend } from './sqlite-settings-backend.js'
export type { WalMaintenanceOptions, WalMaintenanceOutcome } from './wal-maintenance.js'
export {
  WAL_CHECKPOINT_BUSY_TIMEOUT_MS,
  WAL_HIGH_WATER_BYTES,
  WAL_IDLE_QUIET_MS,
  WAL_MAINTENANCE_INTERVAL_MS,
  WalMaintenance,
} from './wal-maintenance.js'
