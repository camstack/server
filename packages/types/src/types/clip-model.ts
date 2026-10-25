/**
 * A CLIP model's feature-space contract — what every consumer of its vectors
 * must agree on, carried BY THE MODEL rather than re-derived by each consumer.
 *
 * ## Why this lives on the catalog entry
 *
 * Until 2026-09-26 each fact was hard-coded where it was used: the text window
 * (77) and pad id (0) in `text_encoder_inference.py`, the index name
 * (`object-clip`) in the object-embedding store, the "is this a CLIP vector"
 * test as `embeddingModelId.startsWith('mobileclip-')`, the search floor (0.2)
 * in the cap default, and the dimension (512) behind a `getModelMeta` that fell
 * back to MobileCLIP for any id it did not know. Every one of those is wrong for
 * the next model, and each one failed SILENTLY for SigLIP2 in the 2026-09-26
 * spike: vectors dropped before the store with no log, 768-d queries truncated
 * to 512 and ranked as garbage, 97% of true matches under the 0.2 floor (D649).
 *
 * A model now declares its own contract here, and a model with no `clip` block
 * is not a CLIP model to any consumer. That is also the seam Model Studio uses
 * for a user-supplied CLIP model: its registry row carries the same block.
 */
import { z } from 'zod'

/**
 * `object-clip-<model>`. Lower-case and dash-only so the sqlite-vec table name
 * derived from it (`vec_` + non-word → `_`) cannot collide with another index's.
 * The bare `object-clip` — the retired MobileCLIP index — is NOT accepted (D871):
 * a model that names it is a catalog defect, not a model.
 */
export const CLIP_VECTOR_INDEX_PATTERN = /^object-clip-[a-z0-9][a-z0-9-]*$/

export const ClipModelMetaSchema = z.object({
  /** The paired text encoder's catalog id (the embedding-encoder's text catalog). */
  textModelId: z.string().min(1),
  /** Output dimension of BOTH towers. A vector of any other length is refused. */
  embeddingDim: z.number().int().positive(),
  /**
   * The `vector-store` index this model's vectors live in. ONE feature space
   * per index: two models share an index only when their vectors are ranked
   * against each other, which for CLIP means never across families. Every
   * model gets its own.
   */
  vectorIndex: z.string().regex(CLIP_VECTOR_INDEX_PATTERN),
  /**
   * The text encoder's tokenizer, a declared SIBLING file of its onnx. The name
   * must be unique per tokenizer: every model's siblings land in ONE flat
   * models directory, so two different tokenizers under the same name would
   * silently overwrite each other (whichever model downloaded last wins, and
   * the other one tokenises with the wrong vocabulary).
   */
  tokenizerFile: z.string().min(1),
  /** Token window the text graph takes (SigLIP2: 64; CLIP BPE: 77). */
  contextLength: z.number().int().positive(),
  /** Id the tokenizer pads with. */
  padId: z.number().int().nonnegative(),
  /**
   * The search cosine floor at `strictness: 'loose'` — calibrated per model,
   * because cosine bands are a property of the model: 0.2 keeps 96% of matched
   * COCO caption-image pairs on MobileCLIP S1 and 2.7% on SigLIP2.
   */
  searchMinScore: z.number().min(0).max(1),
})
export type ClipModelMeta = z.infer<typeof ClipModelMetaSchema>

/**
 * Model-relative search strictness. The operator picks how picky, the model
 * says what that means in its own cosine band. On MobileCLIP (floor 0.2) these
 * reproduce the admin UI's historical absolute presets 0.20 / 0.25 / 0.30.
 */
export const CLIP_SEARCH_STRICTNESS = ['loose', 'balanced', 'strict'] as const
export const ClipSearchStrictnessSchema = z.enum(CLIP_SEARCH_STRICTNESS)
export type ClipSearchStrictness = z.infer<typeof ClipSearchStrictnessSchema>

export const CLIP_STRICTNESS_FACTOR: Readonly<Record<ClipSearchStrictness, number>> = {
  loose: 1,
  balanced: 1.25,
  strict: 1.5,
}

/** What a search asked for. Both absent ⇒ the model's own floor. */
export interface ClipSearchFloorRequest {
  /** An ABSOLUTE cosine floor. Wins when present — the caller named a number. */
  readonly minScore?: number
  readonly strictness?: ClipSearchStrictness
}

/**
 * The cosine floor a search runs with.
 *
 * An explicit `minScore` is honoured verbatim: it is a number a caller chose,
 * and silently rescaling it would make the same URL mean different things on
 * two installs. Everything else is relative to the model.
 */
export function resolveClipSearchMinScore(
  meta: Pick<ClipModelMeta, 'searchMinScore'>,
  request: ClipSearchFloorRequest,
): number {
  if (request.minScore !== undefined) return request.minScore
  const factor = CLIP_STRICTNESS_FACTOR[request.strictness ?? 'loose']
  return Math.min(1, Math.round(meta.searchMinScore * factor * 1000) / 1000)
}
