/**
 * A CLIP detail from the runner → the object-embedding store (D658).
 *
 * The index a vector lands in is chosen from its model id (D649), so that id
 * must be the word of the node that RAN the encoder — the runner stamps it from
 * the pool variant that produced the vector. This path used to fall back to the
 * embedding encoder's active model when the detail named none: the cluster row
 * as a second process read it, on its own schedule. A detail that names no
 * model is refused by name instead; nothing here guesses one.
 */
import type { EmbeddingWriteOutcome, ObjectEmbeddingStore } from './store/object-embedding-store.js'

/** What the route needs from one `DetailResult` of a CLIP step. */
export interface ClipDetailRouteInput {
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly className: string
  readonly score: number
  /** The runner's wire form (base64 little-endian float32) — stored verbatim. */
  readonly embeddingBase64: string
  /** The model the runner stamped; absent or empty ⇒ refused. */
  readonly embeddingModelId: string | undefined
  readonly keyFrameMediaId?: number
}

export type ClipDetailStore = Pick<ObjectEmbeddingStore, 'upsertIfBetter' | 'noteRefused'>

export async function routeClipDetailToStore(
  store: ClipDetailStore,
  input: ClipDetailRouteInput,
): Promise<EmbeddingWriteOutcome> {
  const modelId = input.embeddingModelId
  if (modelId === undefined || modelId === '') {
    store.noteRefused({
      deviceId: input.deviceId,
      modelId: null,
      reason: 'no-model-id',
      trackId: input.trackId,
    })
    return 'failed'
  }
  return store.upsertIfBetter({
    trackId: input.trackId,
    deviceId: input.deviceId,
    timestamp: input.timestamp,
    className: input.className,
    embeddingBase64: input.embeddingBase64,
    modelId,
    confidence: input.score,
    ...(input.keyFrameMediaId !== undefined ? { keyFrameMediaId: input.keyFrameMediaId } : {}),
  })
}
