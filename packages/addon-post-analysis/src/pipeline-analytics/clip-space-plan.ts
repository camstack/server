/**
 * Which CLIP feature space a search reads and a rebuild fills — decided in one
 * place, from the model's metadata, before any text is encoded or any key frame
 * is read (D649, D54: the cheap question first).
 */
import {
  type ClipSearchStrictness,
  type RebuildObjectEmbeddingsRefusal,
  resolveClipSearchMinScore,
} from '@camstack/types'
import type { ClipModelRegistry } from '../shared/clip/clip-model-registry.js'

/** What a search asked for, minus the text and the prefilters. */
export interface ClipSearchRequest {
  /** Search this model's index; absent ⇒ the cluster row's model. */
  readonly modelId?: string
  readonly minScore?: number
  readonly strictness?: ClipSearchStrictness
}

/** The refusal a non-admin gets for naming a model other than the cluster row's. */
export const MODEL_OVERRIDE_REQUIRES_ADMIN = 'model-override-requires-admin'

/** Who is asking — the server-injected `CapCaller`, reduced to what matters here. */
export interface ClipSearchCaller {
  readonly isAdmin: boolean
}

/** The space a search runs in, and the cosine floor it runs with. */
export interface ClipSearchPlan {
  readonly modelId: string
  readonly index: string
  readonly minScore: number
}

/**
 * Resolve a search's space and floor. THROWS rather than returning an empty
 * plan: a search that cannot name a space has not searched, and an empty result
 * list would read as "nothing matched" (D315).
 *
 * @param clusterModelId the cluster row's `clip-embedding` model, `null` when it
 *   could not be read.
 * @param caller the server-injected caller; `null` (no identity) is non-admin.
 */
export function resolveClipSearchPlan(
  request: ClipSearchRequest,
  clusterModelId: string | null,
  registry: Pick<ClipModelRegistry, 'resolve'>,
  caller: ClipSearchCaller | null,
): ClipSearchPlan {
  // Overriding the space is an operator tool (the cutover comparison). A
  // share link or a viewer session may NAME the cluster's own model, nothing
  // else — refused by name, never quietly re-pointed at the cluster row.
  // An unreadable row cannot confirm a named model is the cluster's: refused.
  if (
    request.modelId !== undefined &&
    caller?.isAdmin !== true &&
    request.modelId !== clusterModelId
  ) {
    throw new Error(
      `searchObjectEvents: ${MODEL_OVERRIDE_REQUIRES_ADMIN} — "${request.modelId}" is not the cluster's semantic-search model`,
    )
  }
  const modelId = request.modelId ?? clusterModelId
  if (modelId === null) {
    throw new Error('searchObjectEvents: the cluster CLIP model could not be read')
  }
  const model = registry.resolve(modelId)
  if (model === null) {
    throw new Error(`searchObjectEvents: "${modelId}" is not a CLIP model — no index to search`)
  }
  return {
    modelId,
    index: model.meta.vectorIndex,
    // The MODEL's floor: 0.2 kept 96% of matched pairs on MobileCLIP S1 and
    // 2.7% on SigLIP2. An absolute `minScore` from the caller still wins.
    minScore: resolveClipSearchMinScore(model.meta, {
      ...(request.minScore !== undefined ? { minScore: request.minScore } : {}),
      ...(request.strictness !== undefined ? { strictness: request.strictness } : {}),
    }),
  }
}

/** A rebuild pass's pin, or the reason it does not start. */
export type ClipRebuildPin =
  | { readonly kind: 'pinned'; readonly modelId: string; readonly index: string }
  | {
      readonly kind: 'refused'
      readonly refusal: Extract<RebuildObjectEmbeddingsRefusal, 'not-a-clip-model'>
      readonly modelId: string
    }

/**
 * Pin ONE model for a whole rebuild pass (D54). `clusterModelId` is the model
 * the OWNER confirmed by two agreeing reads (D651, `ClusterPinConfirmer`) — an
 * unconfirmed row never reaches here, it is refused upstream under the
 * confirmer's own reason. A model with no CLIP metadata refuses the pass: there
 * would be no index to fill and no dimension to check against.
 */
export function pinClipRebuild(
  clusterModelId: string,
  registry: Pick<ClipModelRegistry, 'resolve'>,
): ClipRebuildPin {
  const model = registry.resolve(clusterModelId)
  if (model === null) {
    return { kind: 'refused', refusal: 'not-a-clip-model', modelId: clusterModelId }
  }
  return { kind: 'pinned', modelId: clusterModelId, index: model.meta.vectorIndex }
}

/** The embedding encoder's text leg, as the search needs it. */
export type EncodeQuery = (input: {
  readonly text: string
  readonly modelId: string
}) => Promise<{ readonly embedding: readonly number[] }>

/**
 * Encode a query in ONE model's space, or THROW with the cause.
 *
 * A failed encode — a tower still downloading, a missing tokenizer, a dimension
 * refusal — used to become `[]`, which the UI rendered as "no results": a
 * search that never ran, reading as one that found nothing (D315).
 */
export async function encodeClipQuery(
  encode: EncodeQuery,
  text: string,
  modelId: string,
  warn: (message: string, extras: { readonly meta: Record<string, unknown> }) => void,
): Promise<Float32Array> {
  try {
    const { embedding } = await encode({ text, modelId })
    return new Float32Array(embedding)
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err)
    warn('searchObjectEvents: encodeText failed', { meta: { modelId, error: cause } })
    throw new Error(
      `searchObjectEvents: the query could not be encoded in ${modelId}'s space — ${cause}`,
      { cause: err },
    )
  }
}
