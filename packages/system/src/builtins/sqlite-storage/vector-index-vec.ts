/**
 * sqlite-vec vector index — the ANN-capable `vector-store` backend.
 *
 * Same database file, same open handle, same process as the brute-force index
 * it replaces: `sqlite-vec` is an EXTENSION, not a service. That is why it was
 * chosen over Qdrant/Milvus/LanceDB — at this scale a second thing to run, back
 * up and version buys nothing that a `vec0` virtual table does not.
 *
 * ## What the extension gives us, and what it costs
 *
 * A `vec0` table stores the vector as a packed Float32 blob and does the
 * distance in C, with the metadata prefilters compiled into the SAME statement
 * — so `deviceId = ? AND ts BETWEEN ? AND ?` narrows the candidate set before
 * any distance is computed, instead of after loading every row into JS.
 *
 * It is not free of sharp edges, and all three below were found by running it,
 * not by reading about it:
 *
 *  1. **The primary key must be declared `TEXT PRIMARY KEY`.** The default
 *     `rowid` form rejects our ids with "Only integers are allowed for primary
 *     key values" — and our ids are track UUIDs.
 *  2. **Integer metadata must be bound as BigInt.** `better-sqlite3` sends a
 *     plain JS number as a FLOAT, and `vec0` rejects it with "Expected integer
 *     for INTEGER metadata column". A silent `Number` → `BigInt` conversion at
 *     the boundary is therefore mandatory, not defensive.
 *  3. **`distance_metric=cosine` returns a DISTANCE**, 0 for identical and 2
 *     for opposite. The capability's contract is a SCORE where higher is
 *     nearer, so it is converted — `score = 1 - distance` — exactly once, here.
 *
 * ## Switching backends is not free
 *
 * The `vec0` table is a different table from the brute-force one. Turning this
 * on gives an EMPTY index until something repopulates it; for object CLIP that
 * is `pipelineAnalytics.rebuildObjectEmbeddings`. Off by default for that
 * reason.
 */

import type { IScopedLogger, VectorFilter, VectorMetadata, VectorMetric } from '@camstack/types'
import {
  decodeVectorBase64,
  encodeVectorBase64,
  vectorDimFromBase64,
  vectorIndexDimConflictError,
} from '@camstack/types'
import type { SqliteOpLabel, SqliteOpProfiler } from './query-profiler.js'
import {
  PROMOTED_COLUMNS,
  type VectorFetchRow,
  type VectorIndexStats,
  type VectorMatchRow,
  type VectorQueryOutcome,
  type VectorScanPage,
} from './vector-index-shared.js'

/** The raw statement surface this index needs from better-sqlite3. */
export interface RawSqliteDatabase {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  loadExtension?(path: string): void
}

/**
 * The largest `k` sqlite-vec will accept in a KNN query.
 *
 * This is the EXTENSION's own compile-time limit, not a number chosen here —
 * measured against the real extension, which answers a larger `k` with
 * `SqliteError: k value in knn query too large, provided 20000 and the limit
 * is 4096` rather than with rows.
 *
 * It matters that this is the extension's number. The vector door looked like
 * a bypass of {@link SETTINGS_QUERY_HARD_ROW_CAP}: `vector-store.cap.ts`
 * declares `topK: z.number().int().positive()` with no `.max()`, and it is
 * bound straight into `k = ?` on the same connection, in the same process, as
 * the capped `data-store-provider.query`. It is not a bypass — sqlite-vec was
 * holding the line the whole time, which caps a KNN's heap cost at 4 096 rows
 * of metadata. What was actually broken is that it held the line by THROWING,
 * so an over-large `topK` reached the caller as a raw SQLite error instead of
 * as the bounded answer it could always have been served.
 */
export const VEC_KNN_MAX_K = 4096

const tableFor = (index: string): string => `vec_${index.replace(/[^a-zA-Z0-9_]/g, '_')}`
const registryTable = 'vec_indexes'

/** `vec0` speaks packed Float32; the capability speaks base64 of the same. */
function toBlob(base64: string): Buffer {
  return Buffer.from(base64, 'base64')
}

/**
 * `vec0` metadata columns are NOT NULLABLE.
 *
 * Passing NULL fails the whole insert with "Expected text for TEXT metadata
 * column … received NULL", and our metadata is genuinely optional — a vector
 * may carry no className or modelId. So absence is encoded with a sentinel and
 * stripped again on read:
 *
 *  - text  → `''`. No real className or modelId is the empty string, so the
 *    round-trip is lossless.
 *  - integer → `MISSING_INT`. Chosen NEGATIVE because a device id and a
 *    millisecond timestamp are both non-negative in this system; 0 would be a
 *    plausible timestamp (1970) and could not be told from an absent one.
 */
const MISSING_INT = -1

/**
 * Bind an integer metadata value as BigInt.
 *
 * Not defensive: `better-sqlite3` binds a plain JS number as FLOAT and `vec0`
 * refuses it outright for an INTEGER metadata column.
 */
function asInteger(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BigInt(MISSING_INT)
  return BigInt(Math.trunc(value))
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The nullable read of a text column — `''` means the caller never set it. */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The nullable read of an integer column — the sentinel means absent. */
function readInt(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n === MISSING_INT) return null
  return n
}

export interface SqliteVecIndexDeps {
  readonly db: RawSqliteDatabase
  readonly logger: IScopedLogger
  /**
   * The relational engine's profiler, so a KNN lands in the SAME report
   * window as the queries it competes with. Optional because the specs
   * construct this index against a raw handle with no engine behind it.
   */
  readonly profiler?: SqliteOpProfiler
}

export class SqliteVecVectorIndex {
  private readonly db: RawSqliteDatabase
  private readonly logger: IScopedLogger
  private readonly profiler: SqliteOpProfiler | undefined
  private readonly specs = new Map<string, { dim: number; metric: VectorMetric }>()

  constructor(deps: SqliteVecIndexDeps) {
    this.db = deps.db
    this.logger = deps.logger
    this.profiler = deps.profiler
  }

  /** Run one synchronous statement under the shared profiler, if there is one. */
  private measured<T>(label: SqliteOpLabel, run: () => T): T {
    const profiler = this.profiler
    return profiler === undefined ? run() : profiler.measure(label, run)
  }

  /** Recover index declarations so an existing table is usable from boot. */
  async loadIndexRegistry(): Promise<void> {
    try {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${registryTable} (id TEXT PRIMARY KEY, dim INTEGER NOT NULL, metric TEXT NOT NULL)`,
      )
      const rows = this.db.prepare(`SELECT id, dim, metric FROM ${registryTable}`).all()
      for (const raw of rows) {
        if (typeof raw !== 'object' || raw === null) continue
        const row = raw as Record<string, unknown>
        const id = asText(row['id'])
        const dim = typeof row['dim'] === 'number' ? row['dim'] : Number(row['dim'])
        if (id === null || !Number.isFinite(dim)) continue
        this.specs.set(id, { dim, metric: metricOf(row['metric']) })
      }
      this.logger.info('sqlite-vec index registry loaded', { meta: { indexes: this.specs.size } })
    } catch (err) {
      this.logger.error('sqlite-vec registry failed to load', { meta: { error: String(err) } })
    }
  }

  async declareIndex(index: string, dim: number, metric: VectorMetric): Promise<void> {
    const existing = this.specs.get(index)
    if (existing !== undefined && existing.dim !== dim) {
      throw vectorIndexDimConflictError(index, existing.dim, dim)
    }

    // Metadata columns are declared inline so their filters compile into the
    // KNN statement. Anything not promoted rides in `extra` and cannot be
    // filtered on — same contract as the brute-force backend.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableFor(index)} USING vec0(
         id TEXT PRIMARY KEY,
         embedding float[${dim}] distance_metric=${metric === 'euclidean' ? 'L2' : 'cosine'},
         deviceId integer,
         timestamp integer,
         className text,
         modelId text,
         +extra text
       )`,
    )
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${registryTable} (id TEXT PRIMARY KEY, dim INTEGER NOT NULL, metric TEXT NOT NULL)`,
    )
    this.db
      .prepare(`INSERT OR REPLACE INTO ${registryTable}(id, dim, metric) VALUES (?, ?, ?)`)
      .run(index, BigInt(dim), metric)

    this.specs.set(index, { dim, metric })
  }

  private specOf(index: string): { dim: number; metric: VectorMetric } {
    const spec = this.specs.get(index)
    if (spec === undefined) throw new Error(`vector-store: index "${index}" was never declared`)
    return spec
  }

  async upsert(
    index: string,
    items: readonly { id: string; vector: string; metadata: VectorMetadata }[],
  ): Promise<{ upserted: number; rejected: number }> {
    const spec = this.specOf(index)
    // DELETE then INSERT, not `INSERT OR REPLACE`.
    //
    // On a `vec0` table the OR REPLACE form leaves the row count correct and
    // the METADATA stale — an upsert that reports success and silently keeps
    // the old values. Caught by a test that re-upserted one id with a new
    // timestamp and read back the old one.
    const del = this.db.prepare(`DELETE FROM ${tableFor(index)} WHERE id = ?`)
    const stmt = this.db.prepare(
      `INSERT INTO ${tableFor(index)}
       (id, embedding, deviceId, timestamp, className, modelId, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )

    let upserted = 0
    let rejected = 0
    for (const item of items) {
      if (vectorDimFromBase64(item.vector) !== spec.dim) {
        rejected += 1
        continue
      }
      try {
        const extra: VectorMetadata = {}
        for (const [k, v] of Object.entries(item.metadata)) {
          if (!isPromoted(k)) extra[k] = v
        }
        del.run(item.id)
        stmt.run(
          item.id,
          toBlob(item.vector),
          asInteger(item.metadata['deviceId']),
          asInteger(item.metadata['timestamp']),
          asText(item.metadata['className']),
          asText(item.metadata['modelId']),
          JSON.stringify(extra),
        )
        upserted += 1
      } catch (err) {
        rejected += 1
        this.logger.warn('sqlite-vec upsert failed', {
          meta: { index, id: item.id, error: String(err) },
        })
      }
    }
    if (rejected > 0) {
      this.logger.warn('sqlite-vec rejected items on upsert', {
        meta: { index, rejected, expectedDim: spec.dim },
      })
    }
    return { upserted, rejected }
  }

  async query(params: {
    index: string
    vector: string
    topK: number
    minScore?: number
    filter?: VectorFilter
  }): Promise<VectorQueryOutcome> {
    const spec = this.specOf(params.index)
    if (decodeVectorBase64(params.vector).length !== spec.dim) {
      throw new Error(
        `vector-store: query vector has ${decodeVectorBase64(params.vector).length} dims, index "${params.index}" has ${spec.dim}`,
      )
    }

    const { clauses, values, unpushable } = compileFilter(params.filter)
    const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''
    const k = Math.min(Math.max(Math.floor(params.topK), 1), VEC_KNN_MAX_K)
    if (k !== params.topK) {
      // Never silent: the caller is about to receive fewer matches than it
      // asked for, and a short result that looks complete is how "the sweep
      // quietly stopped" starts.
      this.logger.warn('sqlite-vec: topK clamped to the extension ceiling', {
        meta: { index: params.index, requested: params.topK, k, ceiling: VEC_KNN_MAX_K },
      })
    }
    // Profiled on the SAME window as the relational engine: this index shares
    // the connection, the file and the single JS thread, so a KNN that scans
    // is indistinguishable — from the event loop's point of view — from a
    // table scan. A report that omitted it would name the wrong culprit.
    const rows = this.measured({ op: 'vectorQuery', collection: tableFor(params.index) }, () =>
      this.db
        .prepare(
          `SELECT id, distance, deviceId, timestamp, className, modelId, extra
         FROM ${tableFor(params.index)}
         WHERE embedding MATCH ? AND k = ?${where}
         ORDER BY distance`,
        )
        .all(toBlob(params.vector), BigInt(k), ...values),
    )

    const minScore = params.minScore ?? Number.NEGATIVE_INFINITY
    const matches: VectorMatchRow[] = []
    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue
      const row = raw as Record<string, unknown>
      const id = asText(row['id'])
      const distance =
        typeof row['distance'] === 'number' ? row['distance'] : Number(row['distance'])
      if (id === null || !Number.isFinite(distance)) continue

      const metadata = rebuild(row)
      // A clause the extension could not compile is applied here rather than
      // ignored — an unapplied filter returns rows the caller treats as matches.
      if (!passesUnpushable(metadata, unpushable)) continue

      const score = spec.metric === 'euclidean' ? -distance : 1 - distance
      if (score < minScore) continue
      matches.push({ id, score, metadata })
    }

    return {
      matches,
      scanned: rows.length,
      // `k` bounds the KNN itself, so a full result set at the CALLER's own
      // limit means the extension stopped where it was told — not truncation.
      // It is only truncation when we lowered `k` underneath the caller and
      // the search then filled it, because rows beyond it were never compared.
      truncated: k < params.topK && rows.length >= k,
      // Always the real number, clamped or not. A caller that compares this to
      // what it asked for cannot mistake a ceiling for an empty index.
      effectiveTopK: k,
    }
  }

  /**
   * Ids read back WITH their vectors.
   *
   * `vec0` returns a vector column as the packed Float32 blob it stores, which
   * is byte-for-byte what `upsert` was given — so the round trip is a base64
   * encode and nothing else. No re-normalisation, no float re-ordering: a
   * gallery loaded through here ranks identically to one loaded from the JSON
   * column it replaced.
   */
  async fetchByIds(index: string, ids: readonly string[]): Promise<VectorFetchRow[]> {
    this.specOf(index)
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.measured({ op: 'vectorFetch', collection: tableFor(index) }, () =>
      this.db
        .prepare(
          `SELECT id, embedding, deviceId, timestamp, className, modelId, extra
           FROM ${tableFor(index)} WHERE id IN (${placeholders})`,
        )
        .all(...ids),
    )

    const out: VectorFetchRow[] = []
    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue
      const row = raw as Record<string, unknown>
      const id = asText(row['id'])
      if (id === null) continue
      const blob = row['embedding']
      // A row whose vector did not come back as bytes is DROPPED, not returned
      // with an empty vector: an empty vector scores 0 against everything and
      // would silently un-enrol a person rather than fail.
      if (!Buffer.isBuffer(blob)) {
        this.logger.warn('sqlite-vec: row has no readable vector — skipped', {
          meta: { index, id },
        })
        continue
      }
      out.push({ id, vector: blob.toString('base64'), metadata: rebuild(row) })
    }
    return out
  }

  /**
   * One page of the whole index, unranked.
   *
   * `LIMIT ? OFFSET ?` over the `vec0` table with NO `MATCH` clause: a plain
   * scan, so the extension's KNN `k` ceiling ({@link VEC_KNN_MAX_K}) does not
   * apply and no distance is computed at all. Ordered by `id` so a cursor means
   * the same thing across calls — `rowid` order is not stable under the
   * DELETE-then-INSERT upsert this class performs.
   *
   * The cursor is an OFFSET, so rows deleted behind the walk shift the window.
   * That is acceptable and deliberate for the one caller: a reconcile that
   * misses a row this pass sees it next pass, and the alternative — a keyset
   * cursor on a virtual table whose ordering the extension owns — buys nothing
   * for a walk that is idempotent by construction.
   */
  async scan(index: string, cursor: number, limit: number): Promise<VectorScanPage> {
    this.specOf(index)
    const offset = Math.max(0, Math.floor(cursor))
    const take = Math.max(1, Math.floor(limit))
    const rows = this.measured({ op: 'vectorScan', collection: tableFor(index) }, () =>
      this.db
        .prepare(
          `SELECT id, deviceId, timestamp, className, modelId, extra
           FROM ${tableFor(index)} ORDER BY id LIMIT ? OFFSET ?`,
        )
        .all(BigInt(take), BigInt(offset)),
    )

    const items: Array<{ id: string; metadata: VectorMetadata }> = []
    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue
      const row = raw as Record<string, unknown>
      const id = asText(row['id'])
      if (id === null) continue
      items.push({ id, metadata: rebuild(row) })
    }
    // End of index is a SHORT PAGE, and it is reported as `null` rather than
    // left for the caller to infer: a caller inferring the end from
    // `items.length < limit` would stop early the first time a row failed to
    // parse, which is the same class of bug as the clamp this replaces.
    return { items, nextCursor: rows.length < take ? null : offset + rows.length }
  }

  async getByIds(
    index: string,
    ids: readonly string[],
  ): Promise<Array<{ id: string; metadata: VectorMetadata }>> {
    this.specOf(index)
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT id, deviceId, timestamp, className, modelId, extra
         FROM ${tableFor(index)} WHERE id IN (${placeholders})`,
      )
      .all(...ids)

    const out: Array<{ id: string; metadata: VectorMetadata }> = []
    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue
      const row = raw as Record<string, unknown>
      const id = asText(row['id'])
      if (id === null) continue
      out.push({ id, metadata: rebuild(row) })
    }
    return out
  }

  async deleteByIds(index: string, ids: readonly string[]): Promise<number> {
    this.specOf(index)
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const res = this.db
      .prepare(`DELETE FROM ${tableFor(index)} WHERE id IN (${placeholders})`)
      .run(...ids)
    return res.changes
  }

  async deleteByFilter(index: string, filter: VectorFilter): Promise<number> {
    this.specOf(index)
    const { clauses, values, unpushable } = compileFilter(filter)

    if (unpushable.length === 0) {
      const where = clauses.length > 0 ? clauses.join(' AND ') : '1=1'
      return this.db.prepare(`DELETE FROM ${tableFor(index)} WHERE ${where}`).run(...values).changes
    }

    // A clause SQL cannot evaluate forces select-then-delete: deleting on the
    // pushable part alone would remove rows the caller wanted kept.
    const rows = this.db
      .prepare(
        `SELECT id, deviceId, timestamp, className, modelId, extra FROM ${tableFor(index)}${
          clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
        }`,
      )
      .all(...values)
    const doomed: string[] = []
    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue
      const row = raw as Record<string, unknown>
      const id = asText(row['id'])
      if (id !== null && passesUnpushable(rebuild(row), unpushable)) doomed.push(id)
    }
    return this.deleteByIds(index, doomed)
  }

  async stats(index: string): Promise<VectorIndexStats> {
    const spec = this.specOf(index)
    const row = this.db.prepare(`SELECT count(*) AS c FROM ${tableFor(index)}`).get()
    const count =
      typeof row === 'object' && row !== null ? Number((row as Record<string, unknown>)['c']) : 0
    return {
      backend: 'sqlite-vec',
      count: Number.isFinite(count) ? count : 0,
      dim: spec.dim,
      metric: spec.metric,
      // vec0's brute-force KNN over a compiled prefilter is still EXACT — the
      // win is the C loop and the packed blob, not an approximation.
      exact: true,
    }
  }
}

function isPromoted(key: string): boolean {
  for (const p of PROMOTED_COLUMNS) if (p === key) return true
  return false
}

function metricOf(value: unknown): VectorMetric {
  return value === 'euclidean' || value === 'dot' ? value : 'cosine'
}

/** Split a filter into SQL clauses and the remainder JS must apply. */
function compileFilter(filter: VectorFilter | undefined): {
  clauses: string[]
  values: unknown[]
  unpushable: Array<{ key: string; equals?: unknown; between?: [number, number] }>
} {
  const clauses: string[] = []
  const values: unknown[] = []
  const unpushable: Array<{ key: string; equals?: unknown; between?: [number, number] }> = []
  if (filter === undefined) return { clauses, values, unpushable }

  for (const [key, value] of Object.entries(filter.equals ?? {})) {
    if (!isPromoted(key)) {
      unpushable.push({ key, equals: value })
      continue
    }
    clauses.push(`${key} = ?`)
    values.push(typeof value === 'number' ? BigInt(Math.trunc(value)) : value)
  }
  for (const [key, [lo, hi]] of Object.entries(filter.between ?? {})) {
    if (!isPromoted(key)) {
      unpushable.push({ key, between: [lo, hi] })
      continue
    }
    clauses.push(`${key} BETWEEN ? AND ?`)
    values.push(BigInt(Math.trunc(lo)), BigInt(Math.trunc(hi)))
  }
  return { clauses, values, unpushable }
}

function passesUnpushable(
  metadata: VectorMetadata,
  unpushable: ReadonlyArray<{ key: string; equals?: unknown; between?: [number, number] }>,
): boolean {
  for (const clause of unpushable) {
    const actual = metadata[clause.key]
    if (clause.equals !== undefined && actual !== clause.equals) return false
    if (clause.between !== undefined) {
      const [lo, hi] = clause.between
      if (typeof actual !== 'number' || actual < lo || actual > hi) return false
    }
  }
  return true
}

/** Rebuild caller metadata from the promoted columns plus the JSON remainder. */
function rebuild(row: Record<string, unknown>): VectorMetadata {
  let extra: VectorMetadata = {}
  const rawExtra = row['extra']
  if (typeof rawExtra === 'string' && rawExtra.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawExtra)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        extra = parsed as VectorMetadata
      }
    } catch {
      // A corrupt remainder must not sink the hit — the promoted columns are
      // what the caller filters and joins on.
    }
  }

  const out: VectorMetadata = { ...extra }
  const deviceId = readInt(row['deviceId'])
  const timestamp = readInt(row['timestamp'])
  const className = readText(row['className'])
  const modelId = readText(row['modelId'])
  if (deviceId !== null) out['deviceId'] = deviceId
  if (timestamp !== null) out['timestamp'] = timestamp
  if (className !== null) out['className'] = className
  if (modelId !== null) out['modelId'] = modelId
  return out
}

export { encodeVectorBase64 }
