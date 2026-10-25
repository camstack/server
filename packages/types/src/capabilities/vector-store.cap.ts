import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * vector-store — the dedicated home for embedding vectors and similarity search.
 *
 * ## Why this is a capability and not a helper
 *
 * This capability was introduced with the claim that SIX stores in
 * `addon-post-analysis` held vectors in a `JSON` settings-store column — object
 * CLIP, face, plate, vehicle, identity, and the event store's derivatives. That
 * claim was never true, and leaving it here made five stores look like pending
 * work when three of them have no vector at all. Counted column by column on
 * 2026-08-30, exactly THREE ever held one:
 *
 *  - `object-clip`      — 512-dim CLIP image embedding, migrated 2026-08-06.
 *  - `faces.embedding`  — 512-dim ArcFace face embedding, migrated 2026-08-30.
 *  - `identity-samples.embedding` — the same ArcFace vector for an ENROLLED
 *    face, migrated 2026-08-30 into its OWN index (see below).
 *
 * `plates` and `vehicle-samples` store a plate STRING and a score; `vehicles`
 * and `identities` store a name; the event store stores no derivative vector.
 * They are not migration candidates and never were.
 *
 * Measured on the live hub the JSON encoding cost ~11.7 KB per row (512 floats
 * as TEXT, `JSON.parse`d on every search) and made semantic search load 5,000
 * rows before ranking anything.
 *
 * ## One index per COMPARISON, never per encoder
 *
 * `faces` and `identity-samples` hold the same 512 ArcFace dims from the same
 * model, and they still get two indexes. An index is a set of things that are
 * ranked against each other and that live and die together, and these two are
 * neither: a `faces` row is TRACK-OWNED and cascades away with its track under
 * a per-camera capacity cap, an `identity-samples` row is retention-EXEMPT
 * forever and is the gallery every recognition ranks against. One index would
 * mean every gallery load and every reconcile carried a filter whose failure
 * mode is either ranking a candidate against itself or reclaiming an enrolled
 * person's only sample. The dimension they share is not a reason to share an
 * index; the question they answer is, and it differs.
 *
 * The fix is not a faster loop, it is a different backend — and the backend
 * should be replaceable without touching six callers. So: a singleton
 * capability. The provider shipped today is SQLite-backed brute force over
 * COMPACT rows; an ANN index (sqlite-vec, usearch, …) can replace it later by
 * registering a different provider and `setActiveSingleton`, with no caller
 * change. That is the whole point of putting it here.
 *
 * ## Wire format: base64, deliberately
 *
 * `vector` is base64 of little-endian Float32 — NOT `number[]`, and NOT a
 * `Float32Array`. Both alternatives have already cost this repo:
 * a `Float32Array` does not survive msgpack across the UDS transport (it arrived
 * as an empty object and froze audio dBFS), and `number[]` is the ~5x-larger
 * encoding this capability exists to stop paying. A 512-dim vector is 2,048
 * bytes raw, 2,732 as base64, against ~10-12 KB as JSON text.
 *
 * Helpers for both directions live in `@camstack/types` —
 * `encodeVectorBase64` / `decodeVectorBase64` — so no caller hand-rolls the
 * byte order.
 */

/** Similarity metric an index ranks by. */
export const VectorMetricSchema = z.enum(['cosine', 'dot', 'euclidean'])
export type VectorMetric = z.infer<typeof VectorMetricSchema>

/**
 * Scalar metadata carried alongside a vector.
 *
 * Deliberately flat and scalar: it is what {@link VectorFilterSchema} can filter
 * on, and a nested object cannot be indexed by any backend worth swapping in.
 * Callers keep their rich records in their own store and put only the filterable
 * columns here (deviceId, timestamp, className, modelId, …).
 */
export const VectorMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
)
export type VectorMetadata = z.infer<typeof VectorMetadataSchema>

/**
 * Prefilter applied BEFORE ranking.
 *
 * `equals` and `between` are ANDed. A backend that cannot push a clause down
 * must still apply it — a filter that is silently ignored returns results the
 * caller will treat as matches.
 */
export const VectorFilterSchema = z.object({
  equals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  between: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
})
export type VectorFilter = z.infer<typeof VectorFilterSchema>

/** One vector plus its identity and filterable metadata. */
export const VectorItemSchema = z.object({
  /** Caller-owned primary key. Upsert replaces the row with this id. */
  id: z.string(),
  /** base64 of little-endian Float32. See the module docblock. */
  vector: z.string(),
  metadata: VectorMetadataSchema,
})
export type VectorItem = z.infer<typeof VectorItemSchema>

/** A ranked hit. */
export const VectorMatchSchema = z.object({
  id: z.string(),
  /** Similarity under the index's metric; higher is nearer for cosine/dot. */
  score: z.number(),
  metadata: VectorMetadataSchema,
})
export type VectorMatch = z.infer<typeof VectorMatchSchema>

export const VectorDeclareIndexInputSchema = z.object({
  index: z.string(),
  /** Vector length. An item of a different length is rejected, not coerced. */
  dim: z.number().int().positive(),
  metric: VectorMetricSchema.default('cosine'),
})

export const VectorUpsertInputSchema = z.object({
  index: z.string(),
  items: z.array(VectorItemSchema),
})

export const VectorUpsertResultSchema = z.object({
  upserted: z.number(),
  /** Items refused for a dim mismatch. Never silent — see D-rule on dropped work. */
  rejected: z.number(),
})

export const VectorQueryInputSchema = z.object({
  index: z.string(),
  /** base64 Float32LE query vector. */
  vector: z.string(),
  topK: z.number().int().positive(),
  /** Drop matches scoring below this. */
  minScore: z.number().optional(),
  filter: VectorFilterSchema.optional(),
})

export const VectorQueryResultSchema = z.object({
  matches: z.array(VectorMatchSchema),
  /**
   * Rows the backend actually compared. When this equals the index size the
   * search was exhaustive; when it is lower the backend approximated or
   * truncated, and the caller can say so instead of reporting "nothing older
   * matched".
   */
  scanned: z.number(),
  /** True when the backend could not consider every row that passed the filter. */
  truncated: z.boolean(),
  /**
   * The `topK` the backend actually ran with.
   *
   * Every backend has a ceiling — sqlite-vec's is 4,096 — and a caller asking
   * past it used to learn nothing but a boolean, from a WARN in the provider's
   * own log rather than in its answer. That is how an audit asking for 20,000
   * consumed 4,096 and reported `examined: 4096` as if it had walked the index,
   * for weeks. `truncated` says THAT the answer was short; this says BY HOW
   * MUCH, in the return value, where the caller cannot fail to see it.
   *
   * Equals the requested `topK` whenever nothing was lowered.
   */
  effectiveTopK: z.number().int().positive(),
})

export const VectorDeleteInputSchema = z.object({
  index: z.string(),
  ids: z.array(z.string()),
})

export const VectorDeleteByFilterInputSchema = z.object({
  index: z.string(),
  filter: VectorFilterSchema,
})

export const VectorDeleteResultSchema = z.object({ deleted: z.number() })

export const VectorGetInputSchema = z.object({
  index: z.string(),
  ids: z.array(z.string()),
})

/**
 * Metadata for the requested ids, WITHOUT their vectors.
 *
 * The only caller is a best-of gate that compares a candidate's confidence
 * against the stored one, and shipping 512 floats back to answer "is 0.91 >
 * 0.87" would undo the point of the compact encoding. Ids with no row are
 * simply absent — a caller distinguishing "not stored" from "stored" reads the
 * length, and a null placeholder would invite a `?? 0` that treats a missing
 * row as confidence zero.
 */
export const VectorGetResultSchema = z.object({
  items: z.array(z.object({ id: z.string(), metadata: VectorMetadataSchema })),
})

/**
 * Ids to read back WITH their vectors.
 *
 * The sibling of {@link VectorGetResultSchema}, and deliberately a separate
 * method rather than a flag on it: `getByIds` promises no vectors and its one
 * caller depends on that promise. This one promises the opposite.
 *
 * It exists because a store cannot put its vectors here otherwise. An ArcFace
 * gallery is ranked IN PROCESS, per detection, against every enrolled sample —
 * a per-face cross-process KNN would be a network round trip inside the
 * recognition loop. So the gallery is loaded once and held in RAM, and loading
 * it requires the index to hand the floats back. Without this method the only
 * way to keep a readable vector is a JSON column, which is the thing this
 * capability exists to delete.
 *
 * BOUNDED BY THE CALLER: ids are named, never "everything". Enumerating an
 * index is {@link VectorScanInputSchema}'s job, and it returns no vectors.
 */
export const VectorFetchInputSchema = z.object({
  index: z.string(),
  ids: z.array(z.string()),
})

export const VectorFetchResultSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      /** base64 Float32LE — the same wire form `upsert` accepts. */
      vector: z.string(),
      metadata: VectorMetadataSchema,
    }),
  ),
})

/**
 * ENUMERATE an index: one page of rows in a stable order, no ranking.
 *
 * A reconcile does not want the nearest rows, it wants ALL of them, and asking
 * a KNN for "all" is the wrong question twice over. It hits the backend's `k`
 * ceiling — 4,096 on sqlite-vec against a 22,128-row index — and it needs a
 * probe vector it does not have, so the audit passed a ZERO vector whose cosine
 * distance to every row is degenerate. `examined: 4096` then read as "we
 * looked" for as long as anyone cared to read it.
 *
 * This is the primitive that question actually needs: a bounded page, ordered
 * by the backend's own row order, costing no distance computation at all.
 * Vectors are NOT returned — an enumeration that shipped 2 KB per row would be
 * the full-table read this capability was built to stop.
 */
export const VectorScanInputSchema = z.object({
  index: z.string(),
  /** Opaque resume point. `0` starts at the top; pass back `nextCursor`. */
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive(),
})

export const VectorScanResultSchema = z.object({
  items: z.array(z.object({ id: z.string(), metadata: VectorMetadataSchema })),
  /**
   * Where the next page starts, or `null` when the walk reached the end.
   *
   * `null` is the ONLY end-of-index signal. A caller must not infer the end
   * from a short page: a backend is free to return fewer rows than asked.
   */
  nextCursor: z.number().int().nonnegative().nullable(),
})

/**
 * The ONE error code for "this index exists at another dimension; refusing to
 * redeclare it" (D649). It rides in the MESSAGE — an Error's own properties do
 * not survive the UDS/tRPC hop, its message does — and both sides go through
 * the helpers below, never a copied phrase: a consumer that must tell "this
 * index can never hold my vectors" from "the provider is unreachable" (a
 * delete counts the first as nothing-to-delete and the second as still
 * present) otherwise breaks silently the day the wording changes.
 */
export const VECTOR_INDEX_DIM_CONFLICT = 'vector-index-dim-conflict'

/** The provider's refusal, carrying {@link VECTOR_INDEX_DIM_CONFLICT}. */
export function vectorIndexDimConflictError(
  index: string,
  declaredDim: number,
  requestedDim: number,
): Error {
  return new Error(
    `[${VECTOR_INDEX_DIM_CONFLICT}] vector-store: index "${index}" is declared with dim ${String(declaredDim)}; refusing to redeclare as ${String(requestedDim)}`,
  )
}

/** True when `err` (possibly re-wrapped by a transport) is that refusal. */
export function isVectorIndexDimConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes(`[${VECTOR_INDEX_DIM_CONFLICT}]`)
}

export const VectorStatsInputSchema = z.object({ index: z.string() })

export const VectorStatsResultSchema = z.object({
  /** Provider id, so an operator can tell brute force from an ANN index. */
  backend: z.string(),
  count: z.number(),
  dim: z.number(),
  metric: VectorMetricSchema,
  /** Bytes on disk for this index, when the backend can report it. */
  bytes: z.number().optional(),
  /** False when the backend ranks approximately. */
  exact: z.boolean(),
})

/**
 * `internal: true` did not gate the mount (see the 2026-08-26 note on
 * `data-store-provider`) — every method below was reachable on the AppRouter
 * by ANY authenticated session at the default `auth: 'protected'`. The only
 * consumers (`addon-post-analysis`'s embedding stores) reach this cap via
 * `ctx.api` — UDS/Moleculer, never tRPC — so `auth: 'admin'` on every method
 * costs them nothing. No client (viewer or admin-ui) calls `vectorStore.*`.
 */
export const vectorStoreCapability = {
  name: 'vector-store',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /** Idempotent. Re-declaring with a different `dim` is an error, not a wipe. */
    declareIndex: method(VectorDeclareIndexInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    upsert: method(VectorUpsertInputSchema, VectorUpsertResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    query: method(VectorQueryInputSchema, VectorQueryResultSchema, { auth: 'admin' }),
    /** Metadata by id, no vectors — see {@link VectorGetResultSchema}. */
    getByIds: method(VectorGetInputSchema, VectorGetResultSchema, { auth: 'admin' }),
    /** Metadata AND vectors, by named id — see {@link VectorFetchInputSchema}. */
    fetchByIds: method(VectorFetchInputSchema, VectorFetchResultSchema, { auth: 'admin' }),
    /** One page of the whole index, unranked — see {@link VectorScanInputSchema}. */
    scan: method(VectorScanInputSchema, VectorScanResultSchema, { auth: 'admin' }),
    deleteByIds: method(VectorDeleteInputSchema, VectorDeleteResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    deleteByFilter: method(VectorDeleteByFilterInputSchema, VectorDeleteResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    stats: method(VectorStatsInputSchema, VectorStatsResultSchema, { auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type IVectorStoreProvider = InferProvider<typeof vectorStoreCapability>
