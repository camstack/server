import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * Query filter for settings-store collections.
 */
const QueryFilterSchema = z.object({
  where: z.record(z.string(), z.unknown()).optional(),
  whereIn: z.record(z.string(), z.array(z.unknown())).optional(),
  whereBetween: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])).optional(),
  /** NULL-safe exclusion: matches rows whose field is NULL OR != the value. */
  whereNot: z.record(z.string(), z.unknown()).optional(),
  /** NULL-safe exclusion of a SET — `whereNot` for more than one value. An
   *  empty list excludes nothing. See `QueryFilter.whereNotIn`. */
  whereNotIn: z.record(z.string(), z.array(z.unknown())).optional(),
  orderBy: z
    .object({
      field: z.string(),
      direction: z.enum(['asc', 'desc']),
    })
    .optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
})

/**
 * The predicate half of a filter, for BULK MUTATIONS.
 *
 * Deliberately not `QueryFilterSchema`: `orderBy` / `limit` / `offset` have no
 * meaning for a statement that rewrites a set, and accepting them would invite
 * a caller to believe `limit` bounds the damage. Every field is optional here
 * only so the shape stays composable — the implementation REJECTS a filter
 * that compiles to no predicate, because that is the whole collection.
 */
const MutationFilterSchema = z.object({
  where: z.record(z.string(), z.unknown()).optional(),
  whereIn: z.record(z.string(), z.array(z.unknown())).optional(),
  whereBetween: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])).optional(),
  whereNot: z.record(z.string(), z.unknown()).optional(),
  whereNotIn: z.record(z.string(), z.array(z.unknown())).optional(),
})

/**
 * One scalar an {@link settingsStoreCapability.methods.aggregate} call asks for.
 *
 * `as` names the slot in the result, so the SAME column may be asked twice with
 * two operations (`MIN(startMs)` and `MAX(startMs)` in one round trip) — which
 * a `Record<column, op>` shape could not express.
 */
const AggregateFieldSchema = z.object({
  /** Result key. */
  as: z.string().min(1),
  /** Column to aggregate. Must be a real column of a declared collection. */
  field: z.string().min(1),
  op: z.enum(['sum', 'min', 'max']),
})

/**
 * `COUNT(*)` plus one number per requested field.
 *
 * `null` means NO ROW MATCHED, never zero: a `SUM` over an empty set and a sum
 * that really is 0 are different facts, and an accounting caller that renders
 * "0 bytes, oldest = 0" for "nothing here" reports a lie about a disk.
 */
const AggregateResultSchema = z.object({
  count: z.number().int(),
  values: z.record(z.string(), z.number().nullable()),
})

/** A single stored record: `{ id, data }`. */
const SettingsRecordSchema = z.object({
  id: z.string(),
  data: z.record(z.string(), z.unknown()),
})

/**
 * One record of a BULK insert — {@link SettingsRecordSchema} with the id made
 * optional.
 *
 * A separate schema rather than loosening the shared one: every other method
 * on this cap addresses a row BY its id, and making that field optional
 * everywhere would turn a forgotten key into a silently generated one on
 * `update` and `delete` as well.
 */
const BulkRecordSchema = z.object({
  id: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
})

/**
 * The database FILES one `sqlite-settings` engine process owns (D851).
 * Closed on purpose: a file is a thing the engine opens, backs up and gives a
 * serving thread, so a new one is a code change, never a string a caller
 * invents. `settings` is `camstack.db` and the default for every collection
 * that names no file.
 */
const DataStoreDatabaseSchema = z.enum(['settings', 'events', 'history'])

/** Every database file, in a stable order (settings first). */
const DATA_STORE_DATABASES: readonly z.infer<typeof DataStoreDatabaseSchema>[] =
  DataStoreDatabaseSchema.options

/**
 * One write inside a {@link settingsStoreCapability.methods.transact} call.
 * The three that a "replace this set, bump that revision" write needs, plus
 * the batched upsert a rollup writer needs.
 */
const TransactOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('deleteWhere'),
    collection: z.string(),
    filter: MutationFilterSchema,
  }),
  z.object({
    op: z.literal('insertMany'),
    collection: z.string(),
    records: z.array(BulkRecordSchema).readonly(),
  }),
  z.object({
    op: z.literal('update'),
    collection: z.string(),
    id: z.string(),
    data: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal('upsertMany'),
    collection: z.string(),
    conflict: z.array(z.string()).readonly(),
    records: z.array(BulkRecordSchema).readonly(),
  }),
])

/**
 * The precondition of a transaction: the row `key` of `collection` must hold
 * `equals` in `column`, read INSIDE the transaction.
 */
const TransactGuardSchema = z.object({
  collection: z.string(),
  key: z.string(),
  column: z.string(),
  equals: z.unknown(),
})

/**
 * Column declaration for a structured (SQL-backed) collection.
 *
 * Logical types — the backend translates each to the matching SQLite
 * storage class and handles per-type marshaling:
 *   - `TEXT` / `INTEGER` / `REAL` — native SQLite types, pass-through
 *   - `JSON`    — TEXT under the hood; serialised on write, parsed on read
 *   - `BOOLEAN` — INTEGER 0/1 under the hood; coerced both directions
 */
const CollectionColumnSchema = z.object({
  name: z.string(),
  type: z.enum(['TEXT', 'INTEGER', 'REAL', 'JSON', 'BOOLEAN']),
  primaryKey: z.boolean().optional(),
  notNull: z.boolean().optional(),
  unique: z.boolean().optional(),
  /**
   * Column DEFAULT. Required for B2: the four `ensureTable` consumers declare
   * columns like `enabled INTEGER NOT NULL DEFAULT 1`, and without this the
   * collection surface simply cannot express their existing tables — which is
   * why they were still on the uncapped `table*` API.
   */
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
})

const CollectionIndexSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()).readonly(),
  unique: z.boolean().optional(),
})

/**
 * The input of `declareCollection` — ONE schema for the door and for the
 * engine behind it, so the two surfaces cannot drift (the dispatcher forwards
 * the payload untouched).
 *
 * - `database` — the file the collection lives in (D851). Absent means
 *   `settings`. A declaration naming a file other than the one the table is
 *   already in is REFUSED by the engine, never moved.
 * - `primaryKey` — a COMPOSITE key, as column names. A single name is the same
 *   as `primaryKey: true` on that column. A composite-keyed collection has no
 *   `id`: it is written with `insertMany` / `upsertMany` / `transact` and read
 *   with `query` / `count` / `aggregate` / `deleteWhere`; the calls that
 *   address one row by id are refused.
 * - `withoutRowid` — emit `WITHOUT ROWID`. Requires a primary key.
 */
const DeclareCollectionInputSchema = z.object({
  namespace: z.string().optional(),
  collection: z.string(),
  columns: z.array(CollectionColumnSchema).readonly(),
  indexes: z.array(CollectionIndexSchema).readonly().optional(),
  database: DataStoreDatabaseSchema.optional(),
  primaryKey: z.array(z.string()).readonly().optional(),
  withoutRowid: z.boolean().optional(),
})

/**
 * settings-store — singleton capability for addon-scoped persistence.
 *
 * Every method operates within a `collection`. An optional `namespace`
 * field provides access to additional data spaces beyond the default
 * addon settings — useful for business data (events, tracks, faces, etc.).
 *
 * **Scoping is the CALLER's, and it is opt-in.** The table is
 * `namespace ? `${namespace}:${collection}` : collection` — nothing
 * consults the identity of the caller. An earlier version of this comment
 * claimed the implementation prefixes every collection with the calling
 * addon's ID and that "addons never see each other's data"; that was never
 * true, and this same file contradicted it under `declareCollection`. What
 * exists is `addon-context-factory`, which passes `namespace: addonId` ON
 * THE ADDON'S BEHALF for the `addon-settings` / `addon-devices` paths only.
 * Business collections use bare names, and any caller may name any
 * namespace, or none. Making the door enforce it is tracked separately —
 * it renames tables, so it needs a migration.
 *
 * **So every method is `auth: 'admin'` (D634).** Because nothing scopes a
 * call to its caller, a `protected` method here was a raw, unredacted read
 * (and write) of every addon's collections for any role holding
 * `category:system` — which is every role: a `viewer` could read every
 * notifier token in plaintext from `notifiers:notification-targets`. No
 * browser or app client calls this cap. Addons are not affected: an
 * addon's `ctx.api` cap call is resolved to the provider directly and never
 * enters the tRPC router (so the tier gates sessions and tokens, never
 * addons), and the hub itself calls it through the capability registry.
 *
 *   - `{ collection: 'addon-settings' }` → table `addon-settings`
 *   - `{ namespace: 'my-addon', collection: 'addon-settings' }` →
 *     table `my-addon:addon-settings`
 *
 * Served by the **storage-orchestrator** builtin, which dispatches to the
 * `data-store-provider` engine registered for the collection
 * (`sqlite-settings`, a SQLite WAL backend, today). One addon owns the
 * data door; engines sit behind it
 * ([D44](../../../../docs/decisions/adr-0044.md)).
 * Addons access it via `ctx.api.settingsStore.*`.
 */
export const settingsStoreCapability = {
  name: 'settings-store',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /** Get a single value by key from a collection. */
    get: method(
      z.object({ namespace: z.string().optional(), collection: z.string(), key: z.string() }),
      z.unknown(),
      { auth: 'admin' },
    ),

    /** Set a value by key in a collection (upsert). */
    set: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        key: z.string(),
        value: z.unknown(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Rows matching a filter.
     *
     * `columns` is a SQL-level projection: the engine SELECTs only those
     * columns (plus the primary key) instead of the whole row. It is the only
     * way to stop paying disk for a column that is discarded — a heavy JSON
     * column dominates the row, and dropping it in JS after the read pays every
     * byte first. Measured on the live `pipeline-analytics:tracks` table: a
     * 501-row page is 4.6 MB whole and 0.11 MB projected, same index, same
     * plan.
     *
     * The engine REFUSES a column it cannot serve rather than omitting it —
     * see `SettingsQueryInput.columns` for why a projection may not be
     * forgiving the way a predicate is.
     */
    query: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        filter: QueryFilterSchema.optional(),
        columns: z.array(z.string()).readonly().optional(),
      }),
      z.array(SettingsRecordSchema).readonly(),
      { auth: 'admin' },
    ),

    /**
     * Make a SLOT hold this row — insert it, or update whatever already
     * occupies the slot — and answer with the id the row HAS.
     *
     * ## Why the store needed this
     *
     * {@link set} is already an upsert, but its slot is the PRIMARY KEY: the
     * caller has to know the id to address the row. That is exactly what a
     * collection keyed by an `INTEGER` rowid alias cannot do — SQLite assigns
     * the id, so a writer whose uniqueness rule is "one row per
     * `(ownerKind, ownerId, kind, slot)`" has no id to name and no way to
     * express the rule. {@link insert} can express it (a UNIQUE index
     * arbitrates) but only by THROWING at the loser of a race, and the loser
     * here is a legitimate re-capture, not an error.
     *
     * Getting there without this method means read-then-write: query the slot,
     * then `insert` or `update`. Two statements instead of one, a race between
     * them, and a recovery path that has to recognise a UNIQUE violation by its
     * MESSAGE — across a process boundary, because the store lives behind an
     * RPC door. A string match would be the whole gate, and a store that
     * rephrased its error would lose the row silently. One statement has no
     * such gate (D482).
     *
     * ## The contract
     *
     * `conflict` names the DECLARED columns that identify the slot. They must
     * be covered by a UNIQUE index on the collection — SQLite resolves an
     * `ON CONFLICT` target against its indexes and REFUSES the statement when
     * none matches, so a wrong list is a loud error on the first write, never a
     * silently duplicated row. An empty list is refused rather than passed on:
     * `ON CONFLICT()` is not valid SQL, and the intent it would most likely
     * encode ("no slot, just insert") is {@link insert}.
     *
     * Row shape is {@link insert}'s: `record.id` is used when the collection
     * needs a supplied key and IGNORED when the primary key is an `INTEGER`
     * rowid alias — exactly as `insert` and `insertMany` already treat it.
     *
     * Returns the id either way: the one SQLite assigned on an insert, or the
     * one the row it updated already had. A caller cannot tell which happened,
     * and deliberately — every caller wants the slot's id, and one that needed
     * to distinguish creation from replacement would have to read first anyway.
     */
    upsert: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        /** Declared columns identifying the slot; must be covered by a UNIQUE
         *  index on the collection. Never empty. */
        conflict: z.array(z.string()).readonly(),
        record: BulkRecordSchema,
      }),
      z.object({
        /** The id the row HAS: assigned by SQLite on an insert, or the existing
         *  row's own id on an update. */
        id: z.union([z.string(), z.number()]),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * {@link upsert} for a BATCH, in ONE transaction on ONE prepared statement.
     *
     * The write-side twin of {@link insertMany} for rows that may already
     * exist: a rollup writer recomputes a bucket and must overwrite it, and
     * N round trips with N COMMITs is the cost {@link insertMany} was added to
     * avoid. `conflict` has the meaning it has on {@link upsert} (declared
     * columns covered by a UNIQUE index or the primary key, never empty).
     *
     * Every record of a batch must carry the SAME set of declared columns and
     * every `conflict` column: one batch is one statement shape, and a record
     * that silently bound NULL over a column it did not mention would erase
     * it. A heterogeneous batch is refused whole. **All or nothing.**
     */
    upsertMany: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        conflict: z.array(z.string()).readonly(),
        records: z.array(BulkRecordSchema).readonly(),
      }),
      z.object({ upserted: z.number().int() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Insert a new record. */
    insert: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        // Optional id — an `INTEGER` primary key is a rowid alias and SQLite
        // assigns it, so a caller has nothing to supply (D473).
        record: z.object({
          id: z.string().optional(),
          data: z.record(z.string(), z.unknown()),
        }),
      }),
      z.object({
        /**
         * The id the row ACTUALLY got (D473): the one supplied, the UUID minted
         * for an absent one, or the ROWID SQLite assigned on an `INTEGER`
         * primary key — which is the only place an auto key is knowable.
         */
        id: z.union([z.string(), z.number()]),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Insert MANY records in ONE transaction, returning how many landed.
     *
     * The write-side twin of {@link deleteWhere}, and it exists for the same
     * reason: without it, appending a batch is N round trips and N COMMITs on
     * the single shared connection that also serves every cluster-wide
     * configuration read. The durable load series writes one process row per
     * process per sample — 76 rows every 10 s on the live fleet — and the
     * operator's rule for it is *one transaction per sample, never one per
     * row*. `insert` cannot express that; nothing else could.
     *
     * **All or nothing.** A batch that fails on its fifth row leaves none of
     * the five behind. A half-written sample is worse than a missing one: the
     * missing one reads as "nobody reported", which is true, while the half
     * one reads as "these were the only processes running", which is not.
     *
     * `id` is OPTIONAL per record, and that is the difference from
     * {@link insert}. A collection whose primary key is an `INTEGER` rowid
     * alias has no id to supply — SQLite assigns it, for free, and inventing a
     * `randomUUID()` for such a column would write a 36-character string into
     * an integer key. Omitted on a TEXT key, a uuid is generated exactly as
     * `insert` does.
     */
    insertMany: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        records: z.array(BulkRecordSchema).readonly(),
      }),
      z.object({ inserted: z.number().int() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Several writes, ONE transaction, behind an optional precondition.
     *
     * The multi-collection twin of {@link insertMany}: a write that has to move
     * a set of rows in one collection AND a revision in another cannot be
     * expressed as separate calls without a window in which a reader (or a
     * crash) sees half of it. The retrain annotation save replaces a frame's
     * rows, its dismissed set and its revision this way.
     *
     * `guard`, when given, is read inside the transaction: if the row is
     * missing or its column differs from `equals`, NOTHING is written and the
     * answer is `{ applied: false, current }` with what was found — the
     * compare-and-set a revisioned write needs, with no second reader able to
     * slip between the check and the writes.
     *
     * **All or nothing**, like {@link insertMany}: a throw in any op rolls the
     * whole call back. Ops run in the order given (delete before insert to
     * replace a set). `namespace` applies to every collection named.
     */
    transact: method(
      z.object({
        namespace: z.string().optional(),
        guard: TransactGuardSchema.optional(),
        ops: z.array(TransactOpSchema).readonly(),
      }),
      z.object({ applied: z.boolean(), current: z.unknown().optional() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Update an existing record by ID. */
    update: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        id: z.string(),
        data: z.record(z.string(), z.unknown()),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Delete a record by key/ID. */
    delete: method(
      z.object({ namespace: z.string().optional(), collection: z.string(), key: z.string() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Delete every record matching `filter`, in ONE statement, returning how
     * many rows went. This exists because its absence made every retention
     * path in the system an N+1 drain loop: `delete` takes a key, so a sweep
     * had to SELECT a page of full rows — every column, including the fat
     * ones — purely to learn their ids, then issue one call per row.
     *
     * **The filter is required and must resolve.** A predicate naming
     * something the collection cannot express is an ERROR here, not a
     * widening as it is on `query`, and a filter with no predicates is an
     * error rather than "every row". Deleting a whole collection is a
     * legitimate intent, but it must be asked for by name — not reached by
     * an empty object.
     */
    deleteWhere: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        filter: MutationFilterSchema,
      }),
      z.object({ deleted: z.number().int() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Apply `data` to every record matching `filter`, in one statement,
     * returning how many rows changed. Same filter contract as
     * {@link deleteWhere} — an unresolvable predicate is an error.
     */
    updateWhere: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        filter: MutationFilterSchema,
        data: z.record(z.string(), z.unknown()),
      }),
      z.object({ updated: z.number().int() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Count entries in a collection, optionally filtered. */
    count: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        filter: QueryFilterSchema.optional(),
      }),
      z.number(),
      { auth: 'admin' },
    ),

    /**
     * `COUNT(*)` and one `SUM` / `MIN` / `MAX` per requested field, in ONE
     * statement, over the rows `filter` selects.
     *
     * Exists because "how much is there" was being answered by materialising
     * "what is there". The recorder's storage-pressure sweep asked its in-RAM
     * footage index for bytes/count/oldest/newest across a set of storage
     * locations twice a minute, and the only way to answer that from a map is
     * to visit every row — 7.1 M of them on the live hub, ~15 M row visits a
     * minute on the main thread, which is also why the whole archive had to
     * stay resident to be visited. The question is a sum; nothing needs to be
     * materialised to answer it.
     *
     * **The engine REFUSES a field it cannot serve**, exactly as
     * `query.columns` does and unlike a PREDICATE, which is skipped when
     * unresolvable. A dropped predicate over-matches and the caller sees extra
     * rows; a dropped aggregate returns a NUMBER that is wrong and looks
     * exactly like a real one. That asymmetry is what this repo has already
     * paid for once in `count`.
     */
    aggregate: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        fields: z.array(AggregateFieldSchema).readonly(),
        filter: QueryFilterSchema.optional(),
      }),
      AggregateResultSchema,
      { auth: 'admin' },
    ),

    /** Grouped counts per ((field-origin)/bucketSize) bucket, filtered. */
    histogram: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        field: z.string(),
        bucketSize: z.number().int().positive(),
        origin: z.number().int(),
        filter: QueryFilterSchema.optional(),
      }),
      z.array(z.object({ bucket: z.number().int(), count: z.number().int() })).readonly(),
      { auth: 'admin' },
    ),

    /** Check if a collection is empty. */
    isEmpty: method(
      z.object({ namespace: z.string().optional(), collection: z.string() }),
      z.boolean(),
      { auth: 'admin' },
    ),

    /**
     * Declare a typed (SQL-backed) collection with explicit columns +
     * indexes. Idempotent: re-declaring an existing collection with the
     * same shape is a no-op; shape changes (new columns, new indexes)
     * are applied additively. Subsequent `insert` / `update` / `delete`
     * / `query` calls on this collection use typed columns instead of
     * JSON-blob storage — `record.data` fields are spread across
     * columns, `query.filter.where` matches real columns (no
     * `json_extract` overhead), `orderBy` uses column indexes.
     *
     * Addons call this in `onInitialize` before their first read/write.
     * Collection names should be namespaced by addon (e.g.
     * `pipeline-analytics:object-events`) to avoid cross-addon
     * clashes — no automatic prefix is added.
     */
    declareCollection: method(DeclareCollectionInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type ISettingsStoreProvider = InferProvider<typeof settingsStoreCapability>

/**
 * tRPC client namespace type for the settings-store capability.
 * Used as the dependency type for services that need settings persistence.
 * Methods are accessed as `client.get.query(input)`, `client.set.mutate(input)`, etc.
 */
export type SettingsStoreClient = import('../generated/addon-api.js').AddonApi['settingsStore']

export {
  AggregateFieldSchema,
  DATA_STORE_DATABASES,
  DataStoreDatabaseSchema,
  DeclareCollectionInputSchema,
  AggregateResultSchema,
  BulkRecordSchema,
  CollectionColumnSchema,
  CollectionIndexSchema,
  MutationFilterSchema,
  QueryFilterSchema,
  SettingsRecordSchema,
  TransactGuardSchema,
  TransactOpSchema,
}

export type BulkRecord = z.infer<typeof BulkRecordSchema>

export type AggregateField = z.infer<typeof AggregateFieldSchema>
export type AggregateResult = z.infer<typeof AggregateResultSchema>

export type MutationFilter = z.infer<typeof MutationFilterSchema>

export type CollectionColumn = z.infer<typeof CollectionColumnSchema>
export type CollectionIndex = z.infer<typeof CollectionIndexSchema>

export type DataStoreDatabase = z.infer<typeof DataStoreDatabaseSchema>
export type DeclareCollectionInput = z.infer<typeof DeclareCollectionInputSchema>
