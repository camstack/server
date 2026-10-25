/**
 * Pure helpers for the CLIP object-embedding path (semantic search).
 *
 *  - `isClipObjectEmbedding` — the filter selecting the tracked detections whose
 *    embedding belongs in the object-embedding store: a vector whose model
 *    carries CLIP metadata (D649). arcface (face) embeddings carry none and are
 *    handled by the FaceRecognizer, never here. It used to test
 *    `startsWith('mobileclip-')`, which dropped every other CLIP model's
 *    vectors before the store with no log line.
 *  - `resolveSearchThumbnailUrl` — the search-hit thumbnail resolver. It points
 *    a hit at the CLIP embedding row's OWN crop (the crop captured on the
 *    embedding's peak frame → the hit thumbnail IS the embedded crop), and only
 *    falls back to the representative event's owner ladder when the embedding
 *    row has no crop yet, so a hit never renders blank.
 */

import {
  BUILTIN_CLIP_MODELS,
  type ClipModelRegistry,
} from '../../shared/clip/clip-model-registry.js'
import { mediaFileUrl, mediaOwnerUrl } from '../media-file-url.js'
import type { TrackedDetectionOut } from './frame-processor.js'

export interface ClipObjectEmbedding {
  readonly embedding: readonly number[]
  readonly embeddingModelId: string
}

export function isClipObjectEmbedding(
  t: TrackedDetectionOut,
  registry: Pick<ClipModelRegistry, 'resolve'> = BUILTIN_CLIP_MODELS,
): t is TrackedDetectionOut & ClipObjectEmbedding {
  return (
    Array.isArray(t.embedding) &&
    t.embedding.length > 0 &&
    typeof t.embeddingModelId === 'string' &&
    registry.resolve(t.embeddingModelId) !== null
  )
}

export interface SearchThumbnailInput {
  /** The addon's event-media data-plane base URL (`null` when unavailable). */
  readonly baseUrl: string | null
  /** The representative object event's id (its crop is the fallback thumbnail). */
  readonly eventId: string
  /** The event's camera — required for the generation-scoped owner URL (D694). */
  readonly deviceId: number
  /** The event's own timestamp — required for the generation-scoped owner URL. */
  readonly recordAt: number
  /**
   * The CLIP embedding row's crop media id, when the embedding-peak crop was
   * captured. Preferred so the search thumbnail is the embedded crop. Addressed
   * as `/m/<mediaId>` (D482) — never as a legacy composite key.
   */
  readonly embeddingMediaId?: number
}

export function resolveSearchThumbnailUrl(input: SearchThumbnailInput): string | undefined {
  if (input.baseUrl === null) return undefined
  if (input.embeddingMediaId !== undefined) {
    return mediaFileUrl(input.baseUrl, input.embeddingMediaId)
  }
  return mediaOwnerUrl(input.baseUrl, 'object', input.eventId, {
    deviceId: input.deviceId,
    recordAt: input.recordAt,
  })
}
