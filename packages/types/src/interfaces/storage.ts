// =============================================================================
// Storage Location Types
// =============================================================================
//
// `StorageLocationType` is owned by `./storage-location.ts` (Zod enum is
// the authoritative source). This file used to declare a parallel TS
// alias which drifted from the Zod enum (the alias had 4 values the enum
// didn't). Re-exporting the inferred type keeps the wire surface and the
// legacy `IStorageProvider` interface in lockstep — adding/removing a
// value in the Zod enum is now the single source of truth.

export type { StorageLocationType } from './storage-location.js'

import type { StorageLocationType } from './storage-location.js'

// =============================================================================
// Storage Provider (capability: 'storage', mode: collection)
// =============================================================================

/**
 * A storage provider serves file-based storage for one or more location types.
 * Multiple providers can coexist (local filesystem, NAS, S3, etc.).
 * Each addon/system setting selects which provider to use per location type.
 */
// ── Named input types for IStorageProvider methods ──────────────────────

export interface StorageResolveInput {
  readonly location: StorageLocationType
  readonly relativePath: string
}
export interface StorageWriteInput {
  readonly location: StorageLocationType
  readonly relativePath: string
  readonly data: Buffer | NodeJS.ReadableStream
}
export interface StorageReadInput {
  readonly location: StorageLocationType
  readonly relativePath: string
}
export interface StorageExistsInput {
  readonly location: StorageLocationType
  readonly relativePath: string
}
export interface StorageListInput {
  readonly location: StorageLocationType
  readonly prefix?: string
}
export interface StorageDeleteInput {
  readonly location: StorageLocationType
  readonly relativePath: string
}
export interface StorageAvailableSpaceInput {
  readonly location: StorageLocationType
}

export interface IStorageProvider {
  readonly id: string
  readonly name: string
  readonly supportedLocations: readonly StorageLocationType[]

  resolve(input: StorageResolveInput): Promise<string>
  write(input: StorageWriteInput): Promise<void>
  read(input: StorageReadInput): Promise<Buffer>
  exists(input: StorageExistsInput): Promise<boolean>
  list(input: StorageListInput): Promise<readonly string[]>
  delete(input: StorageDeleteInput): Promise<void>
  getAvailableSpace(input: StorageAvailableSpaceInput): Promise<number | null>
}

// =============================================================================
// Settings Backend (capability: 'settings-store', mode: singleton)
// =============================================================================

/**
 * All named collections that the settings backend manages.
 * Each collection maps to a logical table/bucket in the backend.
 */
export type SettingsCollection =
  | 'system-settings' // Global system config
  | 'addon-settings' // Per-addon config (keyed by addonId)
  | 'detection-events' // Detection event records
  | 'audio-levels' // Audio level readings
  | 'track-trails' // Object tracking trails
  | 'recording-segments' // Recording segment metadata
  | 'recording-thumbnails' // Thumbnail metadata
  | 'recording-policies' // Per-device recording policies
  | 'recording-storage-config' // Per-device storage + retention
  | 'recording-cleanup-queue' // Cleanup task queue
  | 'known-faces' // Face recognition identities
  | (string & {}) // Allow arbitrary collection names (e.g. addon-defined)

// ── Named input types for ISettingsBackend methods ──────────────────────

export interface SettingsGetInput {
  readonly namespace?: string
  readonly collection: SettingsCollection
  readonly key: string
}
export interface SettingsSetInput {
  readonly namespace?: string
  readonly collection: SettingsCollection
  readonly key: string
  readonly value: unknown
}
export interface SettingsQueryInput {
  readonly namespace?: string
  readonly collection: SettingsCollection
  readonly filter?: QueryFilter
  /**
   * Read ONLY these columns (plus the primary key, always). Omit for the whole
   * row.
   *
   * A projection, not a predicate — which is why it sits here and not inside
   * {@link QueryFilter}. `count` and `histogram` take a filter and answer a
   * scalar; a column list inside the filter would be a field they could only
   * ignore, and a filter object shared between `query` and `count` (the
   * notification-centre artefact index does exactly that) would carry it into
   * both. This repo has already paid for one silently-ignored filter field.
   *
   * **The engine REFUSES a name it cannot serve.** Not a column of the
   * collection, or a collection whose row is a single JSON blob, and the call
   * throws. The alternative — skipping it, the way an unresolvable PREDICATE is
   * skipped — would hand back a record whose missing key is indistinguishable
   * from a NULL in the database, and the caller cannot tell "I did not read it"
   * from "it is not there". A predicate that over-matches returns extra rows; a
   * projection that under-reads returns wrong VALUES.
   *
   * The returned `data` therefore contains exactly these keys and the primary
   * key — absent means NOT READ, and every absent key was asked to be absent.
   */
  readonly columns?: readonly string[]
}
/**
 * A record as it is WRITTEN. `id` is optional here and required on
 * {@link SettingsRecord}, which describes a record as it is READ — a stored row
 * always has one, a row being written may not.
 *
 * The difference is not cosmetic: a collection whose primary key is `INTEGER`
 * is a SQLite ROWID ALIAS, and SQLite assigns it only when the column is
 * OMITTED from the insert. The backend has handled that since `autoPrimaryKey`
 * existed, but this type demanded an id anyway, so the path was unreachable
 * from TypeScript — wired at one end and closed at the other.
 */
export interface SettingsInsertRecord<T extends object = Record<string, unknown>> {
  readonly id?: string
  readonly data: T
}

export interface SettingsInsertInput<T extends object = Record<string, unknown>> {
  readonly namespace?: string
  readonly collection: SettingsCollection
  readonly record: SettingsInsertRecord<T>
}
/**
 * Input for an UPSERT against a slot that is not the primary key — see
 * `settings-store.cap.ts`'s `upsert` docblock (D482).
 *
 * `conflict` names declared columns covered by a UNIQUE index. It is never
 * empty: `ON CONFLICT()` is not valid SQL, and the intent an empty list would
 * encode is `insert`.
 */
export interface SettingsUpsertInput<T extends object = Record<string, unknown>> {
  readonly namespace?: string
  readonly collection: SettingsCollection
  readonly conflict: readonly string[]
  readonly record: SettingsInsertRecord<T>
}

export interface SettingsUpdateInput {
  readonly namespace?: string
  readonly collection: SettingsCollection
  readonly id: string
  readonly data: Record<string, unknown>
}
export interface SettingsDeleteInput {
  readonly namespace?: string
  readonly collection: SettingsCollection
  readonly key: string
}
export interface SettingsCountInput {
  readonly namespace?: string
  readonly collection: SettingsCollection
  readonly filter?: QueryFilter
}
export interface SettingsIsEmptyInput {
  readonly namespace?: string
  readonly collection: SettingsCollection
}
/**
 * One scalar an {@link ISettingsBackend.aggregate} call asks for. `as` names the
 * result slot, so `MIN(startMs)` and `MAX(startMs)` can be asked in one call.
 */
export interface SettingsAggregateField {
  readonly as: string
  readonly field: string
  readonly op: 'sum' | 'min' | 'max'
}
export interface SettingsAggregateInput {
  readonly namespace?: string
  readonly collection: SettingsCollection
  readonly fields: readonly SettingsAggregateField[]
  readonly filter?: QueryFilter
}
/**
 * `COUNT(*)` plus one value per requested field. A value is `null` when no row
 * matched — never 0, because "nothing is there" and "the sum is zero" are
 * different facts about a disk.
 */
export interface SettingsAggregateResult {
  readonly count: number
  readonly values: Readonly<Record<string, number | null>>
}
export interface SettingsHistogramInput {
  readonly namespace?: string
  readonly collection: SettingsCollection
  /** Numeric column to bucket on (e.g. 'timestamp'). */
  readonly field: string
  readonly bucketSize: number
  readonly origin: number
  readonly filter?: QueryFilter
}
export interface HistogramBucket {
  readonly bucket: number
  readonly count: number
}

/**
 * Settings backend — persistent key-value and document storage.
 * Default implementation: SQLite. Can be replaced by Postgres, etc.
 * All methods use object-arg signatures for extensibility.
 */
export interface ISettingsBackend {
  /** Get a single value by key from a collection */
  get(input: SettingsGetInput): Promise<unknown>

  /** Set a value by key in a collection (upsert) */
  set(input: SettingsSetInput): Promise<void>

  /** Get all entries matching an optional filter */
  query<T extends object = Record<string, unknown>>(
    input: SettingsQueryInput,
  ): Promise<readonly SettingsRecord<T>[]>

  /** Insert a new record */
  insert<T extends object = Record<string, unknown>>(
    input: SettingsInsertInput<T>,
  ): Promise<{ readonly id: string | number }>

  /** Make a slot hold this row, answering with the id the row has (D482) */
  upsert<T extends object = Record<string, unknown>>(
    input: SettingsUpsertInput<T>,
  ): Promise<{ readonly id: string | number }>

  /** Update an existing record by ID */
  update(input: SettingsUpdateInput): Promise<void>

  /** Delete a record by key/ID */
  delete(input: SettingsDeleteInput): Promise<void>

  /** Count entries in a collection */
  count(input: SettingsCountInput): Promise<number>

  /** COUNT(*) plus one SUM/MIN/MAX per field, in one statement. */
  aggregate(input: SettingsAggregateInput): Promise<SettingsAggregateResult>

  /** Grouped counts: COUNT(*) per ((field - origin) / bucketSize) bucket. */
  histogram(input: SettingsHistogramInput): Promise<readonly HistogramBucket[]>

  /** Check if a collection is empty (used for first-boot detection) */
  isEmpty(input: SettingsIsEmptyInput): Promise<boolean>

  /**
   * Declare a typed (SQL-backed) collection. After declaration, the
   * standard `insert` / `update` / `delete` / `query` methods route to
   * typed columns for this collection instead of the JSON-blob default.
   * Idempotent — re-declaring the same shape is a no-op. Backends
   * without typed-table support should implement this as a no-op so
   * the cap contract stays uniform.
   */
  declareCollection(
    input: import('../capabilities/settings-store.cap.js').DeclareCollectionInput,
  ): Promise<void>

  // NOTE: there is no second, table-shaped half of this interface.
  // `ensureTable` + six `table*` methods used to live here — a positional SQL
  // API that existed on the concrete SQLite engine and on no capability, so
  // reaching it meant holding the engine object. After D44 the door stopped
  // being the engine, every one of those calls became a silent no-op, and the
  // hub served no integrations for a day without logging a word. Each of them
  // was a collection method under another name (ensureTable→declareCollection,
  // tableInsert→insert, tableQuery→query, tableGet→query+limit 1,
  // tableUpdate→updateWhere, tableDelete→deleteWhere), so the consumers were
  // rewritten onto those and the bypass deleted rather than blessed (B2).
}

export interface SettingsRecord<T extends object = Record<string, unknown>> {
  readonly id: string
  readonly data: T
}

export interface QueryFilter {
  where?: Record<string, unknown>
  whereIn?: Record<string, unknown[]>
  whereBetween?: Record<string, [unknown, unknown]>
  /**
   * NULL-safe inequality: a row matches when its field is NULL OR different
   * from the excluded value — the only honest shape for "not this kind of
   * row" over nullable columns, because SQL `!=` silently drops NULLs (and
   * rows written before the column existed are exactly the ones a
   * kind-exclusion must KEEP).
   */
  whereNot?: Record<string, unknown>
  /**
   * NULL-safe exclusion of SEVERAL values — `whereNot` for a set.
   *
   * A row matches when its field is NULL OR not one of the listed values, for
   * the same reason `whereNot` is NULL-safe: on a nullable column the NULL
   * rows are the ones written before the column existed, and a "not these
   * kinds" filter must keep them.
   *
   * It exists because `whereNot` is a `Record` keyed by field, so ONE field
   * can carry exactly one excluded value. Excluding two members of a small
   * enum (the case that produced it: `Track.source`, hiding the synthetic
   * `audio` and `sensor` projections at once) was otherwise inexpressible —
   * and the alternative, dropping the rows in the caller after the read, makes
   * paging lie about how much is left.
   *
   * An EMPTY list is no filter, never "matches nothing": it is a chip row with
   * nothing selected. Same rule as `whereJsonArrayAny`.
   */
  whereNotIn?: Record<string, unknown[]>
  /**
   * "This JSON array column contains at least one of these values."
   *
   * Deliberately a SUPERSET prefilter, never an exact one: a row whose column
   * is NULL or not valid JSON is KEPT. Those rows predate the column, and a
   * filter that dropped them would hide exactly the history a narrowing
   * question is asked about — the same reason `whereNot` is NULL-safe.
   *
   * So the caller stays responsible for the exact rule. What this buys is the
   * read: the server stops shipping the rows that cannot possibly match.
   */
  whereJsonArrayAny?: Record<string, unknown[]>
  orderBy?: { field: string; direction: 'asc' | 'desc' }
  limit?: number
  offset?: number
}

/** Column definition for structured tables */
export interface TableColumnSchema {
  readonly name: string
  /**
   * Logical column type. SQLite has 5 native storage classes; we expose
   * a slightly richer surface so backends can implement marshaling:
   *   - `TEXT`    : plain string
   *   - `INTEGER` : 64-bit signed int (JS `number` round-trip)
   *   - `REAL`    : floating-point
   *   - `JSON`    : object / array serialised to a TEXT column at the
   *                 boundary; deserialised on read
   *   - `BOOLEAN` : `true|false` ↔ INTEGER `1|0` round-trip. The
   *                 backend is responsible for the bi-directional coercion
   *                 so consumer schemas can use canonical `boolean`
   *                 without a per-call preprocess.
   */
  readonly type: 'TEXT' | 'INTEGER' | 'REAL' | 'JSON' | 'BOOLEAN'
  readonly primaryKey?: boolean
  readonly notNull?: boolean
  readonly unique?: boolean
  readonly defaultValue?: string | number | boolean | null
}

/** Table schema for structured tables */
export interface TableSchema {
  readonly columns: readonly TableColumnSchema[]
  readonly indexes?: readonly TableIndexSchema[]
  /**
   * COMPOSITE primary key, as column names (two or more). Emitted as a table
   * constraint; a column carries no `primaryKey` flag when this is set.
   */
  readonly primaryKey?: readonly string[]
  /** Emit `WITHOUT ROWID` (requires a primary key). */
  readonly withoutRowid?: boolean
}

/** Index definition for structured tables */
export interface TableIndexSchema {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique?: boolean
}

// =============================================================================
// Embeddings Backend (capability: 'embeddings', mode: singleton)
// =============================================================================

/**
 * Embeddings backend — vector storage with approximate nearest neighbor search.
 * Used for CLIP frame search, face recognition, plate matching.
 * Default implementation: HNSW (usearch/hnswlib). Can be replaced by Qdrant, etc.
 */
export interface IEmbeddingsBackend {
  /** Create or open a named vector index */
  openIndex(name: string, dimensions: number): Promise<IVectorIndex>

  /** List all index names */
  listIndexes(): Promise<readonly string[]>

  /** Delete an index and its data */
  deleteIndex(name: string): Promise<void>

  /** Lifecycle */
  initialize(): Promise<void>
  shutdown(): Promise<void>
}

export interface IVectorIndex {
  /** Index name */
  readonly name: string

  /** Vector dimensions */
  readonly dimensions: number

  /** Insert a vector with ID and optional metadata */
  insert(id: string, vector: Float32Array, metadata?: Record<string, unknown>): Promise<void>

  /** Batch insert for performance */
  insertBatch(items: readonly VectorEntry[]): Promise<void>

  /** Search for nearest neighbors */
  search(
    query: Float32Array,
    topK: number,
    filter?: EmbeddingFilter,
  ): Promise<readonly VectorSearchResult[]>

  /** Delete by ID */
  delete(id: string): Promise<void>

  /** Count entries in the index */
  count(): Promise<number>

  /** Flush pending writes to disk */
  flush(): Promise<void>
}

export interface VectorEntry {
  readonly id: string
  readonly vector: Float32Array
  readonly metadata?: Record<string, unknown>
}

export interface VectorSearchResult {
  readonly id: string
  /** Similarity score (0-1, higher is more similar) */
  readonly score: number
  readonly metadata?: Record<string, unknown>
}

export interface EmbeddingFilter {
  /** Filter by metadata key-value before vector search */
  readonly where?: Record<string, unknown>
  /** Filter by timestamp range */
  readonly timestampAfter?: number
  readonly timestampBefore?: number
  /** Filter by device */
  readonly deviceId?: string
}

// =============================================================================
// Legacy re-exports (deprecated — migrate to new interfaces)
// =============================================================================

/**
 * A document record in collection-based storage.
 * Used by IStructuredStorage and ElementConfigStore.
 * New code should prefer ISettingsBackend + SettingsRecord.
 */
export interface StorageRecord {
  collection: string
  id: string
  data: Record<string, unknown>
}

/**
 * Collection-based document storage (query, insert, update, delete).
 * Used by ElementConfigStore and StorageManager shim layer.
 * New code should prefer ISettingsBackend.
 */
export interface IStructuredStorage {
  query(collection: string, filter?: QueryFilter): Promise<readonly StorageRecord[]>
  insert(record: StorageRecord): Promise<StorageRecord>
  update(collection: string, id: string, data: Record<string, unknown>): Promise<StorageRecord>
  delete(collection: string, id: string): Promise<void>
  count(collection: string, filter?: QueryFilter): Promise<number>
}

/**
 * File-based storage operations.
 * Used by StorageManager and addons for media/model files.
 * New code should prefer IStorageProvider.
 */
export interface IFileStorage {
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Buffer): Promise<void>
  deleteFile(path: string): Promise<void>
  listFiles(prefix?: string): Promise<readonly string[]>
  getFileUrl(path: string): Promise<string>
  exists(path: string): Promise<boolean>
}

/**
 * Combined storage location with optional structured + file storage.
 * Used by StorageManager.getLocation() and ElementConfigStore.
 * New code should prefer IStorageProvider + ISettingsBackend.
 */
export interface IStorageLocation {
  structured?: IStructuredStorage
  files?: IFileStorage
}
