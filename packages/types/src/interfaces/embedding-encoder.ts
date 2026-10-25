/**
 * Legacy runtime types — re-exported from the canonical cap definition so
 * existing consumers (post-analysis addon, future enrichment-engine) keep
 * compiling. The cap def in
 * `packages/types/src/capabilities/embedding-encoder.cap.ts` is the single
 * source of truth via Zod schemas.
 *
 * Note: the wire `embedding` field is `number[]` (Zod-validated). The
 * runtime engines hand back `Float32Array`; `EmbeddingResult` keeps the
 * narrower runtime shape for in-process consumers, while the cap's wire
 * surface deliberately widens it to a plain array for tRPC serialization.
 */
export interface EmbeddingResult {
  readonly embedding: Float32Array
  readonly inferenceMs: number
}

export interface EmbeddingInfo {
  readonly modelId: string
  readonly embeddingDim: number
  readonly ready: boolean
}

/**
 * Legacy interface — superseded by `IEmbeddingEncoderProvider` (canonical
 * Zod-inferred shape) exported from
 * `packages/types/src/capabilities/embedding-encoder.cap.ts`.
 */
export type IEmbeddingEncoder =
  import('../capabilities/embedding-encoder.cap.js').IEmbeddingEncoderProvider
