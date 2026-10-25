import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import type {
  BulkRecord,
  DataStoreDatabase,
  DataStoreEngineInfo,
  DeclareCollectionInput,
  HistogramBucket,
  IScopedLogger,
  ISettingsBackend,
  QueryFilter,
  SettingsAggregateInput,
  SettingsAggregateResult,
  SettingsCountInput,
  SettingsDeleteInput,
  SettingsGetInput,
  SettingsHistogramInput,
  SettingsInsertInput,
  SettingsIsEmptyInput,
  SettingsQueryInput,
  SettingsRecord,
  SettingsSetInput,
  SettingsUpdateInput,
  SettingsUpsertInput,
  TableSchema,
} from '@camstack/types'
import { CompositeKeyError } from './placement-errors.js'
import { asJsonObject, parseJsonUnknown } from '@camstack/types'
import Database from 'better-sqlite3'
import { ANALYZE_DELAY_MS, runAnalyzeIfMissing } from './analyze-stats.js'
import {
  type CollectionShape,
  compileFilter,
  fieldExprFor,
  type MutationFilterInput,
  UnsafeFilterError,
} from './filter-compiler.js'
import { prefixRange } from './prefix-range.js'
import { isImposedBound, resolveRowBound } from './query-bounds.js'
import type { SqliteOpLabel } from './query-profiler.js'
import { SqliteOpProfiler } from './query-profiler.js'
import {
  MAP_GROWTH_CHECK_INTERVAL_MS,
  resolveMapGrowth,
  SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
  SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES,
  sqliteMmapSizeFor,
  sqliteOccupancy,
  sqlitePageCacheKibFor,
} from './sqlite-pragmas.js'
import {
  STORAGE_REPORT_DELAY_MS,
  STORAGE_REPORT_TOP_N,
  STORAGE_REPORT_TOP_OWNERS,
  summariseTableSizes,
  type TableSizeRow,
  toTableSizeRow,
} from './table-sizes.js'

/** What the backend remembers about a declared collection's shape. */
interface DeclaredCollection {
  readonly primaryKey: string
  readonly columns: ReadonlySet<string>
  /**
   * Subset of `columns` whose declared logical type is `BOOLEAN`.
   * Tracked because SQLite has no native bool — the backend stores
   * `true|false` as INTEGER `1|0`, and reads need to coerce back so
   * downstream Zod schemas can keep using canonical `z.boolean()`.
   */
  readonly booleanColumns: ReadonlySet<string>
  /**
   * The primary key is `INTEGER` — a SQLite ROWID ALIAS, which SQLite
   * assigns itself when the column is omitted from an INSERT.
   *
   * Tracked because it changes what a MISSING id means. On a TEXT key a
   * caller that supplies none is asking for a generated one, so `insert`
   * mints a `randomUUID()`. Doing that on an integer rowid alias would
   * bind a 36-character string to the row key: SQLite's INTEGER affinity
   * cannot convert it, so it is stored AS TEXT and the column stops being
   * a rowid alias for that row. The append-only tables that want the free
   * key are exactly the ones that would be broken by inventing one.
   */
  readonly autoPrimaryKey: boolean
  /**
   * The columns of a COMPOSITE primary key, or empty for a single-key
   * collection. A composite collection has `primaryKey === ''`, lists EVERY
   * column (key columns included) in `columns`, and has no id: the calls that
   * address one row by id refuse it ({@link CompositeKeyError}).
   */
  readonly keyColumns: readonly string[]
}

/** How one file of the engine is opened. All optional: the defaults are `camstack.db`'s. */
export interface SqliteSettingsBackendOptions {
  /** Which file this is — names it in log lines. Default `settings`. */
  readonly databaseId?: DataStoreDatabase
  /**
   * `incremental` sets `auto_vacuum = INCREMENTAL` — but ONLY on a file this
   * open CREATES: the mode is fixed when the first table is written, and
   * changing it on an existing file means a full `VACUUM`, which is the ops
   * script's job (D853), never a boot step. Default `none`.
   */
  readonly autoVacuum?: 'none' | 'incremental'
  /**
   * Declare the canonical key/value collections and seed the defaults. True
   * only for `settings`: canonical KV collections are settings by definition,
   * and a second copy of them in `events.db` would be a table nobody reads.
   */
  readonly canonicalKv?: boolean
}

/** Input for {@link SqliteSettingsBackend.insertMany}. */
interface SettingsInsertManyInput {
  readonly namespace?: string
  readonly collection: string
  readonly records: readonly BulkRecord[]
}
interface SettingsInsertManyResult {
  readonly inserted: number
}
/** Input for {@link SqliteSettingsBackend.upsertMany}. */
interface SettingsUpsertManyInput {
  readonly namespace?: string
  readonly collection: string
  readonly conflict: readonly string[]
  readonly records: readonly BulkRecord[]
}
interface SettingsUpsertManyResult {
  readonly upserted: number
}
/** Input for {@link SqliteSettingsBackend.transact}. */
interface SettingsTransactInput {
  readonly namespace?: string
  readonly guard?: {
    readonly collection: string
    readonly key: string
    readonly column: string
    readonly equals: unknown
  }
  readonly ops: readonly (
    | {
        readonly op: 'deleteWhere'
        readonly collection: string
        readonly filter: MutationFilterInput
      }
    | {
        readonly op: 'insertMany'
        readonly collection: string
        readonly records: readonly BulkRecord[]
      }
    | {
        readonly op: 'update'
        readonly collection: string
        readonly id: string
        readonly data: Record<string, unknown>
      }
    | {
        readonly op: 'upsertMany'
        readonly collection: string
        readonly conflict: readonly string[]
        readonly records: readonly BulkRecord[]
      }
  )[]
}
interface SettingsTransactResult {
  readonly applied: boolean
  readonly current?: unknown
}
/** Input for {@link SqliteSettingsBackend.deleteWhere}. */
interface SettingsDeleteWhereInput {
  readonly namespace?: string
  readonly collection: string
  readonly filter: MutationFilterInput
}
interface SettingsDeleteWhereResult {
  readonly deleted: number
}
/** Input for {@link SqliteSettingsBackend.updateWhere}. */
interface SettingsUpdateWhereInput {
  readonly namespace?: string
  readonly collection: string
  readonly filter: MutationFilterInput
  readonly data: Readonly<Record<string, unknown>>
}
interface SettingsUpdateWhereResult {
  readonly updated: number
}

/** The part of a declared collection {@link SqliteSettingsBackend.shapeOf} reads. */
interface DeclaredCollectionShape {
  readonly primaryKey: string
  readonly columns: ReadonlySet<string>
}

function parseRowData(raw: string): Record<string, unknown> {
  return asJsonObject(parseJsonUnknown(raw)) ?? {}
}

/**
 * `tags: { deviceId }` for a log line about a query, when the filter names one.
 *
 * Repo rule: every log line about a device carries the numeric id under that
 * exact key, because every question asked of these logs is per-camera ("why is
 * 102 truncating and 101 not?") and a line without the tag cannot be grouped.
 * Returns an empty object — not a `deviceId: undefined` — so a collection-wide
 * query does not log a tag that reads as "device unknown".
 */
function deviceTagOf(filter: QueryFilter | undefined): {
  tags?: { deviceId: number }
} {
  const raw = filter?.where?.['deviceId']
  return typeof raw === 'number' && Number.isFinite(raw) ? { tags: { deviceId: raw } } : {}
}

/** Same source as {@link deviceTagOf}, shaped for {@link SqliteOpLabel}. */
function deviceIdOf(filter: QueryFilter | undefined): { deviceId?: number } {
  const raw = filter?.where?.['deviceId']
  return typeof raw === 'number' && Number.isFinite(raw) ? { deviceId: raw } : {}
}

/**
 * The addon that owns a scoped row, lifted out of the filter that names it.
 *
 * `(op, collection)` cannot name a culprit: the 60 s window of 2026-08-25 read
 * `query addon-device-settings` 67 660 times — 1 128 a second on a
 * single-threaded synchronous engine — and the report could say what was
 * running but never who. The caller identity is not reachable from this
 * process (a cap handler receives an input, not a caller), but for the scoped
 * collections it does not need to be: the id IS `<addonId>:<deviceId>.<field>`,
 * so a filter that names an id names its owner.
 *
 * Attributes NOTHING when the id is unscoped or absent. A storm blamed on the
 * wrong addon is worse than one with no name on it — the wrong name gets acted
 * on. Same source and same shape as {@link deviceIdOf}, which already lifts the
 * device out of this very filter.
 */
export function scopeOwnerOf(filter: QueryFilter | undefined): { owner?: string } {
  const exact = ownerOfId(filter?.where?.['id'])
  if (exact !== null) return { owner: exact }
  // A scoped READ is a prefix range, never an equality: `prefix-range.ts`
  // exists precisely so `readDeviceStore` / `readAddonStore` can be answered
  // from the index as `id >= lo AND id < hi`. Reading only `where.id` therefore
  // looked at the one shape that never storms — 9 226 `query
  // addon-device-settings` a minute in every window of 2026-08-25, and not one
  // of them carried an owner in the report written to name exactly them.
  const lower = filter?.whereBetween?.['id']?.[0]
  const ranged = ownerOfId(lower)
  return ranged === null ? {} : { owner: ranged }
}

/** The `<addonId>` half of a scoped key, or `null` when there is not one. */
function ownerOfId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const colon = raw.indexOf(':')
  return colon > 0 ? raw.slice(0, colon) : null
}

/**
 * Stable identity of a declared schema — every property that changes the DDL
 * or the set of columns a filter can name.
 *
 * Deliberately covers `indexes` too: an added index is as invisible to a
 * name-only memo as an added column, and `CREATE INDEX IF NOT EXISTS` is
 * cheap enough that re-running it costs nothing.
 */
/**
 * A `query` asked to read a column the collection cannot serve. Distinct type
 * so a caller can map it to a 400 — it is always a programming error in the
 * caller, never a condition of the data.
 */
export class UnprojectableColumnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnprojectableColumnError'
  }
}

/**
 * The columns a `query` will actually SELECT — the whole declared set, or the
 * caller's projection.
 *
 * This is the one place the projection contract is enforced, and it enforces it
 * by THROWING. An unresolvable PREDICATE is skipped (`compileFilter`, select
 * mode) because the cost is extra rows, which the caller can still see and
 * filter. An unresolvable PROJECTION has no such fallback: the record would come
 * back missing that key, and `undefined` for a column the engine never read is
 * byte-identical to `undefined` for a column that holds NULL. The caller reads a
 * wrong VALUE and has no way to know. So:
 *
 *  - a name that is not a column of the collection → throw;
 *  - a KV-shaped collection (one `data` JSON blob — the row IS the blob, and
 *    projecting inside it would read the same bytes anyway) → throw;
 *  - an empty list → throw, because "select nothing" is far more likely a
 *    caller that computed a column set and got zero than an intent.
 *
 * The primary key is added by the caller of this function and is never part of
 * the projection: every record carries its id.
 */
function resolveProjection(
  table: string,
  decl: { readonly primaryKey: string; readonly columns: ReadonlySet<string> },
  isKvShape: boolean,
  projection: readonly string[] | undefined,
): ReadonlySet<string> {
  if (projection === undefined) return decl.columns
  if (isKvShape) {
    throw new UnprojectableColumnError(
      `"${table}" stores its row as a single JSON blob — a column projection cannot narrow what it reads, and honouring it as a no-op would return rows silently missing the fields asked for`,
    )
  }
  if (projection.length === 0) {
    throw new UnprojectableColumnError(
      `query on "${table}" was given an EMPTY column projection — that reads no data at all, which is a caller that computed a column set and got nothing rather than an intent`,
    )
  }
  const out = new Set<string>()
  for (const name of projection) {
    // The primary key is always returned as `record.id`; naming it is
    // harmless and some callers derive their list mechanically.
    if (name === decl.primaryKey) continue
    if (!decl.columns.has(name)) {
      throw new UnprojectableColumnError(
        `query on "${table}" asked to read "${name}", which is not a column of this collection — refusing, because the row would come back missing that key and the caller could not tell an unread column from a NULL one`,
      )
    }
    out.add(name)
  }
  return out
}

function schemaFingerprint(schema: TableSchema): string {
  return JSON.stringify({
    columns: schema.columns.map((c) => [
      c.name,
      c.type,
      c.primaryKey ?? false,
      c.notNull ?? false,
      c.unique ?? false,
      c.defaultValue ?? null,
    ]),
    indexes: (schema.indexes ?? []).map((i) => [i.name, [...i.columns], i.unique ?? false]),
    primaryKey: schema.primaryKey ?? null,
    withoutRowid: schema.withoutRowid ?? false,
  })
}

/**
 * SQLite implementation of ISettingsBackend.
 *
 * Every collection is structured: declared at boot (canonical KV
 * collections) or via `declareCollection` (typed schemas like
 * `pipeline-analytics:tracks`). The legacy auto-create-on-first-access
 * path was removed — see commit history for the migration. Operations
 * on undeclared collections throw at runtime so callers fail fast.
 *
 * WAL mode for concurrent reads.
 */
export class SqliteSettingsBackend implements ISettingsBackend {
  private db: Database.Database | null = null
  /**
   * Table name → fingerprint of the schema this process last materialised.
   *
   * Keyed by FINGERPRINT, not by name, and that is the whole point. An addon
   * declares its schema at every boot, but the backend lives in hub-main,
   * which outlives an addon respawn: `camstack deploy` restarts the addon
   * runner and NOT hub-main. A name-only memo therefore made the second
   * declaration of a table a no-op FOREVER — a redeployed addon whose schema
   * had gained a column never got the `ALTER TABLE … ADD COLUMN`, and, because
   * `compileFilter` silently drops a predicate naming a column the collection
   * cannot express (select mode), the missing column read as "matches
   * everything" instead of failing. That is how `pipeline-analytics:tracks`
   * ran for a whole release with no `retrainStatus`: the retention sweep's
   * `whereIn: { retrainStatus: ['none','trained'] }` pin evaporated, so every
   * operator-staged track was eligible for deletion, and `countStaging`
   * reported the entire history as staged.
   */
  private readonly structuredTables = new Map<string, string>()
  /** Map from scoped collection name → set of column names (non-id) that
   *  the structured schema owns. Routes set/get/insert/update/query to
   *  typed columns. Every collection MUST be declared here before use. */
  private readonly declaredCollections = new Map<string, DeclaredCollection>()
  /** Tables an addon declared since THIS process started - a running addon claims them. */
  private readonly declaredThisBoot = new Set<string>()
  private readonly runtimeDefaults: Record<string, unknown>

  /**
   * Canonical key/value collections — declared with a `(id TEXT PK,
   * data TEXT NOT NULL)` schema at boot so existing JSON-blob rows
   * keep working through the structured path. Generates SQL identical
   * to the previous legacy path; only the routing is unified.
   */
  private static readonly CANONICAL_KV_COLLECTIONS: readonly string[] = [
    'system-settings',
    'addon-settings',
    'addon-device-settings',
    'device-runtime-state',
  ]

  // Domain schemas (auth, analytics events, …) live in the addons that
  // own them — same pattern as `pipeline-analytics` (`event-store.ts`,
  // `track-store.ts`, `media-store.ts`) and `local-auth` (`auth-schema.ts`).
  // The backend exposes `declareCollection` and stays out of domain
  // knowledge.

  /**
   * Optional, because the engine is constructed in places that have no addon
   * context (migrations, one-shot tools, most specs). It is NOT optional in
   * production: `sqlite-settings.addon.ts` passes one, and without it a row cap
   * being hit would be silent — which is the failure mode the cap exists to
   * avoid replacing.
   */
  private readonly logger: IScopedLogger | undefined

  /**
   * Per-statement timing. Absent only where the backend is constructed without
   * a logger (migrations, one-shot tools, most specs) — production always has
   * one, because a runner that stalls with no record of what it was executing
   * is the failure this was built for (`query-profiler.ts`).
   */
  private readonly profiler: SqliteOpProfiler | undefined

  private readonly options: Required<SqliteSettingsBackendOptions>

  constructor(
    private readonly dbPath: string,
    runtimeDefaults?: Record<string, unknown>,
    logger?: IScopedLogger,
    options?: SqliteSettingsBackendOptions,
  ) {
    this.runtimeDefaults = runtimeDefaults ?? {}
    this.logger = logger
    this.options = {
      databaseId: options?.databaseId ?? 'settings',
      autoVacuum: options?.autoVacuum ?? 'none',
      canonicalKv: options?.canonicalKv ?? true,
    }
    this.profiler =
      logger === undefined
        ? undefined
        : new SqliteOpProfiler({
            logger: logger.child('Profile'),
            // Bound to THIS backend, so the plan is read off the same
            // connection that ran the statement — a second handle can see a
            // different `sqlite_stat1` and produce a plan nobody executed.
            explain: (sql, params) => this.explainQueryPlan(sql, params),
          })
  }

  async initialize(): Promise<void> {
    // Ensure parent directory exists
    const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'))
    if (dir) {
      const fs = await import('node:fs')
      fs.mkdirSync(dir, { recursive: true })
    }
    const existedBefore = existsSync(this.dbPath)
    this.db = new Database(this.dbPath)
    // Fixed when the FIRST table is written, so it is set before anything is:
    // only on a file this open creates (see `SqliteSettingsBackendOptions`).
    if (this.options.autoVacuum === 'incremental' && !existedBefore) {
      this.db.pragma('auto_vacuum = INCREMENTAL')
    }
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    // Cache and mmap are DERIVED from the file that is actually on disk, not
    // from a constant: the previous constants were sized for a 130 MB database
    // and the live one reached 858 MB, at which point 70% of it was outside the
    // map and every page in that 70% cost a synchronous `pread64` on the single
    // thread the whole cluster reads configuration through. The evidence, and
    // the floors and ceilings, are in `sqlite-pragmas.ts` — including why
    // `synchronous` is NOT set here.
    const dbSizeBytes = this.measureDbSizeBytes()
    const pageCacheKib = sqlitePageCacheKibFor(dbSizeBytes)
    const mmapSizeBytes = sqliteMmapSizeFor(dbSizeBytes)
    this.db.pragma(`cache_size = ${pageCacheKib}`)
    this.db.pragma(`mmap_size = ${mmapSizeBytes}`)
    this.db.pragma(`journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`)
    // The checkpoint is the worker's job (`wal-checkpointer.ts`); this
    // connection's own auto-checkpoint is raised to a BOUND that only fires
    // if the worker is gone. See `sqlite-pragmas.ts` for the number.
    this.db.pragma(`wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES}`)
    // The sizing is only defensible if it is visible: a map that silently
    // stopped covering the file is exactly the failure this replaced, and a
    // number nobody can read from a log is a number nobody notices expiring.
    // Occupancy answers the question `dbSizeMb` cannot: a file that stopped
    // growing may be full of rows or may be mostly freelist waiting for a
    // VACUUM, and only one of those two is a retention problem.
    const occupancy = sqliteOccupancy({
      pageCount: this.readPragmaNumber('page_count'),
      freelistCount: this.readPragmaNumber('freelist_count'),
      pageSizeBytes: this.readPragmaNumber('page_size'),
    })
    this.logger?.info('sqlite connection sized from the database on disk', {
      meta: {
        dbSizeMb: Math.round(dbSizeBytes / 1_048_576),
        pageCacheMb: Math.round(Math.abs(pageCacheKib) / 1024),
        mmapMb: Math.round(mmapSizeBytes / 1_048_576),
        mapsWholeFile: mmapSizeBytes >= dbSizeBytes,
        liveMb: occupancy.liveMb,
        freeMb: occupancy.freeMb,
        freePct: occupancy.freePct,
      },
    })

    this.scheduleStorageReport(dbSizeBytes)
    this.scheduleMapGrowthCheck(mmapSizeBytes)
    this.scheduleIndexAnalysis()

    // Arm the statement profiler before the first statement runs: boot is
    // itself a busy window (`ensureTable` x9, the retired-key purge, the
    // vector registry), and a profiler started afterwards cannot describe it.
    this.profiler?.start()

    // Declare canonical KV collections so set/get/insert/update/query
    // reach the structured path uniformly. Schema is the same shape
    // legacy created on demand — `(id TEXT PK, data TEXT NOT NULL)` —
    // so existing rows continue to work with no migration.
    const canonical = this.options.canonicalKv ? SqliteSettingsBackend.CANONICAL_KV_COLLECTIONS : []
    for (const collection of canonical) {
      await this.ensureTable(collection, {
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
          { name: 'data', type: 'TEXT', notNull: true },
        ],
      })
      this.declaredCollections.set(collection, {
        primaryKey: 'id',
        columns: new Set(['data']),
        booleanColumns: new Set(),
        autoPrimaryKey: false,
        keyColumns: [],
      })
    }

    // Everything an addon declared in a PREVIOUS life of this process. Must
    // run before the first read: on a respawn no addon re-declares, because
    // they are all still up and each declared once at its own boot (D468).
    this.restorePersistedDeclarations()

    // Seed system-settings on first boot (settings only: the other files
    // have no canonical collections).
    if (this.options.canonicalKv) {
      const isEmpty = await this.isEmpty({ collection: 'system-settings' })
      if (isEmpty) {
        await this.seedDefaults()
      }
    }
  }

  /**
   * The declaration a READ needs, or `null` when the table does not exist.
   *
   * A per-addon scoped canonical table (`<addonId>:addon-settings`, ...) is
   * auto-declared on first use, and that used to include a READ: asking
   * `count` or `get` about a scoped name that was never written CREATED the
   * table. A read of a table nobody wrote is "absent" (D870), and creating an
   * empty table per probed name is how an enumeration litters the database.
   */
  private declaredForRead(scoped: string): DeclaredCollection | null {
    const cached = this.declaredCollections.get(scoped)
    if (cached) return cached
    const colonIdx = scoped.indexOf(':')
    const base = colonIdx > 0 ? scoped.slice(colonIdx + 1) : ''
    const scopedCanonical =
      colonIdx > 0 &&
      this.options.canonicalKv &&
      (SqliteSettingsBackend.CANONICAL_KV_COLLECTIONS.includes(base) ||
        SqliteSettingsBackend.LEGACY_SCOPED_KV_COLLECTIONS.includes(base))
    if (scopedCanonical) {
      if (!this.hasTable(scoped)) return null
      if (SqliteSettingsBackend.LEGACY_SCOPED_KV_COLLECTIONS.includes(base)) {
        return this.declareLegacyScopedKv(scoped)
      }
    }
    return this.requireDeclared(scoped)
  }

  /**
   * Per-addon tables the runner used to keep (`<addonId>:addon-devices`, D870).
   * Nothing writes them any more; they stay READABLE, by their old name, until
   * the migration's drop phase removes them.
   */
  private static readonly LEGACY_SCOPED_KV_COLLECTIONS: readonly string[] = [
    'addon-devices',
    'sections',
  ]

  private declareLegacyScopedKv(scoped: string): DeclaredCollection {
    const decl = {
      primaryKey: 'id',
      columns: new Set(['data']),
      booleanColumns: new Set<string>(),
      autoPrimaryKey: false,
      keyColumns: [],
    }
    this.declaredCollections.set(scoped, decl)
    return decl
  }

  private requireDeclared(scoped: string): DeclaredCollection {
    const cached = this.declaredCollections.get(scoped)
    if (cached) return cached
    // Auto-declare a per-addon scoped variant of a canonical KV collection
    // (`<addonId>:addon-settings`, `<addonId>:addon-devices`, …). The
    // factory's `ctx.settings.writeAddonStore` now passes
    // `namespace: addonId`, which `scopedName` resolves to
    // `<addonId>:addon-settings` — a table that was NEVER declared at
    // boot and used to throw "is not declared" here. The shape mirrors
    // the parent canonical collection exactly (`(id TEXT PK, data TEXT NOT NULL)`),
    // so reusing the same schema keeps set/get/insert/update/query
    // structurally identical to the legacy unscoped path. Anything
    // outside the canonical set still fails fast — callers MUST
    // `declareCollection` for typed schemas.
    const colonIdx = scoped.indexOf(':')
    if (colonIdx > 0) {
      const baseCollection = scoped.slice(colonIdx + 1)
      if (
        this.options.canonicalKv &&
        SqliteSettingsBackend.CANONICAL_KV_COLLECTIONS.includes(baseCollection)
      ) {
        this.getDb().exec(
          `CREATE TABLE IF NOT EXISTS "${scoped}" ` +
            '(id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)',
        )
        const decl = {
          primaryKey: 'id',
          columns: new Set(['data']),
          booleanColumns: new Set<string>(),
          autoPrimaryKey: false,
          keyColumns: [],
        }
        this.declaredCollections.set(scoped, decl)
        return decl
      }
    }
    throw new Error(
      `SqliteSettingsBackend: collection "${scoped}" is not declared. Call declareCollection() first or add it to CANONICAL_KV_COLLECTIONS.`,
    )
  }

  /**
   * Decode a single column value off a SQLite row into the JS shape the
   * caller's schema expects. Handles:
   *   - BOOLEAN columns: `0|1` → `false|true`
   *   - JSON columns (TEXT starting with `{` / `[`): parse
   *   - everything else: pass-through with null coalescing
   */
  private decodeColumnValue(
    value: unknown,
    columnName: string,
    booleanColumns: ReadonlySet<string>,
  ): unknown {
    if (booleanColumns.has(columnName)) {
      if (value === null || value === undefined) return value ?? null
      return value !== 0 && value !== '0' && value !== false
    }
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }
    return value ?? null
  }

  async shutdown(): Promise<void> {
    // Report the last window BEFORE the handle closes. A runner is most often
    // shut down because it was misbehaving; discarding the window that
    // describes the misbehaviour is the one report worth keeping.
    this.profiler?.report()
    this.profiler?.stop()
    this.db?.close()
    this.db = null
  }

  /**
   * The statement profiler, so an addon sharing this handle (the sqlite-vec
   * index) reports into the SAME window. Two profilers on one thread would
   * each describe a fraction of the stall and neither would add up to it.
   */
  getProfiler(): SqliteOpProfiler | undefined {
    return this.profiler
  }

  // ---------------------------------------------------------------------------
  // ISettingsBackend implementation
  // ---------------------------------------------------------------------------

  /**
   * `data-store-provider` self-description — how the orchestrator names
   * this engine in a log line, and (once collections declare an engine)
   * how it picks between registrants.
   */
  async getEngineInfo(): Promise<DataStoreEngineInfo> {
    return {
      engineId: 'sqlite',
      kind: 'relational',
      displayName: 'SQLite (WAL)',
    }
  }

  async get({ namespace, collection, key }: SettingsGetInput): Promise<unknown> {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.declaredForRead(scoped)
    if (decl === null) return undefined
    this.requireSingleKey(scoped, decl, 'get')
    // Canonical KV collections store the value as a single `data`
    // JSON-blob column; their declared columns are exactly `['data']`
    // so we read it back, parse, and return. Structured collections
    // (multi-column) return the row map untouched.
    const cols = [`"${decl.primaryKey}"`, ...[...decl.columns].map((c) => `"${c}"`)].join(', ')
    const row = this.measured({ op: 'get', collection: scoped }, () =>
      this.getDb()
        .prepare<[string], Record<string, unknown>>(
          `SELECT ${cols} FROM "${scoped}" WHERE "${decl.primaryKey}" = ?`,
        )
        .get(key),
    )
    if (!row) return undefined
    if (decl.columns.size === 1 && decl.columns.has('data')) {
      const raw = row['data']
      return typeof raw === 'string' ? JSON.parse(raw) : raw
    }
    const data: Record<string, unknown> = {}
    for (const c of decl.columns) {
      data[c] = this.decodeColumnValue(row[c], c, decl.booleanColumns)
    }
    return data
  }

  async set({ namespace, collection, key, value }: SettingsSetInput): Promise<void> {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    this.requireSingleKey(scoped, decl, 'set')
    // Build the column row. KV-shape collections (`['data']`) store
    // `value` as a JSON blob in `data`; structured collections
    // destructure `value` into its declared columns.
    const row: Record<string, unknown> = { [decl.primaryKey]: key }
    if (decl.columns.size === 1 && decl.columns.has('data')) {
      row['data'] = JSON.stringify(value)
    } else {
      const valueObj = (value !== null && typeof value === 'object' ? value : {}) as Record<
        string,
        unknown
      >
      for (const [k, v] of Object.entries(valueObj)) {
        if (decl.columns.has(k)) row[k] = this.serializeColumnValue(v)
      }
    }
    const keys = Object.keys(row)
    const cols = keys.map((k) => `"${k}"`).join(', ')
    const placeholders = keys.map(() => '?').join(', ')
    const updates = keys
      .filter((k) => k !== decl.primaryKey)
      .map((k) => `"${k}" = excluded."${k}"`)
      .join(', ')
    const values = keys.map((k) => row[k])
    const sql =
      updates.length > 0
        ? `INSERT INTO "${scoped}" (${cols}) VALUES (${placeholders}) ON CONFLICT("${decl.primaryKey}") DO UPDATE SET ${updates}`
        : `INSERT INTO "${scoped}" (${cols}) VALUES (${placeholders}) ON CONFLICT("${decl.primaryKey}") DO NOTHING`
    this.measured({ op: 'set', collection: scoped }, () =>
      this.getDb()
        .prepare(sql)
        .run(...values),
    )
  }

  async query<T extends object = Record<string, unknown>>({
    namespace,
    collection,
    filter,
    columns,
  }: SettingsQueryInput): Promise<readonly SettingsRecord<T>[]> {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.declaredForRead(scoped)
    if (decl === null) return []
    return this.queryDeclared<T>(scoped, decl, filter, columns)
  }

  async insert<T extends object = Record<string, unknown>>({
    namespace,
    collection,
    record,
  }: SettingsInsertInput<T>): Promise<{ readonly id: string | number }> {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    this.requireSingleKey(scoped, decl, 'insert')
    // The primary key is supplied ONLY when this collection needs one. On an
    // INTEGER rowid alias the column is omitted outright so SQLite assigns it
    // — the same rule `insertMany` has always applied, forty lines below.
    //
    // It was missing here, and silently: `record.id || randomUUID()` bound a
    // 36-character UUID to an INTEGER key, which SQLite's affinity cannot
    // convert, so it was stored AS TEXT and that row stopped being a rowid
    // alias. Nothing caught it because nothing used `autoPrimaryKey` yet — and
    // `pipeline-analytics` inserts its events one at a time, through here.
    const suppliedOrMinted = decl.autoPrimaryKey ? null : record.id || randomUUID()
    const row: Record<string, unknown> = decl.autoPrimaryKey
      ? {}
      : { [decl.primaryKey]: suppliedOrMinted }
    if (decl.columns.size === 1 && decl.columns.has('data')) {
      row['data'] = JSON.stringify(record.data)
    } else {
      for (const [k, v] of Object.entries(record.data)) {
        if (decl.columns.has(k)) row[k] = this.serializeColumnValue(v)
      }
    }
    const rowid = await this.tableInsert(scoped, row)
    // The id the row ACTUALLY got: a supplied or minted key, or the rowid
    // SQLite assigned — which is the only place an auto key is knowable.
    return { id: suppliedOrMinted ?? Number(rowid) }
  }

  /**
   * Make a SLOT hold this row, and answer with the id the row HAS — one
   * statement, `INSERT … ON CONFLICT(<slot>) DO UPDATE … RETURNING <pk>`.
   *
   * See `settings-store.cap.ts`'s `upsert` docblock for why the store needed a
   * slot that is not the primary key (D482). Three things are load-bearing
   * here:
   *
   *  - **`RETURNING` and not `lastInsertRowid`.** On the UPDATE branch
   *    `lastInsertRowid` is whatever the connection last inserted — a
   *    different row, or a different TABLE. It answers confidently and wrongly,
   *    which is worse than not answering. `RETURNING` names the row this
   *    statement actually touched, on both branches.
   *  - **The conflict columns are checked against the declaration** before they
   *    reach the SQL. An undeclared name would be interpolated into DDL-shaped
   *    text; it is refused, by the same rule and for the same reason
   *    {@link resolveProjection} throws on an unprojectable column.
   *  - **The primary key is never part of the SET list.** An `INTEGER` rowid
   *    alias is not in `row` at all, and on a TEXT key rewriting the id of the
   *    row we just matched is the one update that cannot be right.
   */
  async upsert<T extends object = Record<string, unknown>>({
    namespace,
    collection,
    conflict,
    record,
  }: SettingsUpsertInput<T>): Promise<{ readonly id: string | number }> {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    this.requireSingleKey(scoped, decl, 'upsert')
    if (conflict.length === 0) {
      throw new UnprojectableColumnError(
        `upsert on "${scoped}" was given an EMPTY conflict target — "ON CONFLICT()" is not valid SQL, and "no slot, just insert" is insert()`,
      )
    }
    const unknownCols = conflict.filter(
      (name) => !decl.columns.has(name) && name !== decl.primaryKey,
    )
    if (unknownCols.length > 0) {
      throw new UnprojectableColumnError(
        `upsert on "${scoped}" names conflict column(s) the collection does not declare: ${unknownCols.join(', ')}`,
      )
    }

    // Same id discipline as `insert`: omitted outright on an INTEGER rowid
    // alias so SQLite assigns it; supplied or minted otherwise.
    const suppliedOrMinted = decl.autoPrimaryKey ? null : record.id || randomUUID()
    const row: Record<string, unknown> = decl.autoPrimaryKey
      ? {}
      : { [decl.primaryKey]: suppliedOrMinted }
    if (decl.columns.size === 1 && decl.columns.has('data')) {
      row['data'] = JSON.stringify(record.data)
    } else {
      for (const [k, v] of Object.entries(record.data)) {
        if (decl.columns.has(k)) row[k] = this.serializeColumnValue(v)
      }
    }

    const keys = Object.keys(row)
    const cols = keys.map((k) => `"${k}"`).join(', ')
    const placeholders = keys.map(() => '?').join(', ')
    const target = conflict.map((k) => `"${k}"`).join(', ')
    const updates = keys
      .filter((k) => k !== decl.primaryKey && !conflict.includes(k))
      .map((k) => `"${k}" = excluded."${k}"`)
    // A row whose every non-slot column IS a slot column has nothing to
    // update; `DO UPDATE SET` with an empty list is a syntax error, and
    // `DO NOTHING` would return no row at all — so the update is a no-op that
    // still returns: set the first slot column to the value it already has.
    const setList =
      updates.length > 0 ? updates.join(', ') : `"${conflict[0]}" = excluded."${conflict[0]}"`
    const sql = `INSERT INTO "${scoped}" (${cols}) VALUES (${placeholders}) ON CONFLICT(${target}) DO UPDATE SET ${setList} RETURNING "${decl.primaryKey}"`
    const values = keys.map((k) => row[k] ?? null)
    const returned = this.measured({ op: 'upsert', collection: scoped, sql, params: values }, () =>
      this.getDb()
        .prepare(sql)
        .get(...values),
    ) as Record<string, unknown> | undefined
    const id = returned?.[decl.primaryKey]
    if (typeof id === 'number' || typeof id === 'bigint') return { id: Number(id) }
    if (typeof id === 'string') return { id }
    // `RETURNING` on an upsert always yields the row it wrote. Nothing coming
    // back means the statement matched no branch, which a caller must not read
    // as "written under some id it can guess".
    throw new Error(
      `upsert on "${scoped}" returned no row — the ON CONFLICT target (${target}) resolved to no unique index, or the write was rejected`,
    )
  }

  /**
   * Insert a batch in ONE transaction, on ONE prepared statement.
   *
   * The write-side twin of {@link deleteWhere}. Every row in the batch shares
   * a single column list, which is what makes one `prepare` legal: rows are
   * normalised to the collection's DECLARED column set, so a row that omits a
   * column binds `null` for it rather than producing a second statement shape.
   *
   * All or nothing — `better-sqlite3`'s `transaction()` rolls the whole batch
   * back on any throw. A caller writing one process sample gets one COMMIT,
   * which is the entire point: 76 rows every 10 s is 7.6 rows/s, and 7.6
   * separate commits per second on the connection that also serves every
   * cluster-wide configuration read is a constant load nobody asked for.
   */
  async insertMany({
    namespace,
    collection,
    records,
  }: SettingsInsertManyInput): Promise<SettingsInsertManyResult> {
    return this.insertManySync(namespace, collection, records)
  }

  /** The synchronous body of {@link insertMany}, shared with {@link transact}. */
  private insertManySync(
    namespace: string | undefined,
    collection: string,
    records: readonly BulkRecord[],
  ): SettingsInsertManyResult {
    if (records.length === 0) return { inserted: 0 }
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    const isKvShape = decl.columns.size === 1 && decl.columns.has('data')

    // ONE column list for the whole batch. The primary key is included only
    // when this collection needs a supplied one — on an INTEGER rowid alias it
    // is omitted outright so SQLite assigns it.
    const dataColumns = [...decl.columns]
    const composite = decl.keyColumns.length > 0
    const keys = decl.autoPrimaryKey || composite ? dataColumns : [decl.primaryKey, ...dataColumns]
    const cols = keys.map((k) => `"${k}"`).join(', ')
    const placeholders = keys.map(() => '?').join(', ')
    const sql = `INSERT INTO "${scoped}" (${cols}) VALUES (${placeholders})`

    const batch: unknown[][] = records.map((record) => {
      const row: Record<string, unknown> = {}
      if (isKvShape) {
        row['data'] = JSON.stringify(record.data)
      } else {
        for (const [k, v] of Object.entries(record.data)) {
          if (decl.columns.has(k)) row[k] = this.serializeColumnValue(v)
        }
      }
      if (!decl.autoPrimaryKey && !composite) row[decl.primaryKey] = record.id || randomUUID()
      return keys.map((k) => row[k] ?? null)
    })

    const db = this.getDb()
    const stmt = db.prepare(sql)
    const run = db.transaction((rows: readonly unknown[][]) => {
      for (const row of rows) stmt.run(...row)
    })
    this.measured({ op: 'insertMany', collection: scoped, sql, params: batch[0] ?? [] }, () =>
      run(batch),
    )
    return { inserted: batch.length }
  }

  /**
   * Upsert a batch in ONE transaction, on ONE prepared statement.
   *
   * {@link upsert}'s batch twin: `INSERT … ON CONFLICT(<slot>) DO UPDATE`. One
   * statement shape means every record must name the SAME declared columns and
   * every `conflict` column — a record that mentioned fewer would otherwise
   * bind NULL over a value the caller never meant to touch, so a heterogeneous
   * batch is refused whole, before any SQL runs.
   */
  async upsertMany({
    namespace,
    collection,
    conflict,
    records,
  }: SettingsUpsertManyInput): Promise<SettingsUpsertManyResult> {
    return this.upsertManySync(namespace, collection, conflict, records)
  }

  /** The synchronous body of {@link upsertMany}, shared with {@link transact}. */
  private upsertManySync(
    namespace: string | undefined,
    collection: string,
    conflict: readonly string[],
    records: readonly BulkRecord[],
  ): SettingsUpsertManyResult {
    if (records.length === 0) return { upserted: 0 }
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    if (conflict.length === 0) {
      throw new UnprojectableColumnError(
        `upsertMany on "${scoped}" was given an EMPTY conflict target — "ON CONFLICT()" is not valid SQL, and "no slot, just insert" is insertMany()`,
      )
    }
    const unknownCols = conflict.filter(
      (name) => !decl.columns.has(name) && name !== decl.primaryKey,
    )
    if (unknownCols.length > 0) {
      throw new UnprojectableColumnError(
        `upsertMany on "${scoped}" names conflict column(s) the collection does not declare: ${unknownCols.join(', ')}`,
      )
    }
    const composite = decl.keyColumns.length > 0
    const isKvShape = decl.columns.size === 1 && decl.columns.has('data')
    // The column list is the first record's declared columns; every other
    // record must match it exactly.
    const first = records[0]
    if (first === undefined) return { upserted: 0 }
    const dataKeys = isKvShape
      ? ['data']
      : Object.keys(first.data)
          .filter((k) => decl.columns.has(k))
          .sort()
    const missingConflict = conflict.filter((c) => c !== decl.primaryKey && !dataKeys.includes(c))
    if (missingConflict.length > 0) {
      throw new UnprojectableColumnError(
        `upsertMany on "${scoped}": the records do not carry conflict column(s) ${missingConflict.join(', ')}`,
      )
    }
    const supplyId = !decl.autoPrimaryKey && !composite
    const keys = supplyId ? [decl.primaryKey, ...dataKeys] : dataKeys
    const batch: unknown[][] = records.map((record, index) => {
      const row: Record<string, unknown> = {}
      if (isKvShape) {
        row['data'] = JSON.stringify(record.data)
      } else {
        const named = Object.keys(record.data)
          .filter((k) => decl.columns.has(k))
          .sort()
        if (named.length !== dataKeys.length || named.some((k, i) => k !== dataKeys[i])) {
          throw new UnprojectableColumnError(
            `upsertMany on "${scoped}": record ${index} names different columns than record 0 — a batch is one statement shape, and binding NULL over an omitted column would erase it; send homogeneous records`,
          )
        }
        for (const k of dataKeys) row[k] = this.serializeColumnValue(record.data[k])
      }
      if (supplyId) row[decl.primaryKey] = record.id || randomUUID()
      return keys.map((k) => row[k] ?? null)
    })
    const cols = keys.map((k) => `"${k}"`).join(', ')
    const placeholders = keys.map(() => '?').join(', ')
    const target = conflict.map((k) => `"${k}"`).join(', ')
    const updates = keys
      .filter((k) => k !== decl.primaryKey && !conflict.includes(k))
      .map((k) => `"${k}" = excluded."${k}"`)
    const setList =
      updates.length > 0 ? updates.join(', ') : `"${conflict[0]}" = excluded."${conflict[0]}"`
    const sql = `INSERT INTO "${scoped}" (${cols}) VALUES (${placeholders}) ON CONFLICT(${target}) DO UPDATE SET ${setList}`
    const db = this.getDb()
    const stmt = db.prepare(sql)
    const run = db.transaction((rows: readonly unknown[][]) => {
      for (const row of rows) stmt.run(...row)
    })
    this.measured({ op: 'upsertMany', collection: scoped, sql, params: batch[0] ?? [] }, () =>
      run(batch),
    )
    return { upserted: batch.length }
  }

  /**
   * Several writes, one transaction, behind an optional guard.
   *
   * `better-sqlite3`'s `transaction()` is synchronous and rolls the whole call
   * back on any throw, so the guard read and every op below share one
   * isolation window: nothing can write between the check and the writes. A
   * failed guard returns before the first op — nothing was written, and the
   * value found comes back so the caller can name the conflict.
   */
  async transact({
    namespace,
    guard,
    ops,
  }: SettingsTransactInput): Promise<SettingsTransactResult> {
    const db = this.getDb()
    const run = db.transaction((): SettingsTransactResult => {
      if (guard !== undefined) {
        const scoped = this.scopedName(namespace, guard.collection)
        const decl = this.requireDeclared(scoped)
        this.requireSingleKey(scoped, decl, 'transact guard')
        if (!decl.columns.has(guard.column)) {
          throw new Error(`transact guard: "${guard.column}" is not a column of ${scoped}`)
        }
        const row = db
          .prepare<[string], Record<string, unknown>>(
            `SELECT "${guard.column}" AS v FROM "${scoped}" WHERE "${decl.primaryKey}" = ?`,
          )
          .get(guard.key)
        const current =
          row === undefined
            ? undefined
            : this.decodeColumnValue(row['v'], guard.column, decl.booleanColumns)
        if (row === undefined || current !== guard.equals) return { applied: false, current }
      }
      for (const op of ops) {
        if (op.op === 'deleteWhere') {
          this.deleteWhereSync(namespace, op.collection, op.filter)
        } else if (op.op === 'insertMany') {
          this.insertManySync(namespace, op.collection, op.records)
        } else if (op.op === 'upsertMany') {
          this.upsertManySync(namespace, op.collection, op.conflict, op.records)
        } else {
          this.updateByIdSync(namespace, op.collection, op.id, op.data)
        }
      }
      return { applied: true }
    })
    return this.measured({ op: 'transact', collection: 'transact' }, () => run())
  }

  async update({ namespace, collection, id, data }: SettingsUpdateInput): Promise<void> {
    this.updateByIdSync(namespace, collection, id, data)
  }

  /** The synchronous body of {@link update}, shared with {@link transact}. */
  private updateByIdSync(
    namespace: string | undefined,
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): void {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    this.requireSingleKey(scoped, decl, 'update')
    const updates: Record<string, unknown> = {}
    if (decl.columns.size === 1 && decl.columns.has('data')) {
      updates['data'] = JSON.stringify(data)
    } else {
      for (const [k, v] of Object.entries(data)) {
        if (decl.columns.has(k)) updates[k] = this.serializeColumnValue(v)
      }
    }
    const entries = Object.entries(updates)
    if (entries.length === 0) return
    const setClauses = entries.map(([k]) => `"${k}" = ?`)
    const setValues = entries.map(([, v]) =>
      typeof v === 'object' && v !== null ? JSON.stringify(v) : v,
    )
    this.getDb()
      .prepare(`UPDATE "${scoped}" SET ${setClauses.join(', ')} WHERE "${decl.primaryKey}" = ?`)
      .run(...setValues, id)
  }

  async delete({ namespace, collection, key }: SettingsDeleteInput): Promise<void> {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    this.requireSingleKey(scoped, decl, 'delete')
    await this.tableDelete(scoped, { [decl.primaryKey]: key })
  }

  /**
   * Bulk delete. One statement, whatever the row count — this is what every
   * retention path in the system was hand-rolling as a select-then-delete
   * loop. The filter is compiled in `mutate` mode, so an unresolvable
   * predicate or an empty one throws before any SQL exists.
   */
  async deleteWhere({
    namespace,
    collection,
    filter,
  }: SettingsDeleteWhereInput): Promise<SettingsDeleteWhereResult> {
    return this.deleteWhereSync(namespace, collection, filter)
  }

  /** The synchronous body of {@link deleteWhere}, shared with {@link transact}. */
  private deleteWhereSync(
    namespace: string | undefined,
    collection: string,
    filter: MutationFilterInput,
  ): SettingsDeleteWhereResult {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    const { whereSql, params } = compileFilter(filter, this.shapeOf(decl), 'mutate', (v) =>
      this.serializeColumnValue(v),
    )
    const deleteSql = `DELETE FROM "${scoped}"${whereSql}`
    const result = this.measured(
      { op: 'deleteWhere', collection: scoped, sql: deleteSql, params },
      () =>
        this.getDb()
          .prepare(deleteSql)
          .run(...params),
    )
    return { deleted: result.changes }
  }

  /**
   * Bulk update. Same filter contract as {@link deleteWhere}.
   *
   * Every key of `data` must be a REAL column. A KV-shaped collection keeps
   * its fields inside a JSON blob, and setting one would need `json_set` with
   * read-modify-write semantics this method does not have — so it refuses
   * rather than writing a column that does not exist, which is what the
   * uncapped `tableUpdate` would have done.
   */
  async updateWhere({
    namespace,
    collection,
    filter,
    data,
  }: SettingsUpdateWhereInput): Promise<SettingsUpdateWhereResult> {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    const setClauses: string[] = []
    const setValues: unknown[] = []
    for (const [key, value] of Object.entries(data)) {
      if (key !== decl.primaryKey && !decl.columns.has(key)) {
        throw new UnsafeFilterError(
          `updateWhere cannot set "${key}" on "${scoped}" — it is not a column of this collection`,
        )
      }
      setClauses.push(`"${key}" = ?`)
      setValues.push(this.serializeColumnValue(value))
    }
    if (setClauses.length === 0) {
      throw new UnsafeFilterError('updateWhere was given no fields to set')
    }
    const { whereSql, params } = compileFilter(filter, this.shapeOf(decl), 'mutate', (v) =>
      this.serializeColumnValue(v),
    )
    const updateSql = `UPDATE "${scoped}" SET ${setClauses.join(', ')}${whereSql}`
    const result = this.measured(
      { op: 'updateWhere', collection: scoped, sql: updateSql, params: [...setValues, ...params] },
      () =>
        this.getDb()
          .prepare(updateSql)
          .run(...setValues, ...params),
    )
    return { updated: result.changes }
  }

  /**
   * How many rows match — about the SAME rows {@link query} would return.
   *
   * That agreement is the entire contract, and until now it did not hold. This
   * was the FOURTH hand-rolled copy of the filter logic (after `query`, the
   * bulk mutations and `histogram`) and it compiled only `where`:
   * `whereBetween`, `whereIn` and `whereNot` were dropped silently, so the
   * count was not slow, it was WRONG, and always wrong in the same direction —
   * too big, because every dropped predicate is a predicate that would have
   * excluded rows.
   *
   * Two live callers decided on it. `TrackStore.countStaging({ deviceId,
   * olderThanMs })` sends the cutoff as `whereBetween: { lastSeen: [0, …] }`
   * and got the device's whole staging history instead. The notification-centre
   * artefact gallery pages on `total` from this method while listing through
   * `query`, and its filter is almost entirely `whereIn`/`whereBetween`
   * (visibility, kind, device, time window, expiry) — so `total` counted rows
   * the page could never show, including other users'.
   *
   * `measure` mode. `count` compiles the same predicates `query` does — the
   * two must never disagree about WHICH rows they are talking about — but it
   * refuses a predicate it cannot express rather than skipping it. `query`
   * hands back rows and a caller can see the filter did not bite; a count
   * hands back a number, and the whole collection and the intended subset are
   * the same shape.
   */
  async count({ namespace, collection, filter }: SettingsCountInput): Promise<number> {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.declaredForRead(scoped)
    if (decl === null) return 0
    const { whereSql, params } = compileFilter(filter, this.shapeOf(decl), 'measure', (v) =>
      this.serializeColumnValue(v),
    )
    const sql = `SELECT COUNT(*) AS cnt FROM "${scoped}"${whereSql}`
    const row = this.measured({ op: 'count', collection: scoped, sql, params }, () =>
      this.getDb()
        .prepare<unknown[], { cnt: number }>(sql)
        .get(...params),
    )
    return row?.cnt ?? 0
  }

  /**
   * `COUNT(*)` and one SUM/MIN/MAX per requested field, in ONE statement.
   *
   * Result slots are aliased POSITIONALLY (`a0`, `a1`, …) and mapped back by
   * index: `as` is caller text and must never reach SQL as an identifier, and
   * the column name is validated through {@link fieldExprFor} exactly like a
   * projection — an unresolvable field THROWS rather than being dropped, because
   * a missing aggregate comes back as a number that looks real.
   *
   * `measure` mode on the filter, so this agrees with `query` and `count`
   * about which rows it is talking about — and, since 2026-08-30, refuses an
   * unresolvable PREDICATE for the same reason it already refused an
   * unresolvable FIELD. Both come back as a number that looks real.
   */
  async aggregate({
    namespace,
    collection,
    fields,
    filter,
  }: SettingsAggregateInput): Promise<SettingsAggregateResult> {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    const shape = this.shapeOf(decl)
    const selects: string[] = ['COUNT(*) AS "n"']
    fields.forEach((f, i) => {
      const col = fieldExprFor(f.field, shape)
      if (col === null) {
        throw new UnsafeFilterError(
          `aggregate cannot read "${f.field}" on "${scoped}" — it is not a column of this collection, and answering without it would return a number that looks real`,
        )
      }
      selects.push(`${f.op.toUpperCase()}(${col}) AS "a${i}"`)
    })
    const { whereSql, params } = compileFilter(filter, shape, 'measure', (v) =>
      this.serializeColumnValue(v),
    )
    const sql = `SELECT ${selects.join(', ')} FROM "${scoped}"${whereSql}`
    const row = this.measured({ op: 'aggregate', collection: scoped, sql, params }, () =>
      this.getDb()
        .prepare<unknown[], Record<string, number | null>>(sql)
        .get(...params),
    )
    const values: Record<string, number | null> = {}
    fields.forEach((f, i) => {
      const raw = row?.[`a${i}`]
      values[f.as] = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    })
    return { count: row?.['n'] ?? 0, values }
  }

  async histogram({
    namespace,
    collection,
    field,
    bucketSize,
    origin,
    filter,
  }: SettingsHistogramInput): Promise<readonly HistogramBucket[]> {
    const scoped = this.scopedName(namespace, collection)
    const decl = this.requireDeclared(scoped)
    const shape = this.shapeOf(decl)
    const col = fieldExprFor(field, shape)
    if (col === null) return []
    // Was a third hand-rolled copy of the filter logic — and it silently
    // ignored `whereIn`, which `query` honours, so the same filter produced a
    // wider histogram than result set. One compiler, one behaviour.
    const { whereSql: where, params } = compileFilter(filter, shape, 'measure', (v) =>
      this.serializeColumnValue(v),
    )
    const bucketExpr = `CAST((${col} - ?) / ? AS INTEGER)`
    const sql = `SELECT ${bucketExpr} AS bucket, COUNT(*) AS count FROM "${scoped}"${where} GROUP BY bucket ORDER BY bucket`
    const rows = this.measured(
      { op: 'histogram', collection: scoped, sql, params: [origin, bucketSize, ...params] },
      () =>
        this.getDb()
          .prepare<unknown[], { bucket: number; count: number }>(sql)
          .all(origin, bucketSize, ...params),
    )
    return rows.map((r) => ({ bucket: r.bucket, count: r.count }))
  }

  async isEmpty({ namespace, collection }: SettingsIsEmptyInput): Promise<boolean> {
    const scoped = this.scopedName(namespace, collection)
    if (this.declaredForRead(scoped) === null) return true
    return (await this.tableCount(scoped)) === 0
  }

  private async queryDeclared<T extends object = Record<string, unknown>>(
    table: string,
    decl: {
      readonly primaryKey: string
      readonly columns: ReadonlySet<string>
      readonly booleanColumns: ReadonlySet<string>
      readonly keyColumns: readonly string[]
    },
    filter: import('@camstack/types').QueryFilter | undefined,
    projection?: readonly string[],
  ): Promise<readonly SettingsRecord<T>[]> {
    // KV-shape detection: a single `data` JSON-blob column. Canonical
    // collections (users, alerts, api-keys, …) and the catalogue of
    // "legacy" collections fall in this branch — the structured per-
    // column path is reserved for explicitly declared schemas.
    const isKvShape = decl.columns.size === 1 && decl.columns.has('data')
    const readColumns = resolveProjection(table, decl, isKvShape, projection)
    const composite = decl.keyColumns.length > 0
    // A composite collection has no id column: the key columns are ordinary
    // data columns, and the record's `id` is built from them below.
    const selected = composite
      ? [...new Set([...decl.keyColumns, ...readColumns])]
      : [decl.primaryKey, ...readColumns]
    const cols = selected.map((c) => `"${c}"`).join(', ')
    let sql = `SELECT ${cols} FROM "${table}"`
    const params: unknown[] = []
    const shape = this.shapeOf(decl)
    const compiled = compileFilter(filter, shape, 'select', (v) => this.serializeColumnValue(v))
    sql += compiled.whereSql
    params.push(...compiled.params)

    if (filter?.orderBy) {
      const expr = fieldExprFor(filter.orderBy.field, shape)
      if (expr !== null) {
        const dir = filter.orderBy.direction === 'desc' ? 'DESC' : 'ASC'
        sql += ` ORDER BY ${expr} ${dir}`
      }
    }
    /**
     * A `LIMIT` is ALWAYS appended — this is the fix for the 2026-08-07 OOM,
     * where the absent one let `Statement.all()` materialise a whole table into
     * V8 in a single call (`query-bounds.ts` has the evidence).
     *
     * One row MORE than the bound is fetched, deliberately. Without the
     * sentinel, "the result set was exactly the cap" and "the result set was
     * truncated at the cap" are the same observation, and the warning below
     * would either cry wolf on every full page or stay silent on real
     * truncation. The extra row is dropped before it reaches the caller.
     */
    const bound = resolveRowBound(filter?.limit)
    sql += ` LIMIT ?`
    params.push(bound.limit + 1)
    if (filter?.offset !== undefined) {
      sql += ` OFFSET ?`
      params.push(filter.offset)
    }

    const fetched = this.measured(
      {
        op: 'query',
        collection: table,
        sql,
        params,
        ...deviceIdOf(filter),
        ...scopeOwnerOf(filter),
      },
      () =>
        this.getDb()
          .prepare<unknown[], Record<string, unknown>>(sql)
          .all(...params),
    )
    const truncated = fetched.length > bound.limit
    const rows = truncated ? fetched.slice(0, bound.limit) : fetched
    if (truncated && isImposedBound(bound.source)) {
      /**
       * WARN, not debug: the caller believes it read the whole collection and
       * is about to act on that belief. A retention sweep that sees 5 000 of
       * 40 000 rows deletes 5 000 and reports success.
       */
      this.logger?.warn('settings-store query truncated by a defensive row cap', {
        ...deviceTagOf(filter),
        meta: {
          collection: table,
          rowCap: bound.limit,
          boundSource: bound.source,
          requestedLimit: filter?.limit ?? null,
          hasWhere: filter?.where !== undefined,
          hasWhereIn: filter?.whereIn !== undefined,
          hasWhereBetween: filter?.whereBetween !== undefined,
          remedy: 'page with limit + offset, or narrow the filter',
        },
      })
    }
    return rows.map((r) => {
      const id = composite
        ? JSON.stringify(decl.keyColumns.map((k) => r[k] ?? null))
        : String(r[decl.primaryKey] ?? '')
      // KV-shape: unwrap the JSON blob so consumers receive
      // `{ id, data: <parsedJSON> }` directly. Without this every caller
      // in the auth chain (UserManager, LoginSessionManager, …) gets a
      // double-wrapped record (`{ data: { data: <real> } }`) and the
      // schema parse throws on undefined fields.
      if (isKvShape) {
        const v = r['data']
        if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
          try {
            return { id, data: JSON.parse(v) as T }
          } catch {
            return { id, data: { value: v } as T }
          }
        }
        return { id, data: (v == null ? {} : { value: v }) as T }
      }
      // Structured tables: reassemble the record from typed columns and
      // include the primary key field so callers (e.g. `UserRecordSchema.parse`)
      // see the same shape they originally inserted. `decodeColumnValue`
      // handles per-column type coercion (BOOLEAN, JSON, primitives).
      const data: Record<string, unknown> = composite
        ? {}
        : { [decl.primaryKey]: r[decl.primaryKey] ?? null }
      // `readColumns`, NOT `decl.columns`: a projected read must not fabricate
      // a key for a column it never selected. An absent key means "not read",
      // and `resolveProjection` has already guaranteed every absent key was
      // asked to be absent.
      for (const c of readColumns) {
        data[c] = this.decodeColumnValue(r[c], c, decl.booleanColumns)
      }
      return { id, data: data as T }
    })
  }

  // ---------------------------------------------------------------------------
  // Legacy SettingsStore compatibility (used by ConfigManager.setSettingsStore)
  // ---------------------------------------------------------------------------

  /** Get a system setting by dot-notation key */
  getSystem(key: string): unknown {
    this.requireDeclared('system-settings')
    const row = this.getDb()
      .prepare<[string], { data: string }>('SELECT data FROM "system-settings" WHERE id = ?')
      .get(key)
    if (!row) return undefined
    return JSON.parse(row.data)
  }

  /** Set a system setting */
  setSystem(key: string, value: unknown): void {
    this.requireDeclared('system-settings')
    this.getDb()
      .prepare(
        'INSERT INTO "system-settings" (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(key, JSON.stringify(value))
  }

  /** Get all system settings as flat key-value */
  getAllSystem(): Record<string, unknown> {
    this.requireDeclared('system-settings')
    const rows = this.measured({ op: 'getAllSystem', collection: 'system-settings' }, () =>
      this.getDb()
        .prepare<[], { id: string; data: string }>('SELECT id, data FROM "system-settings"')
        .all(),
    )
    return Object.fromEntries(rows.map((r) => [r.id, JSON.parse(r.data)]))
  }

  /**
   * Get all settings for an addon.
   *
   * Selected by the SAME key range {@link setAllAddon} deletes and re-inserts
   * — `prefixWhere("<addonId>.")` — and for the same reason `getAllScoped`
   * uses it: `"<addonId>.<key>"` is the PRIMARY KEY, so the range is a
   * `SEARCH … USING INDEX` while anything else is a full `SCAN`.
   *
   * It used to select on `json_extract(data, '$.addonId')`, which is a second
   * authority for "this addon's rows" and disagreed with the writer in both
   * directions: a row inside the JSON's idea of the addon but outside the key
   * range was READ and never DELETED (a config key that could not be cleared),
   * and `json_extract` was evaluated on EVERY row — so a four-key addon paid
   * for the whole table and one unparseable neighbour aborted the statement,
   * taking out every addon's config read at once.
   *
   * The cost was not theoretical. On the live hub `addon-settings` is 627 KB
   * in 24 rows, 625 KB of it device-manager's three fleet blobs; a V8 profile
   * of a boot (2026-08-19) had hub-main's JS thread 99.9% busy with **64% of
   * it inside this method**, which is what put a ~45 s queue in front of every
   * runner's first store read. Measured on that table: 0.947 ms → ~0.02 ms for
   * a four-key addon, 2.90 ms → 2.13 ms for device-manager's own.
   */
  getAllAddon(addonId: string): Record<string, unknown> {
    this.requireDeclared('addon-settings')
    const where = this.prefixWhere(`${addonId}.`)
    const rows = this.measured({ op: 'getAllAddon', collection: 'addon-settings' }, () =>
      this.getDb()
        .prepare<string[], { id: string; data: string }>(
          `SELECT id, data FROM "addon-settings" WHERE ${where.sql}`,
        )
        .all(...where.params),
    )
    if (rows.length === 0) return {}
    // addon-settings stores all keys for an addon as separate rows with id
    // = "addonId.key" and data = `{ addonId, key, value }`. Detect the
    // wrapper shape explicitly: a corrupted legacy row that lacks the
    // `value` field would otherwise be returned as the wrapper itself
    // (the previous `parsed.value ?? parsed` fallback masked the bug as a
    // valid value, breaking downstream type-narrowed reads like
    // `pipelineDefaults`). Skip those rows entirely so the caller sees
    // them as missing.
    const result: Record<string, unknown> = {}
    for (const row of rows) {
      const parsed = parseRowData(row.data)
      const key = row.id.startsWith(`${addonId}.`) ? row.id.slice(addonId.length + 1) : row.id
      const isWrapper =
        parsed !== null &&
        typeof parsed === 'object' &&
        'addonId' in parsed &&
        'key' in (parsed as Record<string, unknown>)
      if (isWrapper) {
        const wrapper = parsed as {
          readonly addonId: string
          readonly key: string
          readonly value?: unknown
        }
        if ('value' in wrapper) {
          result[key] = wrapper.value
        }
        // else: corrupted wrapper-without-value — skip
      } else {
        result[key] = parsed
      }
    }
    return result
  }

  /** Bulk-set all settings for an addon */
  setAllAddon(addonId: string, config: Record<string, unknown>): void {
    this.requireDeclared('addon-settings')
    const db = this.getDb()
    const where = this.prefixWhere(`${addonId}.`)
    const deleteStmt = db.prepare(`DELETE FROM "addon-settings" WHERE ${where.sql}`)
    const insertStmt = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
    db.transaction(() => {
      deleteStmt.run(...where.params)
      for (const [key, value] of Object.entries(config)) {
        // Skip undefined values: the JSON wrapper `{addonId, key, value}`
        // serializes as `{addonId, key}` when value is undefined, which
        // round-trips as a corrupted "wrapper without value" row.
        if (value === undefined) continue
        insertStmt.run(`${addonId}.${key}`, JSON.stringify({ addonId, key, value }))
      }
    })()
  }

  // ── Device runtime state ──────────────────────────────────────────────────
  //
  // One row per device in the collection named for it: `device-runtime-state
  // (id = String(deviceId), data = JSON of the whole cap-slice map)`.
  //
  // Until 2026-08-13 the blob went into `addon-device-settings` under a synthetic
  // addonId; D870 deleted that read fallback with the rest of the legacy path.

  /**
   * The device's whole cap-slice map. `{}` — never null — when the device has never persisted a slice,
   * because every caller treats the result as a cap map to iterate.
   */
  getDeviceRuntimeState(deviceId: string): Record<string, unknown> {
    this.requireDeclared('device-runtime-state')
    const row = this.getDb()
      .prepare<[string], { data: string }>('SELECT data FROM "device-runtime-state" WHERE id = ?')
      .get(deviceId)
    return row ? parseRowData(row.data) : {}
  }

  /**
   * Replace the device's whole cap-slice map. Replace, not merge — the caller
   * always hands over the full persistable blob, and merging would resurrect a
   * slice the durability policy has since stopped persisting.
   */
  setDeviceRuntimeState(deviceId: string, blob: Record<string, unknown>): void {
    this.requireDeclared('device-runtime-state')
    this.getDb()
      .prepare(
        `INSERT INTO "device-runtime-state" (id, data) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(deviceId, JSON.stringify(blob))
  }

  /** Forget the device's runtime state (device removal). */
  clearDeviceRuntimeState(deviceId: string): void {
    this.requireDeclared('device-runtime-state')
    this.getDb().prepare('DELETE FROM "device-runtime-state" WHERE id = ?').run(deviceId)
  }

  /** Seed system-settings with runtime defaults (first boot) */
  private async seedDefaults(): Promise<void> {
    this.requireDeclared('system-settings')
    const insert = this.getDb().prepare(
      'INSERT OR IGNORE INTO "system-settings" (id, data) VALUES (?, ?)',
    )
    this.getDb().transaction(() => {
      for (const [key, value] of Object.entries(this.runtimeDefaults)) {
        insert.run(key, JSON.stringify(value))
      }
    })()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Expose the raw better-sqlite3 Database instance for components that
   * need direct SQL access (e.g. DeviceStore, ConfigStore).
   * Returns null if the backend has not been initialized yet.
   */
  getDatabase(): Database.Database | null {
    return this.db
  }

  /** Which file this backend serves. */
  getDatabaseId(): DataStoreDatabase {
    return this.options.databaseId
  }

  /**
   * Every table of this file with rows and size. READ-ONLY: nothing is created,
   * and no declaration is consulted or changed.
   */
  listTables(ownerPrefix?: string): readonly {
    name: string
    owner: string | null
    rows: number
    bytes: number | null
    declaredThisBoot: boolean
  }[] {
    const db = this.getDb()
    const entries = db
      .prepare<[], { name: string; sql: string | null }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
    const out: {
      name: string
      owner: string | null
      rows: number
      bytes: number | null
      declaredThisBoot: boolean
    }[] = []
    for (const { name, sql } of entries) {
      if (sql !== null && sql.toUpperCase().startsWith('CREATE VIRTUAL')) continue
      const colon = name.indexOf(':')
      const owner = colon > 0 ? name.slice(0, colon) : null
      if (ownerPrefix !== undefined && owner !== ownerPrefix) continue
      let rows = 0
      try {
        rows = db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM "${name}"`).get()?.c ?? 0
      } catch (err: unknown) {
        // A countable table that throws is dropped from the listing so one
        // bad name cannot abort storage-admin (orphan vec0 without the
        // extension used to). Log so the skip is not silent (D391).
        this.logger?.warn('listTables: skipped a table whose COUNT failed', {
          meta: {
            table: name,
            database: this.options.databaseId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        continue
      }
      let bytes: number | null = null
      try {
        const sized = db
          .prepare<[string], { b: number | null }>(
            'SELECT SUM(pgsize) AS b FROM dbstat WHERE name = ?',
          )
          .get(name)
        bytes = sized?.b ?? null
      } catch {
        bytes = null
      }
      out.push({ name, owner, rows, bytes, declaredThisBoot: this.declaredThisBoot.has(name) })
    }
    return out
  }

  /**
   * The tables this file's own `_collection_declarations` names — the
   * placement authority (D851). Read from DISK, not from memory, so a table
   * created and declared by an earlier life of the process still counts.
   */
  declaredCollectionNames(): ReadonlySet<string> {
    this.ensureDeclarationsTable()
    const rows = this.getDb()
      .prepare(`SELECT name FROM "${SqliteSettingsBackend.DECLARATIONS_TABLE}"`)
      .all() as readonly { name: string }[]
    return new Set(rows.map((r) => r.name))
  }

  /** Does a table of this name exist in THIS file? */
  hasTable(name: string): boolean {
    return (
      this.getDb()
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) !== undefined
    )
  }

  /** Refuse an id-addressed call on a composite-keyed collection. */
  private requireSingleKey(table: string, decl: DeclaredCollection, op: string): void {
    if (decl.keyColumns.length > 0) {
      throw new CompositeKeyError(table, op, decl.keyColumns)
    }
  }

  /**
   * The composite key of a declaration, validated: every name is a declared
   * column, no column also claims `primaryKey: true`, and `withoutRowid` has a
   * key to be keyed by. A single-name `primaryKey` is the single-column key it
   * always was and returns empty.
   */
  private resolveKeyColumns(table: string, input: DeclareCollectionInput): readonly string[] {
    const declared = input.primaryKey ?? []
    const flagged = input.columns.filter((c) => c.primaryKey === true)
    if (input.withoutRowid === true && declared.length === 0 && flagged.length === 0) {
      throw new Error(`declareCollection "${table}": withoutRowid needs a primary key`)
    }
    if (declared.length === 0) return []
    const names = new Set(input.columns.map((c) => c.name))
    const unknown = declared.filter((k) => !names.has(k))
    if (unknown.length > 0) {
      throw new Error(
        `declareCollection "${table}": primaryKey names column(s) the collection does not declare: ${unknown.join(', ')}`,
      )
    }
    if (flagged.length > 0) {
      throw new Error(
        `declareCollection "${table}": primaryKey and a column flagged primaryKey: true are two answers to one question`,
      )
    }
    return declared.length === 1 ? [] : declared
  }

  /**
   * `EXPLAIN QUERY PLAN` for a statement, as one string per plan row.
   *
   * Answers the question the timing alone cannot: "1.6 s for 501 rows" is a
   * full scan and is also a cold disk, and only the plan tells them apart. It
   * runs on the SAME connection as the statement, because that is the only
   * connection whose `sqlite_stat1` visibility and temp schema match.
   *
   * `EXPLAIN QUERY PLAN` prepares and plans; it does not execute the statement,
   * so it costs no page reads of its own. In production it is called only from
   * the slow-call path, once per shape per window; it is public so a guard can
   * assert that a declared index is the one the planner actually picks — "we
   * added an index" and "the query uses it" are different claims.
   *
   * Never throws. A plan that cannot be taken (a statement the engine will no
   * longer prepare, a closed handle mid-shutdown) is a missing ANSWER, not a
   * failure worth turning a slow query into a crash — the profiler falls back
   * to the line it would have printed anyway.
   */
  explainQueryPlan(sql: string, params: readonly unknown[]): readonly string[] {
    try {
      const rows = this.getDb()
        .prepare<unknown[], { detail?: unknown }>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
      const details: string[] = []
      for (const row of rows) {
        if (typeof row.detail === 'string') details.push(row.detail)
      }
      return details
    } catch {
      return []
    }
  }

  /**
   * Run one synchronous statement under the profiler.
   *
   * A thin pass-through when no profiler exists, so the specs that construct
   * this backend without a logger keep exercising the SAME code path as
   * production. The alternative — two call shapes — is how a fix gets tested
   * on a branch production never takes.
   */
  private measured<T>(label: SqliteOpLabel, run: () => T): T {
    const profiler = this.profiler
    return profiler === undefined ? run() : profiler.measure(label, run)
  }

  /**
   * Size of the database file, or 0 when it cannot be read.
   *
   * 0 is the honest answer for a first boot (no file yet) and for an
   * unreadable `stat`, and both callers treat it as "unknown" and fall back to
   * the floor — never to a smaller setting than the one already argued for.
   */
  /**
   * One numeric PRAGMA off the open connection. A pragma that does not answer
   * with a number yields 0, which `sqliteOccupancy` reads as "unknown" and
   * reports as an empty file rather than inventing a ratio.
   */
  /**
   * Follow the file as it grows.
   *
   * The map is derived from the file at OPEN and never again, which is the same
   * expiry one level up: a database that grows during uptime keeps the map it
   * had at boot, and once the file passes it every read outside the window
   * costs a synchronous page-in — 418 per second, measured 2026-08-25. This
   * node escaped it only because 130 MB → 858 MB spanned seventeen days of
   * restarts.
   *
   * `unref` so it never holds the process open.
   */
  private scheduleMapGrowthCheck(appliedMmapBytes: number): void {
    let applied = appliedMmapBytes
    const timer = setInterval(() => {
      const db = this.db
      if (db === null) return
      const grown = resolveMapGrowth(applied, this.measureDbSizeBytes())
      if (grown === null) return
      db.pragma(`mmap_size = ${grown}`)
      applied = grown
      // Said out loud: a map that silently stopped covering the file is the
      // failure this exists to prevent, so the moment it moves is worth a line.
      this.logger?.info('sqlite map grew with the database', {
        meta: {
          mmapMb: Math.round(grown / 1_048_576),
          dbSizeMb: Math.round(this.measureDbSizeBytes() / 1_048_576),
        },
      })
    }, MAP_GROWTH_CHECK_INTERVAL_MS)
    timer.unref()
  }

  /**
   * One-shot `ANALYZE`, long after boot, only if the database has none.
   *
   * `analyze-stats.ts` has the measurement that justifies it: without
   * `sqlite_stat1` the planner walked 150 133 media rows to return six, and one
   * `ANALYZE` took that same query from 727 ms to 3.2 ms. It is scheduled
   * rather than run inline because it is a 14 s synchronous statement on the
   * one thread the cluster reads configuration through.
   */
  private scheduleIndexAnalysis(): void {
    const timer = setTimeout(() => {
      const db = this.db
      if (db === null) return
      const outcome = runAnalyzeIfMissing(db)
      if (outcome.kind === 'already-present') return
      if (outcome.kind === 'analyzed') {
        this.logger?.info('sqlite index statistics built — the planner had none until now', {
          meta: { tookMs: outcome.tookMs, indexesAnalyzed: outcome.indexesAnalyzed },
        })
        return
      }
      // Said out loud: a database that silently kept no statistics is exactly
      // the state this exists to leave, and a quiet failure recreates it.
      this.logger?.warn(
        'sqlite ANALYZE failed — the planner is still choosing without statistics',
        {
          meta: { tookMs: outcome.tookMs, error: outcome.error },
        },
      )
    }, ANALYZE_DELAY_MS)
    timer.unref()
  }

  /**
   * Name the biggest tables, once, a minute after the connection opens.
   *
   * `dbSizeMb` says how big the file is and `freePct` says how much of it is
   * live; neither says WHOSE. Per-addon scoped collections are created on first
   * write and declared nowhere, so this is the only place the real set can be
   * enumerated. `unref` so it can never hold the process open.
   */
  private scheduleStorageReport(totalBytes: number): void {
    const timer = setTimeout(() => {
      this.logStorageReport(totalBytes)
    }, STORAGE_REPORT_DELAY_MS)
    timer.unref()
  }

  private logStorageReport(totalBytes: number): void {
    const db = this.db
    if (db === null) return
    const startedAt = Date.now()
    try {
      const raw = db
        .prepare(
          // dbstat groups by OBJECT, and an index is an object. The join adds
          // what dbstat cannot know: whether the object is a table or an index,
          // and which table an index belongs to — the only trustworthy
          // ownership signal, since index names carry none.
          `SELECT d.name AS name,
                  COALESCE(m.tbl_name, d.name) AS tableName,
                  SUM(d.pgsize) AS bytes,
                  COUNT(*) AS pages,
                  COALESCE(m.type, 'unknown') AS kind
             FROM dbstat d
             LEFT JOIN sqlite_master m ON m.name = d.name
            GROUP BY d.name, m.tbl_name, m.type`,
        )
        .all()
      const rows: TableSizeRow[] = []
      for (const entry of raw) {
        const row = toTableSizeRow(entry)
        if (row !== null) rows.push(row)
      }
      const report = summariseTableSizes(rows, totalBytes, STORAGE_REPORT_TOP_N)
      this.logger?.info('sqlite storage report — the biggest tables on this node', {
        meta: {
          tookMs: Date.now() - startedAt,
          tableCount: report.tableCount,
          indexCount: report.indexCount,
          tables: report.tables,
          otherMb: report.otherMb,
          otherObjects: report.otherObjects,
          // Rolled up per owner so a cluster with ~40 addons is read as ~40
          // owners, not as hundreds of anonymous objects.
          byOwner: report.byOwner.slice(0, STORAGE_REPORT_TOP_OWNERS),
        },
      })
    } catch (error) {
      // A build without `SQLITE_ENABLE_DBSTAT_VTAB` has no dbstat. That is a
      // missing answer, not a failure — but it is logged, because a silent
      // branch reads as "the report says nothing is big".
      this.logger?.info('sqlite storage report unavailable — dbstat is not compiled in', {
        meta: {
          tookMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private readPragmaNumber(name: string): number {
    const value = this.db?.pragma(name, { simple: true })
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  private measureDbSizeBytes(): number {
    try {
      return statSync(this.dbPath).size
    } catch {
      return 0
    }
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('SqliteSettingsBackend not initialized — call initialize() first')
    return this.db
  }

  /**
   * `WHERE` fragment selecting every key that starts with `prefix`, plus its
   * bound parameters.
   *
   * The range form is what makes the implicit PRIMARY KEY index usable — see
   * `prefix-range.ts` for the `EXPLAIN QUERY PLAN` output and the measured
   * 1.8x/19.4x. The `LIKE` fallback is the SQL that shipped before, kept
   * verbatim for the prefixes a byte range cannot express, so a key shape this
   * function refuses degrades in speed and never in correctness.
   */
  private prefixWhere(prefix: string): {
    readonly sql: string
    readonly params: string[]
  } {
    const range = prefixRange(prefix)
    if (range === null) return { sql: `id LIKE ? || '%'`, params: [prefix] }
    return { sql: 'id >= ? AND id < ?', params: [range.lo, range.hi] }
  }

  // ── Declared collections (typed SQL tables behind the generic cap) ──

  private scopedName(namespace: string | undefined, collection: string): string {
    return namespace ? `${namespace}:${collection}` : collection
  }

  /**
   * Project a declared collection onto what {@link compileFilter} needs. A
   * collection whose only column is `data` is KV-shaped: its fields live
   * inside that blob and are reached with `json_extract`.
   */
  private shapeOf(decl: DeclaredCollectionShape): CollectionShape {
    const isKvShape = decl.columns.size === 1 && decl.columns.has('data')
    return {
      primaryKey: decl.primaryKey,
      columns: decl.columns,
      kvBlobColumn: isKvShape ? 'data' : null,
    }
  }

  /**
   * Where a declaration LIVES, so it outlives the process that made it.
   *
   * `declaredCollections` used to be only an in-memory Map, and the
   * declarations are made once, by each addon, at that addon's own boot.
   * On 2026-09-12 this backend died with SIGBUS (a second connection
   * truncated the WAL under its mmap) and `CrashSupervisor` respawned it: the
   * new instance knew only the canonical KV collections, every other addon
   * stayed up and never re-declared, and the cluster failed every settings
   * read for six hours — the operator could not log in.
   *
   * The tables are durable. What the backend knows ABOUT them has to be too,
   * because nothing in the system re-declares and nothing listens for this
   * process restarting.
   */
  private static readonly DECLARATIONS_TABLE = '_collection_declarations'

  /** Create the meta table. Idempotent; called before anything reads it. */
  private ensureDeclarationsTable(): void {
    this.getDb().exec(
      `CREATE TABLE IF NOT EXISTS "${SqliteSettingsBackend.DECLARATIONS_TABLE}" ` +
        '(name TEXT PRIMARY KEY NOT NULL, decl TEXT NOT NULL)',
    )
  }

  /** Persist one declaration, replacing any earlier shape for the same table. */
  private persistDeclaration(
    table: string,
    decl: {
      readonly primaryKey: string
      readonly columns: ReadonlySet<string>
      readonly booleanColumns: ReadonlySet<string>
      readonly autoPrimaryKey: boolean
      readonly keyColumns: readonly string[]
    },
  ): void {
    try {
      this.ensureDeclarationsTable()
      this.getDb()
        .prepare(
          `INSERT INTO "${SqliteSettingsBackend.DECLARATIONS_TABLE}" (name, decl) VALUES (?, ?) ` +
            'ON CONFLICT(name) DO UPDATE SET decl = excluded.decl',
        )
        .run(
          table,
          JSON.stringify({
            primaryKey: decl.primaryKey,
            columns: [...decl.columns],
            booleanColumns: [...decl.booleanColumns],
            autoPrimaryKey: decl.autoPrimaryKey,
            keyColumns: decl.keyColumns,
            // The file this declaration lives in: the placement authority
            // (D851) reads it back at boot.
            database: this.options.databaseId,
          }),
        )
    } catch (err: unknown) {
      // Never fail a declaration because the memo could not be written — the
      // in-memory map still serves this process. But say so: silence here is
      // what makes the NEXT respawn a six-hour outage.
      this.logger?.warn('settings: could not persist a collection declaration', {
        meta: { table, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Reload every persisted declaration. Called at init, BEFORE any addon has
   * had the chance to re-declare — which on a respawn none of them will.
   */
  private restorePersistedDeclarations(): void {
    try {
      this.ensureDeclarationsTable()
      const rows = this.getDb()
        .prepare(`SELECT name, decl FROM "${SqliteSettingsBackend.DECLARATIONS_TABLE}"`)
        .all() as readonly { name: string; decl: string }[]
      let restored = 0
      for (const row of rows) {
        // A table that was dropped outside this backend must not be reported
        // as declared: the memo describes a table, and a memo for something
        // that is gone is worse than no memo.
        const exists = this.getDb()
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(row.name)
        if (exists === undefined) continue
        const parsed: unknown = JSON.parse(row.decl)
        if (typeof parsed !== 'object' || parsed === null) continue
        const d = parsed as {
          primaryKey?: unknown
          columns?: unknown
          booleanColumns?: unknown
          autoPrimaryKey?: unknown
          keyColumns?: unknown
        }
        if (typeof d.primaryKey !== 'string' || !Array.isArray(d.columns)) continue
        this.declaredCollections.set(row.name, {
          primaryKey: d.primaryKey,
          columns: new Set(d.columns.filter((c): c is string => typeof c === 'string')),
          booleanColumns: new Set(
            Array.isArray(d.booleanColumns)
              ? d.booleanColumns.filter((c): c is string => typeof c === 'string')
              : [],
          ),
          autoPrimaryKey: d.autoPrimaryKey === true,
          keyColumns: Array.isArray(d.keyColumns)
            ? d.keyColumns.filter((c): c is string => typeof c === 'string')
            : [],
        })
        restored += 1
      }
      if (restored > 0) {
        // At INFO on purpose: on a respawn this line is the difference between
        // "the store came back" and six hours of guessing.
        this.logger?.info('settings: restored collection declarations from disk', {
          meta: { restored, total: rows.length },
        })
      }
    } catch (err: unknown) {
      this.logger?.warn('settings: could not restore collection declarations', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  async declareCollection(declared: DeclareCollectionInput): Promise<void> {
    // `primaryKey: ['x']` is the single-column key `primaryKey: true` on `x`
    // always was; fold it into the column flag so the rest of this method has
    // one way to say it.
    const single = declared.primaryKey?.length === 1 ? declared.primaryKey[0] : undefined
    const input: DeclareCollectionInput =
      single === undefined
        ? declared
        : {
            ...declared,
            primaryKey: undefined,
            columns: declared.columns.map((c) =>
              c.name === single ? { ...c, primaryKey: true } : c,
            ),
          }
    const table = this.scopedName(input.namespace, input.collection)
    this.declaredThisBoot.add(table)
    // `input.database` is the ROUTER's business (`placement-router.ts`): by the
    // time a declaration reaches a file, it is this file's.
    const keyColumns = this.resolveKeyColumns(table, input)
    // NO early return on "already declared". `ensureTable` memoises on the
    // schema FINGERPRINT, so a redeclaration of the same shape is already a
    // no-op — while a redeclaration with a NEW column still has to reach both
    // the `ALTER TABLE` and, just as importantly, the `declaredCollections`
    // refresh below: that map is the column set `compileFilter` resolves
    // against, so a stale entry makes the new column unnameable in a filter
    // even once it exists in SQLite.

    // Ensure id column is explicit — every declared collection needs a
    // primary key that maps to the cap's record.id.
    const hasId = keyColumns.length > 0 || input.columns.some((c) => c.primaryKey === true)
    const columns = hasId
      ? input.columns
      : [
          {
            name: 'id',
            type: 'TEXT' as const,
            primaryKey: true,
            notNull: true,
          },
          ...input.columns,
        ]

    // Translate to the TableSchema shape ensureTable expects. Both JSON
    // and BOOLEAN are logical types — SQLite has no native equivalent,
    // so we emit TEXT for JSON (we serialise/parse at the boundary) and
    // INTEGER for BOOLEAN (storage is `0|1`, the decoder coerces on read).
    //
    // `defaultValue` MUST be forwarded. Dropping it here (as this did until
    // B2) does not merely lose a convenience: a declared
    // `NOT NULL DEFAULT 1` column reaches the DDL as bare `NOT NULL`, which
    // SQLite cannot add to a populated table — so the column counts as
    // non-additive and the next boot REBUILDS the collection, discarding
    // every row.
    const schema: TableSchema = {
      ...(keyColumns.length > 0 ? { primaryKey: keyColumns } : {}),
      ...(input.withoutRowid === true ? { withoutRowid: true } : {}),
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type === 'JSON' ? 'TEXT' : c.type === 'BOOLEAN' ? 'INTEGER' : c.type,
        ...(c.primaryKey !== undefined ? { primaryKey: c.primaryKey } : {}),
        ...(c.notNull !== undefined ? { notNull: c.notNull } : {}),
        ...(c.unique !== undefined ? { unique: c.unique } : {}),
        ...(c.defaultValue !== undefined ? { defaultValue: c.defaultValue } : {}),
      })),
      ...(input.indexes
        ? {
            indexes: input.indexes.map((i) => ({
              name: i.name,
              columns: i.columns,
              ...(i.unique !== undefined ? { unique: i.unique } : {}),
            })),
          }
        : {}),
    }
    await this.ensureTable(table, schema)

    const pkCol = keyColumns.length > 0 ? undefined : columns.find((c) => c.primaryKey === true)
    const primaryKey = keyColumns.length > 0 ? '' : pkCol ? pkCol.name : 'id'
    const columnNames = new Set(columns.filter((c) => c.name !== primaryKey).map((c) => c.name))
    const booleanColumns = new Set(columns.filter((c) => c.type === 'BOOLEAN').map((c) => c.name))
    const decl = {
      primaryKey,
      columns: columnNames,
      booleanColumns,
      autoPrimaryKey: pkCol?.type === 'INTEGER',
      keyColumns,
    }
    this.declaredCollections.set(table, decl)
    this.persistDeclaration(table, decl)
  }

  /** Serialise per-column values for SQL binding: objects → JSON, booleans → 0/1. */
  private serializeColumnValue(v: unknown): unknown {
    if (v === null || v === undefined) return v ?? null
    if (typeof v === 'boolean') return v ? 1 : 0
    if (typeof v === 'object') return JSON.stringify(v)
    return v
  }

  // ── Structured table operations ────────────────────────────────────

  private async ensureTable(table: string, schema: TableSchema): Promise<void> {
    const fingerprint = schemaFingerprint(schema)
    if (this.structuredTables.get(table) === fingerprint) return
    const compositeKey: ReadonlySet<string> = new Set(schema.primaryKey ?? [])

    const colDefs = schema.columns.map((col) => {
      const parts = [`"${col.name}" ${col.type}`]
      if (col.primaryKey) parts.push('PRIMARY KEY')
      if (col.notNull || compositeKey.has(col.name)) parts.push('NOT NULL')
      if (col.unique) parts.push('UNIQUE')
      if (col.defaultValue !== undefined) {
        parts.push(
          `DEFAULT ${typeof col.defaultValue === 'string' ? `'${col.defaultValue}'` : col.defaultValue === null ? 'NULL' : String(col.defaultValue)}`,
        )
      }
      return parts.join(' ')
    })

    // Schema evolution. Two regimes:
    //
    // ADDITIVE (the norm): a declared column missing from the existing table
    // is added IN PLACE via `ALTER TABLE … ADD COLUMN`, preserving every row.
    // SQLite can add any column that is not PRIMARY KEY / UNIQUE and is
    // either nullable or NOT NULL WITH a default — which covers the usual
    // "new optional field on a historical table" case. (The 2026-07-17
    // envelope-columns change wiped the whole tracks history through the old
    // drop/recreate path — never again for additive changes.)
    //
    // REBUILD (destructive, the exception): shapes SQLite cannot evolve —
    // the legacy `(id, data)` KV form being replaced by a structured schema,
    // or a new column that is PRIMARY KEY / UNIQUE / NOT NULL without a
    // default. There the table is dropped and recreated; callers accept the
    // one-time wipe.
    type ColInfoRow = { name: string }
    const existingCols = this.getDb().prepare(`PRAGMA table_info("${table}")`).all() as ColInfoRow[]
    if (existingCols.length > 0) {
      const existingNames = new Set(existingCols.map((c) => c.name))
      const declaredNames = new Set(schema.columns.map((c) => c.name))
      const missingCols = schema.columns.filter((c) => !existingNames.has(c.name))
      const isLegacyKv =
        existingCols.length <= 2 && existingNames.has('data') && !declaredNames.has('data')
      const addableInPlace = (col: TableSchema['columns'][number]): boolean =>
        !col.primaryKey &&
        !compositeKey.has(col.name) &&
        !col.unique &&
        (!col.notNull || col.defaultValue !== undefined)
      if (isLegacyKv || missingCols.some((c) => !addableInPlace(c))) {
        try {
          this.getDb().exec(`DROP TABLE "${table}"`)
        } catch {
          /* best-effort */
        }
      } else if (missingCols.length > 0) {
        for (const col of missingCols) {
          const parts = [`"${col.name}" ${col.type}`]
          if (col.notNull) parts.push('NOT NULL')
          if (col.defaultValue !== undefined) {
            parts.push(
              `DEFAULT ${typeof col.defaultValue === 'string' ? `'${col.defaultValue}'` : col.defaultValue === null ? 'NULL' : String(col.defaultValue)}`,
            )
          }
          this.getDb().exec(`ALTER TABLE "${table}" ADD COLUMN ${parts.join(' ')}`)
        }
      }
    }

    const keyConstraint =
      schema.primaryKey !== undefined
        ? `, PRIMARY KEY (${schema.primaryKey.map((k) => `"${k}"`).join(', ')})`
        : ''
    const rowidClause = schema.withoutRowid === true ? ' WITHOUT ROWID' : ''
    this.getDb().exec(
      `CREATE TABLE IF NOT EXISTS "${table}" (${colDefs.join(', ')}${keyConstraint})${rowidClause}`,
    )

    if (schema.indexes) {
      // An index on a KV-shaped collection must be an EXPRESSION index.
      //
      // A KV collection keeps every field inside the `data` blob, and
      // `compileFilter` reaches them with `json_extract("data", '$.field')`.
      // SQLite will only use an expression index when the query's expression
      // matches the indexed one TEXTUALLY — so an index declared on such a
      // field is rendered through the same rule as the predicate, right here,
      // rather than as a bare `"field"` that names no column and would index
      // nothing.
      //
      // What this fixes: `share_view_tokens` is declared `(id, data)` and every
      // share-link validation queries `where: { tokenHash }`. The predicate was
      // rewritten to `json_extract`, correctly, but nothing could index it — so
      // each request was an unindexed full-table JSON scan. Invisible at six
      // rows; a latency cliff the moment share links are used in anger.
      //
      // It CALLS `fieldExprFor` rather than mirroring it. It used to mirror it,
      // and a mirror is the wrong shape for a rule whose whole job is to match
      // another rule character for character: the day the two drift, nothing
      // fails — SQLite just declines the index, which is worse than no index
      // because it reads as solved.
      const pkName =
        schema.primaryKey !== undefined
          ? ''
          : (schema.columns.find((c) => c.primaryKey === true)?.name ?? 'id')
      const nonPkColumns = schema.columns.filter((c) => c.name !== pkName).map((c) => c.name)
      const indexShape: CollectionShape = {
        primaryKey: pkName,
        columns: new Set(nonPkColumns),
        kvBlobColumn: nonPkColumns.length === 1 && nonPkColumns[0] === 'data' ? 'data' : null,
      }
      for (const idx of schema.indexes) {
        const exprs = idx.columns.map((c) => fieldExprFor(c, indexShape))
        // A field that is neither a column nor reachable in a blob cannot be
        // indexed. Skipping is right and quiet-by-design: the declaration is
        // already wrong, and emitting `CREATE INDEX … ("ghost")` would fail the
        // whole boot on a table that was otherwise fine.
        if (exprs.some((e) => e === null)) continue
        const unique = idx.unique ? 'UNIQUE ' : ''
        this.getDb().exec(
          `CREATE ${unique}INDEX IF NOT EXISTS "${idx.name}" ON "${table}" (${exprs.join(', ')})`,
        )
      }
    }

    this.structuredTables.set(table, fingerprint)
  }

  /** Returns SQLite's `lastInsertRowid` — the only place an auto-assigned key
   *  is knowable (D473). */
  private async tableInsert(table: string, row: Record<string, unknown>): Promise<number | bigint> {
    const keys = Object.keys(row)
    const cols = keys.map((k) => `"${k}"`).join(', ')
    const placeholders = keys.map(() => '?').join(', ')
    const values = keys.map((k) => {
      const v = row[k]
      return typeof v === 'object' && v !== null ? JSON.stringify(v) : v
    })
    const info = this.getDb()
      .prepare(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`)
      .run(...values)
    return info.lastInsertRowid
  }

  private async tableDelete(table: string, filter: Record<string, unknown>): Promise<number> {
    const { whereSql, whereValues } = this.buildWhere(filter)
    const result = this.getDb()
      .prepare(`DELETE FROM "${table}"${whereSql}`)
      .run(...whereValues)
    return result.changes
  }

  private async tableCount(table: string, filter?: Record<string, unknown>): Promise<number> {
    let sql = `SELECT COUNT(*) as count FROM "${table}"`
    const values: unknown[] = []

    if (filter) {
      const { whereSql, whereValues } = this.buildWhere(filter)
      sql += whereSql
      values.push(...whereValues)
    }

    const row = asJsonObject(
      this.getDb()
        .prepare(sql)
        .get(...values),
    )
    return typeof row?.count === 'number' ? row.count : 0
  }

  private buildWhere(filter: Record<string, unknown>): {
    whereSql: string
    whereValues: unknown[]
  } {
    const conditions: string[] = []
    const values: unknown[] = []
    for (const [k, v] of Object.entries(filter)) {
      conditions.push(`"${k}" = ?`)
      values.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)
    }
    const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    return { whereSql, whereValues: values }
  }
}

export default SqliteSettingsBackend
