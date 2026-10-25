import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import {
  AggregateFieldSchema,
  AggregateResultSchema,
  BulkRecordSchema,
  DeclareCollectionInputSchema,
  MutationFilterSchema,
  QueryFilterSchema,
  SettingsRecordSchema,
  TransactGuardSchema,
  TransactOpSchema,
} from './settings-store.cap.js'

/**
 * What one engine says about itself. The orchestrator uses `kind` to pick
 * a registrant for a collection; `engineId` is what a log line names when
 * a call is routed or refused.
 */
const EngineInfoSchema = z.object({
  engineId: z.string(),
  /**
   * `relational` — rows, columns, indexes, the surface `settings-store`
   * has always described. `vector` — an embedding store answering
   * similarity queries. A registrant declares exactly one; an engine that
   * does both registers twice, because "both" would make the routing
   * decision ambiguous at exactly the point it must not be.
   */
  kind: z.enum(['relational', 'vector']),
  displayName: z.string(),
})

/**
 * data-store-provider — the engine contract behind the data door.
 *
 * The sibling of `storage-provider`, for rows instead of bytes. The
 * orchestrator (singleton `settings-store` cap, owned by the
 * storage-orchestrator builtin) dispatches every call to the registrant
 * that serves the collection.
 *
 * `internal: true` — consumed only by the orchestrator. Public consumers
 * go through `settings-store`; they never see this cap, and an engine
 * never sees a caller.
 *
 * ⚠ **`internal: true` DOES NOT gate the mount, and until 2026-08-26 this
 * comment claimed otherwise.** `resolveCapMount` never reads the field, so this
 * cap was live on the AppRouter with every method at the default
 * `auth: 'protected'` — i.e. readable by ANY authenticated session, admin or
 * not. Verified against the live hub: `dataStoreProvider.query` returned raw
 * settings rows including a provider credential, bypassing the secret redaction
 * that `deviceManager.listAll` and friends go through.
 *
 * Every method is now `auth: 'admin'` EXPLICITLY, including the five reads —
 * they had no options object at all, which is exactly how they kept the
 * permissive default while the mutations looked deliberate. The explicit
 * annotation is the fix that works today; making `internal` mean something at
 * mount time is the systemic one, and it is not free: 22 caps declare it, only
 * 4 are `mount: 'skip'`, and forcing admin on all of them would change the auth
 * of surfaces the viewer and admin-ui call as non-admin users. That decision is
 * the operator's, not a side effect of this file.
 *
 * Design notes:
 *   - **Stateless dispatch.** Every method carries its own
 *     `namespace` + `collection`, so an engine keeps no per-caller state
 *     and the orchestrator forwards the payload verbatim. Scoping is a
 *     property of the input, not of the connection — see the note on
 *     `settings-store` about what that does and does not guarantee.
 *   - **One registrant today** (`sqlite-settings`). The collection shape
 *     exists so a second engine is a registration rather than a second
 *     door ([D44](../../../../docs/decisions/adr-0044.md)).
 *
 * The method set is deliberately identical to `settings-store`'s: the
 * orchestrator is a router, not a translator. A capability the door
 * gains, an engine must be able to answer.
 */
export const dataStoreProviderCapability = {
  name: 'data-store-provider',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /** Self-description — how the orchestrator picks a registrant. */
    getEngineInfo: method(z.void(), EngineInfoSchema, { auth: 'admin' }),

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

    /** Get all entries matching an optional filter. */
    query: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        filter: QueryFilterSchema.optional(),
        /**
         * SQL-level column projection — MUST mirror `settings-store.query`.
         *
         * ⚠ An earlier version of this comment blamed Zod stripping, and that
         * was wrong — corrected 2026-08-26 after the hop map
         * (`docs/design/2026-08-26-topic-hop-map.md`) traced the path.
         * There is **no Zod parse at all** between the door and the engine: the
         * dispatcher forwards the payload verbatim and UDS carries it whole. A
         * field declared here reaches `SqliteSettingsBackend` either way.
         *
         * What actually lost `columns` was the THIRD declaration of this shape:
         * `SettingsQueryInput` in `interfaces/storage.ts`, a hand-written TS
         * interface the engine destructures from. The field existed on both
         * schemas and the engine still never read it, because nothing checks a
         * registered provider against `InferProvider<cap>` —
         * `ProviderRegistration.provider` is typed `object`.
         *
         * It is declared here anyway, and must stay in step with
         * `settings-store.query`: a caller reading only the cap definitions has
         * to be able to see that this call carries a projection.
         * `data-door-schema-parity.spec.ts` keeps the two aligned.
         */
        columns: z.array(z.string()).readonly().optional(),
      }),
      z.array(SettingsRecordSchema).readonly(),
      { auth: 'admin' },
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
     * Make a slot hold this row, and answer with the id the row HAS. The
     * engine half of `settings-store.upsert` — read that docblock for why the
     * store needed a slot that is not the primary key (D482).
     */
    upsert: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        conflict: z.array(z.string()).readonly(),
        record: BulkRecordSchema,
      }),
      z.object({ id: z.union([z.string(), z.number()]) }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Upsert many records in ONE transaction; see the door's `upsertMany`. */
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

    /** Insert many records in ONE transaction. All or nothing. */
    insertMany: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        records: z.array(BulkRecordSchema).readonly(),
      }),
      z.object({ inserted: z.number().int() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Several writes in ONE transaction behind an optional guard; see the door. */
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

    /** Delete every record matching `filter`, in one statement. */
    deleteWhere: method(
      z.object({
        namespace: z.string().optional(),
        collection: z.string(),
        filter: MutationFilterSchema,
      }),
      z.object({ deleted: z.number().int() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Apply `data` to every record matching `filter`, in one statement. */
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

    /** `COUNT(*)` plus one SUM/MIN/MAX per field, in one statement. Mirror of
     *  `settings-store.aggregate` — see it for why an unresolvable field is
     *  refused rather than dropped. */
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

    /** Declare a typed (SQL-backed) collection with columns + indexes. */
    declareCollection: method(DeclareCollectionInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IDataStoreProvider = InferProvider<typeof dataStoreProviderCapability>

export { EngineInfoSchema }
export type DataStoreEngineInfo = z.infer<typeof EngineInfoSchema>
