/**
 * ObjectEmbeddingStore — per-track CLIP image embeddings, in the `vector-store`
 * capability.
 *
 * ## What this used to be
 *
 * Until 2026-08-06 this owned a `pipeline-analytics:object-embeddings` settings
 * collection whose `embedding` column was a JSON array of 512 floats — measured
 * at ~11.7 KB per row on the live hub and `JSON.parse`d 5,000 times on every
 * semantic search. That collection is gone. The vector store is now the only
 * home for these vectors: base64 Float32LE (2,732 bytes for the same 512 dims),
 * with `deviceId` / `timestamp` / `className` / `modelId` promoted to indexed
 * columns so prefilters are pushed into SQL rather than applied after loading.
 *
 * The dual-write mirror and the boot backfill that carried the transition were
 * deleted along with the collection: the index converged (8,467 = 8,467, delta
 * 0) and a migration aid left running is just a second writer nobody reads.
 *
 * ## What did NOT change
 *
 * One row per track, keyed by `trackId`, holding the track's best-confidence
 * detection. The confidence gate lives here rather than in the caller because
 * the in-memory `TrackBestSelector` resets on restart and this is the durable
 * half — see `best-selection-policies.ts`.
 */

import {
  encodeVectorBase64,
  type IScopedLogger,
  isVectorIndexDimConflict,
  vectorDimFromBase64,
  type VectorFilter,
  type VectorMetadata,
} from '@camstack/types'
import type { ClipModelRegistry, ClipVectorSpace } from '../../shared/clip/clip-model-registry.js'
import type { TrackCascadeLeafCount } from '../pipeline/delete-track-cascade.js'
import type { TrackFusionLeafCount, TrackFusionRequest } from '../pipeline/track-fusion-leaf.js'
import { type EmbeddingRefusal, EmbeddingRefusalReport } from './embedding-refusal-report.js'

/** Everything about a row except the vector itself. */
interface ObjectEmbeddingWriteBase {
  trackId: string
  deviceId: number
  timestamp: number
  className: string
  modelId: string
  confidence: number
  mediaId?: number
  keyFrameMediaId?: number
  /** Skip the best-confidence gate entirely — the rebuild path. */
  force?: boolean
}

/**
 * A row to write, carrying the vector in EITHER form — exactly one of them.
 *
 * The live path holds a decoded `number[]` (the executor's own output). The
 * REBUILD receives the vector from `pipelineRunner.runDetailSubtree` already
 * base64-encoded, which is also the vector store's wire form: decoding it just
 * so `encodeVectorBase64` can re-encode it is a pointless round trip through
 * hundreds of boxed doubles per track, and a second place for the two
 * encodings to disagree. A union rather than two optional fields, so "neither"
 * and "both" are not representable.
 */
export type ObjectEmbeddingWrite =
  | (ObjectEmbeddingWriteBase & {
      embedding: readonly number[]
      embeddingBase64?: undefined
    })
  | (ObjectEmbeddingWriteBase & {
      embeddingBase64: string
      embedding?: undefined
    })

/** The stored form plus its dimension, or `null` when the vector is unusable. */
interface ResolvedVector {
  readonly base64: string
  readonly dim: number
}

/**
 * Reduce either input form to the stored form.
 *
 * A base64 payload passes through untouched; its dimension is read from the
 * byte length. A length that is not a whole number of float32s cannot be a
 * vector, and storing it would produce a row whose dimension silently
 * disagrees with the declared index.
 */
function resolveVectorPayload(input: ObjectEmbeddingWrite): ResolvedVector | null {
  if (input.embeddingBase64 !== undefined) {
    // `vectorDimFromBase64` FLOORS, so it reports a plausible dimension for a
    // truncated payload. Check the byte length directly: a length that is not a
    // multiple of 4 is not a float32 vector, and a row stored from one would
    // rank against full-length vectors and produce a believable score.
    const byteLength = Buffer.from(input.embeddingBase64, 'base64').byteLength
    if (byteLength === 0 || byteLength % 4 !== 0) return null
    return { base64: input.embeddingBase64, dim: vectorDimFromBase64(input.embeddingBase64) }
  }
  if (input.embedding.length === 0) return null
  return { base64: encodeVectorBase64(input.embedding), dim: input.embedding.length }
}

/** One stored embedding, as callers see it. */
export interface ObjectEmbedding {
  readonly id: string
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly className: string
  readonly modelId: string
  readonly confidence: number
  readonly mediaId?: number
  /** MediaStore row id of the track's native key frame (best-detection full frame). */
  readonly keyFrameMediaId?: number
}

/** A ranked search hit: the stored row plus its similarity score. */
export interface ScoredObjectEmbedding {
  readonly row: ObjectEmbedding
  readonly score: number
}

/** Outcome of a ranked search, carrying whether the scan was exhaustive. */
export interface ObjectEmbeddingSearchResult {
  readonly hits: readonly ScoredObjectEmbedding[]
  readonly scanned: number
  readonly truncated: boolean
  /**
   * The `topK` the backend actually ran with, which is not always the one asked
   * for: sqlite-vec caps a KNN at 4,096. Carried up from the capability so a
   * caller can print the two numbers side by side instead of inferring a
   * ceiling from a boolean.
   */
  readonly effectiveTopK: number
}

/**
 * The slice of the generated `vector-store` client this store uses.
 *
 * Narrowed rather than taking the whole client so a test fake needs no cast.
 * Array members are mutable because that is what the generated tRPC input types
 * are — a `readonly` array is not assignable to them.
 */
export interface ObjectVectorStoreClient {
  readonly declareIndex: {
    mutate: (input: {
      index: string
      dim: number
      metric: 'cosine' | 'dot' | 'euclidean'
    }) => Promise<unknown>
  }
  readonly upsert: {
    mutate: (input: {
      index: string
      items: Array<{ id: string; vector: string; metadata: VectorMetadata }>
    }) => Promise<{ upserted: number; rejected: number }>
  }
  readonly query: {
    query: (input: {
      index: string
      vector: string
      topK: number
      minScore?: number
      filter?: VectorFilter
    }) => Promise<{
      matches: Array<{ id: string; score: number; metadata: VectorMetadata }>
      scanned: number
      truncated: boolean
      effectiveTopK: number
    }>
  }
  readonly getByIds: {
    query: (input: {
      index: string
      ids: string[]
    }) => Promise<{ items: Array<{ id: string; metadata: VectorMetadata }> }>
  }
  /** Metadata AND vectors, by named id — the fusion leaf's only read of the
   *  absorbed piece's floats, so they can be carried to the survivor. */
  readonly fetchByIds: {
    query: (input: {
      index: string
      ids: string[]
    }) => Promise<{ items: Array<{ id: string; vector: string; metadata: VectorMetadata }> }>
  }
  readonly deleteByIds: {
    mutate: (input: { index: string; ids: string[] }) => Promise<{ deleted: number }>
  }
  readonly deleteByFilter: {
    mutate: (input: { index: string; filter: VectorFilter }) => Promise<{ deleted: number }>
  }
  readonly scan: {
    query: (input: { index: string; cursor: number; limit: number }) => Promise<{
      items: Array<{ id: string; metadata: VectorMetadata }>
      nextCursor: number | null
    }>
  }
}

/**
 * One index row as the ORPHAN SCAN sees it: an id, the track it claims, and
 * the instant the grace window is measured against. No vector — enumerating
 * 22,128 rows of 2 KB to ask "does this track still exist" is the read this
 * store was moved out of a JSON column to stop making.
 */
export interface ObjectEmbeddingRef {
  readonly id: string
  /** `null` when the row names no track — counted, NEVER reclaimed. */
  readonly trackId: string | null
  readonly deviceId: number | null
  readonly timestamp: number | null
}

/** One page of {@link ObjectEmbeddingStore.scanRefs}. */
export interface ObjectEmbeddingScanPage {
  readonly rows: readonly ObjectEmbeddingRef[]
  /** `null` = the walk reached the end of the index. Never inferred from a
   *  short page — see `VectorScanResultSchema`. */
  readonly nextCursor: number | null
}

export interface ObjectEmbeddingStoreDeps {
  readonly vectorStore: ObjectVectorStoreClient
  readonly logger: IScopedLogger
  /**
   * Which index each CLIP model writes, and every index there is (D649). ONE
   * feature space per index: a write, a search and a model-space count go to
   * the index of the model they name; a delete, a scan and a wipe reach EVERY
   * index, so a track's vector cannot outlive it in an index nobody searches.
   */
  readonly clipModels: ClipModelRegistry
  /** One refusal line per this interval per (camera, model, reason) — D658. */
  readonly refusalReportIntervalMs?: number
  /** Injected clock for the refusal report. */
  readonly now?: () => number
}

/**
 * What a write actually did.
 *
 * Three states rather than a boolean, because "did not write" has two causes a
 * caller must not conflate: the best-confidence gate declining (`skipped` —
 * normal, the stored row is better) and the write not landing (`failed` —
 * something is wrong and the index is now behind).
 */
export type EmbeddingWriteOutcome = 'persisted' | 'skipped' | 'failed'

export class ObjectEmbeddingStore {
  private readonly vectorStore: ObjectVectorStoreClient
  private readonly logger: IScopedLogger
  private readonly clipModels: ClipModelRegistry
  /** index → the dim this process declared it at. Per index, per process. */
  private readonly declaredDims = new Map<string, number>()

  /**
   * Refused writes, COUNTED per (camera, model, reason). A refusal is systemic
   * — a runner stamping the wrong model refuses every vector it sends — so a
   * per-track WARN was a flood that hid the one fact that mattered (D658).
   */
  private readonly refusals: EmbeddingRefusalReport

  constructor(deps: ObjectEmbeddingStoreDeps) {
    this.vectorStore = deps.vectorStore
    this.logger = deps.logger
    this.clipModels = deps.clipModels
    this.refusals = new EmbeddingRefusalReport({
      logger: deps.logger,
      ...(deps.refusalReportIntervalMs !== undefined
        ? { intervalMs: deps.refusalReportIntervalMs }
        : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    })
  }

  /**
   * Count a write refused BEFORE it reached this store — a detail whose result
   * named no model (D658). Same report, same rate limit, as the refusals the
   * store makes itself.
   */
  noteRefused(refusal: EmbeddingRefusal): void {
    this.refusals.note(refusal)
  }

  /** Report every refusal count still pending (shutdown). */
  flushRefusals(): void {
    this.refusals.flush()
  }

  /** Every index a delete, scan or wipe must reach. */
  indexes(): readonly ClipVectorSpace[] {
    return this.clipModels.spaces()
  }

  /** The index a model's vectors live in, or `null` for a non-CLIP id. */
  indexFor(modelId: string): string | null {
    return this.clipModels.spaceFor(modelId)?.index ?? null
  }

  /**
   * Declare an index lazily, on first use, at the dimension its models'
   * metadata names (D649) — before any read, write or delete touches it.
   *
   * Returns false when declaration failed, and the caller must then skip the
   * operation: the provider rejects any call on an index it has never seen. A
   * dim change against a populated index is REFUSED rather than wiping it —
   * which is why a new model gets a new index instead of reusing one.
   *
   * `declaredDims` caches each declaration, and that cache is per-PROCESS while
   * the index lives in whichever addon currently provides `vector-store`. When
   * the active provider changed under a running hub the cache stayed warm
   * against an index that no longer existed, and every write from then on threw
   * `index "object-clip" was never declared` — for hours, until the addon was
   * restarted by hand. So a failed write clears the cache (see
   * {@link upsertIfBetter}) and the next one re-declares.
   */
  private async ensureIndex(space: ClipVectorSpace): Promise<boolean> {
    return (await this.declare(space)) === 'declared'
  }

  /**
   * Declare, and say WHY it failed. The two failures mean opposite things to a
   * delete: `refused` (the provider holds this index at another dimension) is
   * an index this store never wrote — nothing of ours to delete there; while
   * `unreachable` (the provider is down, a runner restarting) says nothing
   * about the rows — they may well be there, so a delete must report them as
   * still present. Folding the two let an outage read as a deletion, and the
   * retention cascade then deleted the tracks whose vectors survived.
   */
  private async declare(space: ClipVectorSpace): Promise<IndexDeclaration> {
    if (this.declaredDims.get(space.index) === space.dim) return 'declared'
    try {
      await this.vectorStore.declareIndex.mutate({
        index: space.index,
        dim: space.dim,
        metric: 'cosine',
      })
      this.declaredDims.set(space.index, space.dim)
      return 'declared'
    } catch (err) {
      const refused = isVectorIndexDimConflict(err)
      this.logger.warn('object-embedding index declaration failed — writes disabled for this dim', {
        meta: {
          index: space.index,
          dim: space.dim,
          cause: refused ? 'dimension-refused' : 'unreachable',
          error: String(err),
        },
      })
      return refused ? 'refused' : 'unreachable'
    }
  }

  /**
   * The space a write or read names, or `null` — said out loud, because a
   * vector whose model has no CLIP metadata has nowhere to go and nothing to be
   * ranked against.
   */
  private spaceOrWarn(modelId: string, op: string, deviceId?: number): ClipVectorSpace | null {
    const space = this.clipModels.spaceFor(modelId)
    if (space === null) {
      this.logger.warn('object embedding refused — the model has no CLIP metadata', {
        ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
        meta: { op, modelId },
      })
    }
    return space
  }

  /**
   * Upsert the best-confidence embedding for a track. At most ONE row per
   * track: a write only replaces the stored row when its confidence is
   * strictly higher, keeping the track's best crop over its lifetime.
   *
   * `force` BYPASSES that gate — it does not try to out-score it. A rebuild
   * first attempted to win by writing `confidence: Infinity`, which worked
   * exactly once: the stored row then held Infinity, `Infinity <= Infinity`
   * short-circuited, and every later pass silently wrote nothing while
   * reporting hundreds rebuilt. Observed live — 214 "rebuilt" moved the index
   * by 4 rows.
   *
   * ## Why this returns an outcome instead of `void`
   *
   * It used to return `void` and turn every failure into a warn. The rebuild
   * therefore counted a write the instant the call returned, and the second time
   * this class of bug appeared it produced `rebuilt: 704` against `indexed: 0` —
   * a progress number that was pure fiction while the real cause sat in a warn
   * nobody was reading. The caller now has to distinguish "written" from "logged
   * and dropped", because a counter that cannot reads as verification.
   */
  async upsertIfBetter(input: ObjectEmbeddingWrite): Promise<EmbeddingWriteOutcome> {
    // Any write is a chance to report a refusal tail whose interval has passed,
    // so a camera that stopped being refused still gets its last count said.
    this.refusals.sweep()
    const vector = resolveVectorPayload(input)
    if (vector === null) return 'failed'
    const space = this.clipModels.spaceFor(input.modelId)
    if (space === null) {
      this.refusals.note({
        deviceId: input.deviceId,
        modelId: input.modelId,
        reason: 'no-clip-metadata',
        trackId: input.trackId,
        dim: vector.dim,
      })
      return 'failed'
    }
    if (vector.dim !== space.dim) {
      // The model's metadata and the vector disagree. Writing it would put a
      // wrong-length row in an index whose every other row it cannot be ranked
      // against — refused, with both numbers, and COUNTED: when this fires it
      // fires for every vector a runner sends (D658).
      this.refusals.note({
        deviceId: input.deviceId,
        modelId: input.modelId,
        reason: 'dimension-mismatch',
        trackId: input.trackId,
        dim: vector.dim,
        expected: space.dim,
      })
      return 'failed'
    }
    if (!(await this.ensureIndex(space))) return 'failed'

    try {
      if (input.force !== true) {
        const existing = await this.vectorStore.getByIds.query({
          index: space.index,
          ids: [input.trackId],
        })
        const stored = existing.items[0]?.metadata['confidence']
        if (typeof stored === 'number' && input.confidence <= stored) return 'skipped'
      }

      const result = await this.vectorStore.upsert.mutate({
        index: space.index,
        items: [
          {
            id: input.trackId,
            vector: vector.base64,
            metadata: metadataFor(input),
          },
        ],
      })
      if (result.upserted === 0) {
        this.logger.warn('object-embedding upsert rejected', {
          tags: { deviceId: input.deviceId },
          meta: { trackId: input.trackId, dim: vector.dim, rejected: result.rejected },
        })
        return 'failed'
      }
      return 'persisted'
    } catch (err) {
      // Drop the declaration cache: the most common cause of a throw here is an
      // index this process believes it declared and the CURRENT provider has
      // never seen. Keeping the cache warm makes that state permanent until a
      // restart, which is exactly what happened on the live hub.
      this.declaredDims.delete(space.index)
      this.logger.warn('ObjectEmbeddingStore.upsertIfBetter failed', {
        tags: { deviceId: input.deviceId },
        meta: { trackId: input.trackId, index: space.index, error: String(err) },
      })
      return 'failed'
    }
  }

  /**
   * How many of `trackIds` are already in `modelId`'s feature space.
   *
   * The measurement a model change needs and `vectorStore.stats` cannot give:
   * `stats` reports ONE total for the index, and after a cluster model change
   * the only interesting number is the split — how much of the index the search
   * can still rank, and how much has become dead weight. It exists here rather
   * than as a new cap method because `getByIds` already answers it exactly, over
   * a bounded page, with no schema change to a cap the host validates.
   *
   * BOUNDED by construction: the caller passes a page of ids, so this can never
   * become a full-index scan on hub-main's only thread — the failure mode of
   * the 2026-08-06 rebuild.
   *
   * A read failure answers `null`, never zeros. Zeros here would read as "the
   * whole index is stale", which is the number an operator would act on.
   */
  async countInModelSpace(
    trackIds: readonly string[],
    modelId: string,
  ): Promise<ObjectEmbeddingModelSpaceCount | null> {
    if (trackIds.length === 0)
      return { inSpace: 0, otherModel: 0, absent: 0, inSpaceIds: [], outOfSpaceIds: [] }
    const space = this.spaceOrWarn(modelId, 'countInModelSpace')
    if (space === null) return null
    if (!(await this.ensureIndex(space))) return null
    try {
      // The model's OWN index: a track embedded only in another model's index
      // is `absent` here — exactly what a pass into this space must reach.
      const result = await this.vectorStore.getByIds.query({
        index: space.index,
        ids: [...trackIds],
      })
      const inSpaceIds: string[] = []
      const otherModelIds: string[] = []
      const seen = new Set<string>()
      for (const item of result.items) {
        seen.add(item.id)
        if (item.metadata['modelId'] === modelId) inSpaceIds.push(item.id)
        else otherModelIds.push(item.id)
      }
      // An id with NO row is out of space too — it has never been embedded, so
      // a pass must reach it. Folding it into `otherModel` would lose the
      // coverage-vs-staleness distinction the counters exist for, so it keeps
      // its own list and its own counter.
      const absentIds = trackIds.filter((id) => !seen.has(id))
      return {
        inSpace: inSpaceIds.length,
        otherModel: otherModelIds.length,
        absent: absentIds.length,
        inSpaceIds,
        outOfSpaceIds: [...otherModelIds, ...absentIds],
      }
    } catch (err) {
      this.logger.warn('ObjectEmbeddingStore.countInModelSpace failed', {
        meta: { modelId, ids: trackIds.length, error: String(err) },
      })
      return null
    }
  }

  /**
   * Rank stored embeddings against a query vector.
   *
   * Ranking happens in the provider, over compact rows, with the prefilters
   * pushed into SQL. This used to load every candidate into this process and
   * cosine them in JS behind a 5,000-row cap.
   */
  async searchByVector(input: {
    vector: Float32Array | readonly number[]
    limit: number
    minScore?: number
    deviceId?: number
    since?: number
    until?: number
    className?: string
    /** REQUIRED: it names the index (D649) and gates the rows within it. */
    modelId: string
  }): Promise<ObjectEmbeddingSearchResult> {
    const none: ObjectEmbeddingSearchResult = {
      hits: [],
      scanned: 0,
      truncated: false,
      effectiveTopK: 0,
    }
    const space = this.spaceOrWarn(input.modelId, 'search', input.deviceId)
    if (space === null) return none
    if (input.vector.length !== space.dim) {
      this.logger.warn("vector search refused — the query is not in its model's dimension", {
        ...(input.deviceId !== undefined ? { tags: { deviceId: input.deviceId } } : {}),
        meta: { modelId: input.modelId, dim: input.vector.length, expected: space.dim },
      })
      return none
    }
    if (!(await this.ensureIndex(space))) return none
    const equals: Record<string, string | number | boolean> = {}
    if (input.deviceId !== undefined) equals['deviceId'] = input.deviceId
    if (input.className !== undefined) equals['className'] = input.className
    // Still gated on the row's model WITHIN the index: MobileCLIP S1 and S2
    // share `object-clip`, and their cosines are not comparable either.
    equals['modelId'] = input.modelId

    const between: Record<string, [number, number]> = {}
    if (input.since !== undefined || input.until !== undefined) {
      between['timestamp'] = [input.since ?? 0, input.until ?? Date.now()]
    }

    const filter: VectorFilter = {
      ...(Object.keys(equals).length > 0 ? { equals } : {}),
      ...(Object.keys(between).length > 0 ? { between } : {}),
    }

    try {
      const result = await this.vectorStore.query.query({
        index: space.index,
        vector: encodeVectorBase64(input.vector),
        topK: input.limit,
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      })

      const hits: ScoredObjectEmbedding[] = []
      for (const match of result.matches) {
        const row = rowFromMetadata(match.id, match.metadata)
        if (row === null) continue
        hits.push({ row, score: match.score })
      }

      if (result.effectiveTopK < input.limit) {
        // The clamp, said out loud at the caller. It has always been logged by
        // the provider; it has never been logged by the thing that then treated
        // the short result as the whole index.
        this.logger.warn('vector search ran with a smaller topK than requested', {
          ...(input.deviceId !== undefined ? { tags: { deviceId: input.deviceId } } : {}),
          meta: {
            index: space.index,
            requested: input.limit,
            effectiveTopK: result.effectiveTopK,
          },
        })
      }
      return {
        hits,
        scanned: result.scanned,
        truncated: result.truncated,
        effectiveTopK: result.effectiveTopK,
      }
    } catch (err) {
      // A failed search returns nothing AND says so — an empty result that
      // looks identical to "no matches" is how a broken search stays invisible.
      this.logger.warn('ObjectEmbeddingStore.searchByVector failed', {
        ...(input.deviceId !== undefined ? { tags: { deviceId: input.deviceId } } : {}),
        meta: { index: space.index, error: String(err) },
      })
      return none
    }
  }

  /**
   * ENUMERATE one page of the index, unranked.
   *
   * The orphan scan used to enumerate by asking for a KNN of 20,000 against a
   * ZERO probe vector. Both halves were wrong. sqlite-vec clamps `k` to 4,096,
   * so the scan saw 18.5% of the index and logged `examined: 4096` as though it
   * had walked it; and a zero vector has no direction, so whatever the 4,096
   * were, they were not a meaningful sample of anything. This asks the question
   * the reconcile actually has — *what is in here* — through `vectorStore.scan`,
   * which has no `k` ceiling because it computes no distance.
   *
   * An empty page is NOT the end of the index; `nextCursor === null` is.
   */
  async scanRefs(
    space: ClipVectorSpace,
    cursor: number,
    limit: number,
  ): Promise<ObjectEmbeddingScanPage> {
    if (!(await this.ensureIndex(space))) {
      throw new Error(`object-embedding index "${space.index}" could not be declared — not scanned`)
    }
    const page = await this.vectorStore.scan.query({
      index: space.index,
      cursor,
      limit,
    })
    const rows: ObjectEmbeddingRef[] = []
    for (const item of page.items) {
      const trackId = item.metadata['trackId']
      const deviceId = item.metadata['deviceId']
      const timestamp = item.metadata['timestamp']
      rows.push({
        id: item.id,
        // The row id IS the trackId for every row this store writes, but the
        // metadata copy is preferred where it exists and NEITHER is invented:
        // a row that names no track is unresolvable, and an unresolvable row is
        // never a candidate for deletion.
        trackId:
          typeof trackId === 'string' && trackId.length > 0
            ? trackId
            : item.id.length > 0
              ? item.id
              : null,
        deviceId: typeof deviceId === 'number' ? deviceId : null,
        timestamp: typeof timestamp === 'number' ? timestamp : null,
      })
    }
    return { rows, nextCursor: page.nextCursor }
  }

  /**
   * Delete named vectors and CONFIRM they are gone.
   *
   * `deleteByIds` reports a row count the `vec0` backend cannot always produce,
   * so "the call returned" has never been the same statement as "the row left"
   * — and this store has already shipped one counter that could not tell those
   * apart (`rebuilt: 704` against an index that moved by 0). The read-back is
   * `getByIds`, which returns metadata and no vectors, so confirming a page of
   * deletions costs one indexed lookup and not one byte of float.
   *
   * Returns the ids that are VERIFIABLY gone. Anything still present is
   * returned as `stillPresent` for the caller to log — a delete that silently
   * did nothing is how an orphan becomes permanent.
   */
  async deleteVerified(ids: readonly string[]): Promise<ObjectEmbeddingDeleteOutcome> {
    if (ids.length === 0) return { deleted: [], stillPresent: [], undeclaredIndexes: [] }
    // EVERY index (D649). A track is embedded once per CLIP model that ever
    // ran on it, and a vector left in the index nobody searches today is the
    // one that comes back when the operator rolls the model back.
    const survivors = new Set<string>()
    const undeclaredIndexes: string[] = []
    for (const space of this.indexes()) {
      const outcome = await this.deleteVerifiedIn(space, ids)
      if (outcome === 'undeclared') {
        undeclaredIndexes.push(space.index)
        continue
      }
      for (const id of outcome) survivors.add(id)
    }
    return {
      deleted: ids.filter((id) => !survivors.has(id)),
      stillPresent: ids.filter((id) => survivors.has(id)),
      undeclaredIndexes,
    }
  }

  /**
   * One index's delete + read-back. Returns the ids still present in it, or
   * `'undeclared'` when the index could not be declared here.
   */
  private async deleteVerifiedIn(
    space: ClipVectorSpace,
    ids: readonly string[],
  ): Promise<readonly string[] | 'undeclared'> {
    // Declared first: on an install that never ran this model the index does
    // not exist yet, and the provider throws `never declared` for a delete.
    // An index that cannot be declared at all (its dimension disagrees with
    // the model's metadata) holds nothing this store could have written: it is
    // reported SEPARATELY, by name, and never turns every id into "still
    // present" — that made one broken index fail every delete in every other.
    const declared = await this.declare(space)
    if (declared === 'unreachable') {
      // Says nothing about the rows: they stay "still present", so the caller
      // keeps the track (and the orphan audit retries), never counts a delete.
      return [...ids]
    }
    if (declared === 'refused') {
      this.logger.warn('object embedding delete skipped an index that cannot be declared', {
        meta: { index: space.index, dim: space.dim, ids: ids.length },
      })
      return 'undeclared'
    }
    try {
      await this.vectorStore.deleteByIds.mutate({ index: space.index, ids: [...ids] })
    } catch (err) {
      // Clear the declaration cache for the same reason `upsertIfBetter` does:
      // the commonest cause of a throw here is an index this PROCESS believes
      // it declared and the CURRENT provider has never seen, and a warm cache
      // makes that state permanent until a restart. It did, on the live hub,
      // for hours.
      this.declaredDims.delete(space.index)
      this.logger.warn('object embedding delete failed — vectors kept', {
        meta: { index: space.index, ids: ids.length, error: String(err) },
      })
      return [...ids]
    }
    try {
      const readBack = await this.vectorStore.getByIds.query({
        index: space.index,
        ids: [...ids],
      })
      const stillPresent = readBack.items.map((i) => i.id)
      if (stillPresent.length > 0) {
        this.logger.warn('object embedding delete did not land — rows survived the delete', {
          meta: { index: space.index, asked: ids.length, survived: stillPresent.length },
        })
      }
      return stillPresent
    } catch (err) {
      // The delete may well have landed; we simply cannot say so. Reporting it
      // as deleted would be the counter that reads as verification.
      this.logger.warn('object embedding delete could not be verified', {
        meta: { index: space.index, ids: ids.length, error: String(err) },
      })
      return [...ids]
    }
  }

  /**
   * NO AGE SWEEP LIVES HERE ANY MORE.
   *
   * This store used to carry two: `pruneAll(cutoffMs)` on the fleet MINIMUM
   * cutoff, and then `pruneDeviceBefore(deviceId, cutoffMs)` on each device's
   * own. Both were wrong in the same way, and the second only less obviously:
   * a vector's row id IS the trackId — exactly one row per track — so a vector
   * is owned by its track completely, and giving it a second clock could only
   * ever produce disagreement. It did: measured on device 104, events back 1.0
   * day and embeddings back 22.1, with 1,446 of 2,222 rows pointing at nothing
   * that could be rendered.
   *
   * A vector now leaves exactly two ways: with its track, via
   * {@link deleteByTracks} in the cascade, or via {@link pruneOrphans}, which
   * asks about OWNERSHIP and never about age (D61).
   */

  /**
   * Drop every vector whose track no longer exists.
   *
   * The cascade already deletes a track's vector when the track is deleted, so
   * in principle this finds nothing. In practice it found 1,446 orphans on one
   * camera, because retention pruned by two different rules. A reconcile that
   * cannot explain how it got work to do is still the right shape — the
   * alternative is trusting that every deletion path remembered this store,
   * which is exactly the assumption that failed.
   *
   * `liveTrackIds` is the authority. An EMPTY set is refused rather than
   * treated as "delete everything": a track store that failed to answer would
   * otherwise wipe the whole index.
   */
  async pruneOrphans(input: {
    liveTrackIds: ReadonlySet<string>
    candidates: readonly string[]
  }): Promise<{ deleted: number; refused: boolean }> {
    if (input.liveTrackIds.size === 0) {
      this.logger.warn('ObjectEmbeddingStore.pruneOrphans refused an empty live-track set', {
        meta: { candidates: input.candidates.length },
      })
      return { deleted: 0, refused: true }
    }

    const orphans = input.candidates.filter((id) => !input.liveTrackIds.has(id))
    if (orphans.length === 0) return { deleted: 0, refused: false }

    // VERIFIED, not requested. The previous line reported `orphans.length` — the
    // size of the ASK — which is indistinguishable from a delete that threw and
    // was swallowed one frame below.
    const { deleted, stillPresent, undeclaredIndexes } = await this.deleteVerified(orphans)
    this.logger.info('object embedding orphans pruned', {
      meta: {
        orphans: orphans.length,
        deleted: deleted.length,
        kept: stillPresent.length,
        candidates: input.candidates.length,
        // Named, so "deleted" is never read as covering an index it skipped.
        undeclaredIndexes,
      },
    })
    return { deleted: deleted.length, refused: false }
  }

  /**
   * Empty EVERY CLIP index completely — the clean slate before a policy change.
   *
   * Changing the crop margin or the encoder model leaves two feature spaces in
   * one index whose cosine scores are not comparable. Wiping first, then
   * rebuilding, is the only way to be sure every vector means the same thing.
   */
  async wipeAll(): Promise<ObjectEmbeddingWipeOutcome> {
    // Every index — the operator's "clean slate" means every feature space.
    // An index that could not be declared or emptied is NAMED in
    // `failedIndexes`: a total that silently skipped one reads as a clean slate.
    let total = 0
    const failedIndexes: string[] = []
    for (const space of this.indexes()) {
      if (!(await this.ensureIndex(space))) {
        failedIndexes.push(space.index)
        continue
      }
      try {
        const result = await this.vectorStore.deleteByFilter.mutate({
          index: space.index,
          // Every row ever written carries a timestamp, so this is "all of them"
          // stated as a filter the provider can push down.
          filter: { between: { timestamp: [0, Number.MAX_SAFE_INTEGER] } },
        })
        this.logger.info('object embedding index wiped', {
          meta: { index: space.index, deleted: result.deleted },
        })
        total += result.deleted
      } catch (err) {
        this.logger.warn('ObjectEmbeddingStore.wipeAll failed', {
          meta: { index: space.index, error: String(err) },
        })
        failedIndexes.push(space.index)
      }
    }
    return { deleted: total, failedIndexes }
  }

  /**
   * `TrackScopedStore` contract for the retention cascade: delete the per-track
   * CLIP search vector for the given tracks. Pure EPHEMERAL track state — the
   * identity MATCHING embeddings (ArcFace) live in a SEPARATE durable store
   * (`identity-samples`) and are never touched here, so pruning this never
   * breaks recognition (design §2/§4).
   */
  async deleteByTracks(trackIds: readonly string[]): Promise<readonly TrackCascadeLeafCount[]> {
    if (trackIds.length === 0) return [{ family: 'embeddings', rows: 0, bytes: 0 }]
    // VERIFIED. The cascade deletes the track ROOT after this leaf returns, so a
    // vector that quietly survived here can never be found again by ownership —
    // its owner is gone one statement later and nothing re-asks. That is the
    // shape that turns one bad hour into a permanent orphan, and this store's
    // own docblock records the hour: a provider swap left every call throwing
    // `index "object-clip" was never declared` until the addon was restarted by
    // hand, while retention kept deleting the tracks underneath.
    const { deleted, stillPresent, undeclaredIndexes } = await this.deleteVerified(trackIds)
    if (undeclaredIndexes.length > 0) {
      this.logger.warn('cascade skipped CLIP indexes the provider refuses to declare', {
        meta: { asked: trackIds.length, undeclaredIndexes },
      })
    }
    if (stillPresent.length > 0) {
      this.logger.warn('cascade left CLIP vectors behind — they are now unreachable by ownership', {
        meta: {
          asked: trackIds.length,
          kept: stillPresent.length,
          why: 'the track rows are deleted immediately after this leaf, so these vectors can only be reclaimed by the orphan audit',
        },
      })
    }
    return [{ family: 'embeddings', rows: deleted.length, bytes: 0 }]
  }

  /**
   * D683 §6.3: the absorbed piece's CLIP vector is offered to the survivor in
   * every index that holds it — `upsertIfBetter` keeps whichever is better —
   * and deleted only once that offer was answered. A vector that could not be
   * carried stays (the alias still reaches it) and the leaf throws, so the
   * fusion service reports the family as failed (D58: never lose the only vector).
   *
   * Review M4: a space this call cannot even DECLARE here (`'unreachable'`,
   * as opposed to `'refused'` — an index that never held this store's rows)
   * THROWS instead of being skipped. Silently continuing risks the
   * `deleteVerified` below reaching that same space once the provider comes
   * back and deleting a vector that was NEVER offered to the survivor — the
   * exact loss this leaf exists to prevent. A `stillPresent` vector after the
   * delete is logged rather than silently counted as dropped.
   */
  async reassignTrack(req: TrackFusionRequest): Promise<readonly TrackFusionLeafCount[]> {
    let moved = 0
    for (const space of this.indexes()) {
      const declared = await this.declare(space)
      if (declared === 'unreachable') {
        throw new Error(
          `object embedding fusion: index "${space.index}" is unreachable — refusing to risk an uncarried delete`,
        )
      }
      if (declared === 'refused') continue // holds nothing this store ever wrote
      const got = await this.vectorStore.fetchByIds.query({
        index: space.index,
        ids: [req.absorbedId],
      })
      const item = got.items[0]
      if (item !== undefined) {
        const m = item.metadata
        const num = (k: string): number | undefined => (typeof m[k] === 'number' ? m[k] : undefined)
        const str = (k: string): string | undefined => (typeof m[k] === 'string' ? m[k] : undefined)
        const timestamp = num('timestamp')
        const className = str('className')
        const modelId = str('modelId')
        const confidence = num('confidence')
        if (
          timestamp === undefined ||
          className === undefined ||
          modelId === undefined ||
          confidence === undefined
        ) {
          throw new Error(`vector ${req.absorbedId} in ${space.index} has incomplete metadata`)
        }
        // Review M2: a `mediaId` / `keyFrameMediaId` the media leg dropped is
        // cleared (logged) rather than carried over dangling.
        const mediaId = await this.presentOrDropped(num('mediaId'), req, 'mediaId', space.index)
        const keyFrameMediaId = await this.presentOrDropped(
          num('keyFrameMediaId'),
          req,
          'keyFrameMediaId',
          space.index,
        )
        const outcome = await this.upsertIfBetter({
          trackId: req.survivorId,
          deviceId: req.deviceId,
          timestamp,
          className,
          modelId,
          confidence,
          ...(mediaId !== undefined ? { mediaId } : {}),
          ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
          embeddingBase64: item.vector,
        })
        if (outcome === 'failed') {
          throw new Error(
            `vector ${req.absorbedId} could not be carried to ${req.survivorId} in ${space.index}`,
          )
        }
        if (outcome === 'persisted') moved += 1
      }
      // Review N2/P3: the SURVIVOR's own vector in THIS space — whether or
      // not the absorbed piece had one here — may independently name a
      // `mediaId` / `keyFrameMediaId` the media leg just dropped (the
      // media-level ranking can favour the absorbed piece's key frame while
      // the embedding-level ranking keeps the survivor's vector, or the
      // absorbed piece may simply never have reached this space at all). A
      // fresh carry (`outcome === 'persisted'`) already wrote clean
      // references, so this is a harmless no-op immediately after one.
      await this.clearDanglingSurvivorRefs(space.index, req)
    }
    const { deleted, stillPresent } = await this.deleteVerified([req.absorbedId])
    if (stillPresent.length > 0) {
      this.logger.warn('object embedding fusion: the absorbed vector survived its delete', {
        tags: { deviceId: req.deviceId },
        meta: { absorbedId: req.absorbedId, survivorId: req.survivorId },
      })
    }
    return [{ family: 'embeddings', moved, dropped: deleted.length }]
  }

  /** M2 helper: a media id carried in metadata that the media leg no longer
   *  has is cleared and logged rather than carried over dangling. */
  private async presentOrDropped(
    mediaId: number | undefined,
    req: TrackFusionRequest,
    field: string,
    index: string,
  ): Promise<number | undefined> {
    if (mediaId === undefined) return undefined
    if (await req.media.stillPresent(mediaId)) return mediaId
    this.logger.warn(`object embedding fusion: dropped a ${field} the media leg no longer has`, {
      tags: { deviceId: req.deviceId },
      meta: { trackId: req.survivorId, index, droppedMediaId: mediaId },
    })
    return undefined
  }

  /**
   * Review N2/P3: the survivor's OWN vector IN THIS SPACE — whether or not
   * the absorbed piece ever reached it — may itself name a `mediaId` /
   * `keyFrameMediaId` the media leg just dropped. Re-reads the survivor's
   * row, clears any stale reference, and — only if something actually
   * changed — re-persists it.
   *
   * Review P2, two fixes over the first cut:
   *  - **Re-checked, not just re-read.** The survivor is an ACTIVE track: a
   *    live `upsertIfBetter` can land between the read above and the write
   *    below. Immediately before writing, this re-fetches the row and
   *    ABORTS (logged) if the vector or any metadata key changed — a stale
   *    copy must never clobber a genuinely newer write. The window is not
   *    zero, but the read-write-verify shape now matches `relocateAndReassign`.
   *  - **Merged, never rebuilt.** The write goes straight to
   *    `vectorStore.upsert` with the ORIGINAL metadata object, only the two
   *    stale keys touched — not through `upsertIfBetter`, whose `metadataFor`
   *    rebuilds the whole object from `ObjectEmbeddingWrite` and would drop
   *    any key outside that shape.
   */
  private async clearDanglingSurvivorRefs(index: string, req: TrackFusionRequest): Promise<void> {
    try {
      await this.patchDanglingSurvivorRefs(index, req)
    } catch (err) {
      // T15 R2: the same reason `upsertIfBetter` / `deleteVerified` drop it —
      // the commonest cause of a throw is an index this PROCESS believes it
      // declared and the CURRENT provider has never seen; a warm cache would
      // make that permanent until a restart. The caller still sees the throw.
      this.declaredDims.delete(index)
      throw err
    }
  }

  private async patchDanglingSurvivorRefs(index: string, req: TrackFusionRequest): Promise<void> {
    const got = await this.vectorStore.fetchByIds.query({ index, ids: [req.survivorId] })
    const item = got.items[0]
    if (item === undefined) return
    const m = item.metadata
    const num = (k: string): number | undefined => (typeof m[k] === 'number' ? m[k] : undefined)
    const originalMediaId = num('mediaId')
    const originalKeyFrameMediaId = num('keyFrameMediaId')
    const mediaId = await this.presentOrDropped(originalMediaId, req, 'mediaId', index)
    const keyFrameMediaId = await this.presentOrDropped(
      originalKeyFrameMediaId,
      req,
      'keyFrameMediaId',
      index,
    )
    if (mediaId === originalMediaId && keyFrameMediaId === originalKeyFrameMediaId) return // nothing stale

    const recheck = await this.vectorStore.fetchByIds.query({ index, ids: [req.survivorId] })
    const recheckItem = recheck.items[0]
    if (recheckItem === undefined || !vectorRowUnchanged(item, recheckItem)) {
      this.logger.warn(
        'object embedding fusion: the survivor vector changed mid-patch — leaving the stale reference for the next pass',
        { tags: { deviceId: req.deviceId }, meta: { trackId: req.survivorId, index } },
      )
      return
    }

    const patched: VectorMetadata = { ...m }
    if (mediaId !== undefined) patched['mediaId'] = mediaId
    else delete patched['mediaId']
    if (keyFrameMediaId !== undefined) patched['keyFrameMediaId'] = keyFrameMediaId
    else delete patched['keyFrameMediaId']

    const result = await this.vectorStore.upsert.mutate({
      index,
      items: [{ id: req.survivorId, vector: item.vector, metadata: patched }],
    })
    if (result.upserted === 0) {
      throw new Error(`survivor vector metadata patch failed for ${req.survivorId} in ${index}`)
    }
  }
}

/** Review P2: has this vector row changed at all since it was last read?
 *  Compared key-by-key (order-independent) rather than by reference, since
 *  every read returns a fresh object. */
function vectorRowUnchanged(
  a: { readonly vector: string; readonly metadata: VectorMetadata },
  b: { readonly vector: string; readonly metadata: VectorMetadata },
): boolean {
  if (a.vector !== b.vector) return false
  const aKeys = Object.keys(a.metadata).toSorted()
  const bKeys = Object.keys(b.metadata).toSorted()
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k, i) => bKeys[i] === k && a.metadata[k] === b.metadata[k])
}

/** The outcome of declaring one index. */
type IndexDeclaration = 'declared' | 'refused' | 'unreachable'

/** What a verified delete across every CLIP index did. */
export interface ObjectEmbeddingDeleteOutcome {
  /** Gone from every index that could be reached. */
  readonly deleted: readonly string[]
  /** Still present in at least one reachable index. */
  readonly stillPresent: readonly string[]
  /**
   * Indexes the provider REFUSED to declare at their model's dimension — they
   * hold nothing this store wrote. An UNREACHABLE provider is not this: its
   * ids stay in `stillPresent`.
   */
  readonly undeclaredIndexes: readonly string[]
}

/** What `wipeAll` did, including the indexes it could NOT empty. */
export interface ObjectEmbeddingWipeOutcome {
  readonly deleted: number
  readonly failedIndexes: readonly string[]
}

/**
 * The split of one page of tracks across model spaces.
 *
 * Three counters, not two: `absent` (never embedded) is a coverage question and
 * `otherModel` (embedded by a previous encoder) is a staleness question, and
 * folding them together is how "the rebuild is not working" and "these tracks
 * were never enrichable" become the same unanswerable number.
 */
export interface ObjectEmbeddingModelSpaceCount {
  readonly inSpace: number
  readonly otherModel: number
  readonly absent: number
  /** The ids already in `modelId`'s space — nothing to do for them. */
  readonly inSpaceIds: readonly string[]
  /** The ids a pass must still reach: a previous model's, or never embedded. */
  readonly outOfSpaceIds: readonly string[]
}

/** Build the vector-store metadata for one embedding. */
export function metadataFor(input: {
  trackId: string
  deviceId: number
  timestamp: number
  className: string
  modelId: string
  confidence: number
  mediaId?: number
  keyFrameMediaId?: number
}): VectorMetadata {
  return {
    deviceId: input.deviceId,
    timestamp: input.timestamp,
    className: input.className,
    modelId: input.modelId,
    trackId: input.trackId,
    confidence: input.confidence,
    ...(input.mediaId !== undefined ? { mediaId: input.mediaId } : {}),
    ...(input.keyFrameMediaId !== undefined ? { keyFrameMediaId: input.keyFrameMediaId } : {}),
  }
}

/**
 * Rebuild a stored row from vector-store metadata.
 *
 * Returns null when the row lacks its identity fields rather than filling them
 * with defaults: a hit whose `deviceId` silently became 0 would be joined to
 * the wrong camera's events.
 */
function rowFromMetadata(id: string, metadata: VectorMetadata): ObjectEmbedding | null {
  const deviceId = metadata['deviceId']
  const timestamp = metadata['timestamp']
  const trackId = metadata['trackId'] ?? id
  if (typeof deviceId !== 'number' || typeof timestamp !== 'number') return null
  if (typeof trackId !== 'string') return null

  const className = metadata['className']
  const modelId = metadata['modelId']
  const confidence = metadata['confidence']
  // Metadata is untyped scalar JSON at this boundary (`VectorMetadata` allows
  // string | number | boolean per key) — `Number(...)` + `Number.isFinite`
  // rather than a `typeof` narrow, and an unreadable/absent value stays
  // absent. A measurement that failed is null, never zero (D393): a raw 0
  // here would read as "row zero", not "no key frame".
  const mediaId = Number(metadata['mediaId'])
  const keyFrameMediaId = Number(metadata['keyFrameMediaId'])

  return {
    id,
    trackId,
    deviceId,
    timestamp,
    className: typeof className === 'string' ? className : 'unknown',
    modelId: typeof modelId === 'string' ? modelId : 'unknown',
    confidence: typeof confidence === 'number' ? confidence : 0,
    ...(Number.isFinite(mediaId) ? { mediaId } : {}),
    ...(Number.isFinite(keyFrameMediaId) ? { keyFrameMediaId } : {}),
  }
}
