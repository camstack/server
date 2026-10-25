/**
 * Shapes shared by the vector index and its provider.
 *
 * There is ONE index implementation on purpose (`SqliteVecVectorIndex`). A
 * second one behind a flag would mean two code paths that can disagree and a
 * silent fallback that turns "the extension is missing" into "search is
 * mysteriously slow". Replaceability lives at the CAPABILITY — another provider
 * takes over wholesale — not inside this module.
 */

import type { VectorFilter, VectorMetadata, VectorMetric } from '@camstack/types'

/** Metadata keys promoted to real, indexable columns in every backend. */
export const PROMOTED_COLUMNS = ['deviceId', 'timestamp', 'className', 'modelId'] as const

/** A ranked hit as a backend returns it. */
export interface VectorMatchRow {
  readonly id: string
  /** Similarity, higher is nearer — NOT a distance. Backends convert. */
  readonly score: number
  readonly metadata: VectorMetadata
}

/**
 * What one ranked search returned, INCLUDING the `k` it really ran with.
 *
 * `effectiveTopK` is part of the answer rather than a log line for the reason
 * `vector-store.cap.ts` records: a ceiling the caller learns about only from
 * the provider's own log is a number truncated in silence.
 */
export interface VectorQueryOutcome {
  readonly matches: VectorMatchRow[]
  readonly scanned: number
  readonly truncated: boolean
  readonly effectiveTopK: number
}

/** One row read back WITH its vector, base64 Float32LE. */
export interface VectorFetchRow {
  readonly id: string
  readonly vector: string
  readonly metadata: VectorMetadata
}

/** One page of an unranked walk. `nextCursor: null` means end of index. */
export interface VectorScanPage {
  readonly items: Array<{ id: string; metadata: VectorMetadata }>
  readonly nextCursor: number | null
}

export interface VectorIndexStats {
  readonly backend: string
  readonly count: number
  readonly dim: number
  readonly metric: VectorMetric
  readonly exact: boolean
}

export interface VectorIndexBackend {
  loadIndexRegistry(): Promise<void>
  declareIndex(index: string, dim: number, metric: VectorMetric): Promise<void>
  upsert(
    index: string,
    items: readonly { id: string; vector: string; metadata: VectorMetadata }[],
  ): Promise<{ upserted: number; rejected: number }>
  query(params: {
    index: string
    vector: string
    topK: number
    minScore?: number
    filter?: VectorFilter
  }): Promise<VectorQueryOutcome>
  getByIds(
    index: string,
    ids: readonly string[],
  ): Promise<Array<{ id: string; metadata: VectorMetadata }>>
  fetchByIds(index: string, ids: readonly string[]): Promise<VectorFetchRow[]>
  scan(index: string, cursor: number, limit: number): Promise<VectorScanPage>
  deleteByIds(index: string, ids: readonly string[]): Promise<number>
  deleteByFilter(index: string, filter: VectorFilter): Promise<number>
  stats(index: string): Promise<VectorIndexStats>
}
