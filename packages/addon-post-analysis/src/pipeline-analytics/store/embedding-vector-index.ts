/**
 * The vector indexes this addon owns, and the one client that talks to them.
 *
 * ## The three indexes, and what a row in each one IS
 *
 * | index | dim | encoder | one row is | ranked against |
 * | --- | --- | --- | --- | --- |
 * | `object-clip` | 512 | MobileCLIP image tower (`mobileclip-*`) | a TRACK's best-confidence object crop | a CLIP **text** vector — semantic search over footage |
 * | `face-arcface` | 512 | ArcFace (`arcface-r100` and successors) | the best face read of a TRACK, aligned to 112×112 | the enrolled gallery, to suggest or auto-confirm an identity |
 * | `identity-arcface` | 512 | the SAME ArcFace model | one ENROLLED face of a person | every live face detection, at recognition time |
 *
 * `plates`, `vehicles`, `vehicle-samples` and `identities` hold no vector of
 * any kind — a plate is a STRING and a score, a vehicle and an identity are a
 * name. They are named here because `vector-store.cap.ts` once claimed six
 * stores were waiting to migrate, and five of them being absent from this table
 * is the answer to "where are the other ones".
 *
 * ## Why `face-arcface` and `identity-arcface` are two indexes
 *
 * They hold the same 512 dims from the same model, and they are still separate.
 * An index is a set of rows that get ranked against each other and that live and
 * die together, and these are neither:
 *
 *  - a `face-arcface` row is TRACK-OWNED. It cascades away with its track and is
 *    capped per camera; it is a CANDIDATE.
 *  - an `identity-arcface` row is retention-EXEMPT forever. It is the ANSWER
 *    every candidate is measured against.
 *
 * Merged, every gallery load and every reconcile would carry a discriminating
 * filter, and the two ways that filter can fail are "a face is ranked against
 * itself" and "an enrolled person's only sample is reclaimed as a track orphan".
 * Sharing a dimension is not a reason to share an index.
 */

import { encodeVectorBase64, type IScopedLogger, type VectorMetadata } from '@camstack/types'

/** The buffered per-track ArcFace face vector (`pipeline-analytics:faces`). */
export const FACE_ARCFACE_INDEX = 'face-arcface'

/** The ENROLLED gallery (`pipeline-analytics:identity-samples`). */
export const IDENTITY_ARCFACE_INDEX = 'identity-arcface'

/**
 * The `className` each index stamps on its rows.
 *
 * A constant per index, exactly as `object-clip` stamps `embedding`. It is not
 * a subject class and must never be filtered on as one: it says which PRODUCER
 * wrote the row, which is what keeps a face vector out of a CLIP ranking.
 */
export const FACE_VECTOR_CLASS = 'face'
export const IDENTITY_VECTOR_CLASS = 'identity'

/**
 * The slice of the generated `vector-store` client these stores use.
 *
 * Narrowed rather than taking the whole client so a test fake needs no cast.
 * Array members are mutable because that is what the generated tRPC input types
 * are — a `readonly` array is not assignable to them.
 */
export interface EmbeddingVectorStoreClient {
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
  readonly fetchByIds: {
    query: (input: { index: string; ids: string[] }) => Promise<{
      items: Array<{ id: string; vector: string; metadata: VectorMetadata }>
    }>
  }
  readonly getByIds: {
    query: (input: { index: string; ids: string[] }) => Promise<{
      items: Array<{ id: string; metadata: VectorMetadata }>
    }>
  }
  readonly scan: {
    query: (input: { index: string; cursor: number; limit: number }) => Promise<{
      items: Array<{ id: string; metadata: VectorMetadata }>
      nextCursor: number | null
    }>
  }
  readonly deleteByIds: {
    mutate: (input: { index: string; ids: string[] }) => Promise<{ deleted: number }>
  }
}

export interface EmbeddingVectorIndexDeps {
  readonly index: string
  readonly client: EmbeddingVectorStoreClient
  readonly logger: IScopedLogger
}

/** One row of {@link EmbeddingVectorIndex.scan} — metadata only, no floats. */
export interface EmbeddingVectorScanRow {
  readonly id: string
  readonly deviceId: number | null
  readonly timestamp: number | null
}

/** One page of {@link EmbeddingVectorIndex.scan}. */
export interface EmbeddingVectorScanPage {
  readonly rows: readonly EmbeddingVectorScanRow[]
  /** `null` = the end of the index. Never inferred from a short page. */
  readonly nextCursor: number | null
}

/** A vector read back with the model its writer stamped on it (D651). */
export interface StampedVector {
  readonly embedding: readonly number[]
  /** `null` = the row carries no stamp. */
  readonly modelId: string | null
}

/** {@link StampedVector} with the floats kept as stored (D867). */
export interface StampedFloat32Vector {
  readonly embedding: Float32Array
  readonly modelId: string | null
}

/** A vector to write, with the scalars its index promotes to real columns. */
export interface EmbeddingVectorWrite {
  readonly id: string
  readonly embedding: readonly number[]
  readonly className: string
  readonly modelId: string
  readonly timestamp: number
  readonly deviceId?: number
  /** Anything else the owner wants back on a scan. Filterable only if promoted. */
  readonly extra?: VectorMetadata
}

/**
 * One index, plus the lazy declaration every caller would otherwise re-derive.
 *
 * The dimension is not known at construction — it comes from whatever encoder
 * is active — so the index is declared on the first vector, exactly as
 * `ObjectEmbeddingStore` does it, and a failed declaration DISABLES writes for
 * that dim rather than letting an upsert fail against an index the provider has
 * never seen. A failed write clears the cache so the next one re-declares:
 * a provider swap under a running hub once left that cache warm and every write
 * throwing for hours.
 */
export class EmbeddingVectorIndex {
  private readonly index: string
  private readonly client: EmbeddingVectorStoreClient
  private readonly logger: IScopedLogger
  private declaredDim: number | null = null

  constructor(deps: EmbeddingVectorIndexDeps) {
    this.index = deps.index
    this.client = deps.client
    this.logger = deps.logger
  }

  /** The index name, for a log line that has to name which store dropped work. */
  get name(): string {
    return this.index
  }

  private async ensureIndex(dim: number): Promise<boolean> {
    if (this.declaredDim === dim) return true
    try {
      await this.client.declareIndex.mutate({ index: this.index, dim, metric: 'cosine' })
      this.declaredDim = dim
      return true
    } catch (err) {
      this.logger.warn('vector index declaration failed — writes disabled for this dim', {
        meta: { index: this.index, dim, error: String(err) },
      })
      return false
    }
  }

  /**
   * Write one vector. Returns whether it LANDED, never whether the call
   * returned — the caller uses this to decide it may stop keeping its own copy,
   * and "the mutate resolved" is not the same statement (D58).
   */
  async put(input: EmbeddingVectorWrite): Promise<boolean> {
    if (input.embedding.length === 0) {
      this.logger.warn('refused to index an empty vector', {
        meta: { index: this.index, id: input.id },
      })
      return false
    }
    if (!(await this.ensureIndex(input.embedding.length))) return false
    const metadata: VectorMetadata = {
      ...input.extra,
      className: input.className,
      modelId: input.modelId,
      timestamp: input.timestamp,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    }
    try {
      const result = await this.client.upsert.mutate({
        index: this.index,
        items: [{ id: input.id, vector: encodeVectorBase64(input.embedding), metadata }],
      })
      if (result.upserted === 0) {
        this.logger.warn('vector upsert rejected', {
          ...(input.deviceId !== undefined ? { tags: { deviceId: input.deviceId } } : {}),
          meta: { index: this.index, id: input.id, rejected: result.rejected },
        })
        return false
      }
      return true
    } catch (err) {
      this.declaredDim = null
      this.logger.warn('vector upsert failed', {
        ...(input.deviceId !== undefined ? { tags: { deviceId: input.deviceId } } : {}),
        meta: { index: this.index, id: input.id, error: String(err) },
      })
      return false
    }
  }

  /**
   * Read named vectors back as float arrays.
   *
   * An id with no row is simply ABSENT from the map — never a zero vector. A
   * zero vector scores 0 against everything and would quietly un-enrol a person
   * instead of failing, which is the reason `fetchByIds` drops an unreadable
   * row rather than padding it.
   *
   * On a read failure the map is EMPTY and the failure is logged. An empty
   * gallery is a visible outage; a partial one silently forgets people.
   */
  async load(ids: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>> {
    const stamped = await this.loadStamped(ids)
    return new Map([...stamped].map(([id, row]) => [id, row.embedding]))
  }

  /**
   * {@link load}, keeping the model the WRITER stamped on each vector.
   *
   * The vector's own stamp is the only statement of which encoder produced
   * those floats. A caller that pairs the vector with a stamp read from
   * somewhere else — a settings row written in a second step — must compare
   * the two before trusting either (D651): the gap between the two writes is
   * exactly where a model switch tears. `modelId: null` means the index row
   * carries no stamp, which no current writer produces.
   */
  async loadStamped(ids: readonly string[]): Promise<ReadonlyMap<string, StampedVector>> {
    const f32 = await this.loadStampedFloat32(ids)
    return new Map(
      [...f32].map(([id, row]): [string, StampedVector] => [
        id,
        { embedding: Array.from(row.embedding), modelId: row.modelId },
      ]),
    )
  }

  /**
   * {@link loadStamped} without widening to `number[]`: the vector as the
   * `Float32Array` it was stored as, in a buffer of its own (a view over the
   * base64 decode would pin a pooled slab). For the matching gallery, which is
   * scored against on every probe and used to be re-wrapped per sample per
   * probe (D867). Same read-failure contract as {@link loadStamped}.
   */
  async loadStampedFloat32(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, StampedFloat32Vector>> {
    const out = new Map<string, StampedFloat32Vector>()
    if (ids.length === 0) return out
    try {
      const result = await this.client.fetchByIds.query({ index: this.index, ids: [...ids] })
      for (const item of result.items) {
        const buf = Buffer.from(item.vector, 'base64')
        if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) continue
        const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
        const modelId = item.metadata['modelId']
        out.set(item.id, {
          embedding: new Float32Array(view),
          modelId: typeof modelId === 'string' && modelId.length > 0 ? modelId : null,
        })
      }
    } catch (err) {
      this.logger.warn('vector fetch failed — no vectors returned for this call', {
        meta: { index: this.index, ids: ids.length, error: String(err) },
      })
      return new Map<string, StampedFloat32Vector>()
    }
    return out
  }

  /**
   * Drop named vectors.
   *
   * Best-effort and LOUD: these rows have exactly one owner and it is being
   * deleted, so a delete that quietly did nothing leaves a vector nothing can
   * ever reach by ownership again.
   */
  /**
   * One page of the whole index, metadata only.
   *
   * By CURSOR, not by a KNN against a zero probe vector: that was how the
   * object-CLIP audit consumed 4 096 rows of a 22 128-row index for weeks and
   * reported the number as though it had walked the whole thing. A scan
   * computes no distance and has no `k` ceiling.
   *
   * A failure THROWS. The caller is an orphan audit, and the one thing it must
   * never do is read a failed read as "these rows own nothing".
   */
  async scan(cursor: number, limit: number): Promise<EmbeddingVectorScanPage> {
    const page = await this.client.scan.query({ index: this.index, cursor, limit })
    return {
      rows: page.items.map((item) => ({
        id: item.id,
        deviceId: typeof item.metadata['deviceId'] === 'number' ? item.metadata['deviceId'] : null,
        timestamp:
          typeof item.metadata['timestamp'] === 'number' ? item.metadata['timestamp'] : null,
      })),
      nextCursor: page.nextCursor,
    }
  }

  /**
   * Drop named vectors and CONFIRM they are gone.
   *
   * `deleteByIds` reports a count the `vec0` backend cannot always produce, so
   * "the call returned" is not the statement "the row left" — the same reason
   * `ObjectEmbeddingStore.deleteVerified` exists. The read-back is `getByIds`,
   * which carries metadata and no vectors, so confirming a page costs one
   * indexed lookup and not one byte of float.
   */
  async dropVerified(
    ids: readonly string[],
  ): Promise<{ deleted: readonly string[]; stillPresent: readonly string[] }> {
    if (ids.length === 0) return { deleted: [], stillPresent: [] }
    try {
      await this.client.deleteByIds.mutate({ index: this.index, ids: [...ids] })
    } catch (err) {
      this.declaredDim = null
      this.logger.warn('vector delete failed — rows kept', {
        meta: { index: this.index, ids: ids.length, error: String(err) },
      })
      return { deleted: [], stillPresent: [...ids] }
    }
    try {
      const readBack = await this.client.getByIds.query({ index: this.index, ids: [...ids] })
      const survivors = new Set(readBack.items.map((i) => i.id))
      return {
        deleted: ids.filter((id) => !survivors.has(id)),
        stillPresent: ids.filter((id) => survivors.has(id)),
      }
    } catch (err) {
      // The delete may well have landed; we cannot say so. Reporting them as
      // kept is the honest direction — a caller that counts them as reclaimed
      // would move a cursor past rows that may still be there.
      this.logger.warn('vector delete read-back failed — reported as kept', {
        meta: { index: this.index, ids: ids.length, error: String(err) },
      })
      return { deleted: [], stillPresent: [...ids] }
    }
  }

  async drop(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    try {
      await this.client.deleteByIds.mutate({ index: this.index, ids: [...ids] })
    } catch (err) {
      this.declaredDim = null
      this.logger.warn('vector delete failed — rows left behind', {
        meta: { index: this.index, ids: ids.length, error: String(err) },
      })
    }
  }
}
