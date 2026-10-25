// ---------------------------------------------------------------------------
// Embedding dispatcher — config + emitted-event types
// ---------------------------------------------------------------------------
//
// Extracted from the retired `enrichment-engine/types.ts` when the
// EmbeddingDispatcher migrated into `pipeline-analytics`. The dispatcher owns
// the object/face embedding path: on each detection it resolves the frame,
// crops the ROI, and calls the `embedding-encoder` cap (which persists the
// vector as a side effect, feeding the search/face path). This module carries
// only the pieces the dispatcher needs — the master toggle now lives on
// `pipeline-analytics`'s own settings.

/** Per-dispatcher embedding config (the `embedding` sub-config of the old
 *  EnrichmentConfig). `enabled` is driven by the pipeline-analytics setting. */
export interface EmbeddingConfig {
  readonly enabled: boolean
  readonly modelId: string // 'clip-vit-b32' | 'clip-vit-b16' | 'siglip2-b16-256'
  readonly agentId: string | 'local'
  readonly backend: 'cpu' | 'coreml' | 'cuda'
  readonly classes: readonly string[] // [] = all classes
  readonly minConfidence: number
  readonly maxPerSecPerCamera: number
  readonly cropStrategy: 'first' | 'best-confidence' | 'track-end'
  readonly retentionDays: number
}

/** Telemetry event emitted after a track crop is embedded. Lossy by design;
 *  the encode() side effect (vector persistence) is the durable outcome. */
export interface EmbeddingStoredEvent {
  readonly deviceId: number
  readonly trackId: string
  readonly class: string
  readonly embeddingId: string // reference in vector store
  readonly modelId: string
  readonly embeddingDim: number
  readonly inferenceMs: number
  readonly timestamp: number
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: true,
  modelId: 'clip-vit-b32',
  agentId: 'local',
  backend: 'cpu',
  classes: [],
  minConfidence: 0.5,
  maxPerSecPerCamera: 1,
  cropStrategy: 'first',
  retentionDays: 30,
}
