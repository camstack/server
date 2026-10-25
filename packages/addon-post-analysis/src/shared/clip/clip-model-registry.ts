/**
 * The CLIP models this package knows, keyed by IMAGE model id, each with its
 * feature-space contract (`ClipModelMeta`, D649).
 *
 * Shared by the two addons of this package that must agree on it: the
 * embedding encoder (text window, pad id, tokenizer, dimension) and pipeline
 * analytics (which index a vector lives in, whether a detection's vector is a
 * CLIP vector at all, the search floor). Built FROM the catalog entries' `clip`
 * blocks — the catalog is the one place a model's facts are written, and a
 * user CLIP model (Model Studio) joins by carrying the same block.
 *
 * There is deliberately no fallback. The previous `getModelMeta` answered an
 * unknown id with another model's meta, which is how a 768-d SigLIP2 query was
 * truncated to 512 dims and ranked as noise with nothing in any log. An unknown
 * id is `null` here, and every caller says what it did about it.
 */
import type { ClipModelMeta, ModelCatalogEntry } from '@camstack/types'
import { CLIP_IMAGE_MODELS } from '../../embedding-encoder/catalogs/embedding-models.js'

/** The model in force when nobody has chosen — the cluster row's default. */
export const DEFAULT_CLIP_MODEL = 'siglip2-b16-224'

/** One CLIP model: its image id, its image input size and its contract. */
export interface ClipModel {
  readonly modelId: string
  /** Square input side of the image tower. */
  readonly inputSize: number
  readonly meta: ClipModelMeta
}

/** One vector index and everything written into it. */
export interface ClipVectorSpace {
  readonly index: string
  readonly dim: number
  /** The image models whose vectors live here (models of one feature space share an index). */
  readonly modelIds: readonly string[]
}

/** The lookup every CLIP consumer takes as a dependency, so a test can pass its own. */
export interface ClipModelRegistry {
  /** The model, or `null` when the id carries no CLIP metadata. */
  resolve(modelId: string): ClipModel | null
  /** The index a model's vectors live in, or `null` for a non-CLIP id. */
  spaceFor(modelId: string): ClipVectorSpace | null
  /** Every index any known model writes — what a delete, a scan or a wipe must reach. */
  spaces(): readonly ClipVectorSpace[]
}

/**
 * Build a registry from catalog entries. Throws when two models share an index
 * at different dimensions: that is a catalog defect, and the vector store would
 * refuse the second model's writes one at a time, forever, at runtime.
 */
export function buildClipModelRegistry(entries: readonly ModelCatalogEntry[]): ClipModelRegistry {
  const models = new Map<string, ClipModel>()
  const spaces = new Map<string, ClipVectorSpace>()
  for (const entry of entries) {
    const meta = entry.clip
    if (meta === undefined) continue
    models.set(entry.id, { modelId: entry.id, inputSize: entry.inputSize.width, meta })
    const existing = spaces.get(meta.vectorIndex)
    if (existing !== undefined && existing.dim !== meta.embeddingDim) {
      throw new Error(
        `CLIP index "${meta.vectorIndex}" declared at ${String(existing.dim)} dims by ` +
          `${existing.modelIds.join(', ')} and at ${String(meta.embeddingDim)} by ${entry.id}`,
      )
    }
    spaces.set(meta.vectorIndex, {
      index: meta.vectorIndex,
      dim: meta.embeddingDim,
      modelIds: [...(existing?.modelIds ?? []), entry.id],
    })
  }
  const all = [...spaces.values()]
  return {
    resolve: (modelId) => models.get(modelId) ?? null,
    spaceFor: (modelId) => {
      const model = models.get(modelId)
      return model === undefined ? null : (spaces.get(model.meta.vectorIndex) ?? null)
    },
    spaces: () => all,
  }
}

/** The built-in catalog's registry. */
export const BUILTIN_CLIP_MODELS: ClipModelRegistry = buildClipModelRegistry(CLIP_IMAGE_MODELS)
