import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * Embedding output. `embedding` is wire-encoded as `number[]` so the
 * Zod-validated tRPC surface round-trips cleanly; consumers that need a
 * `Float32Array` can wrap it on the way out (in-process, no marshalling
 * is involved). `inferenceMs` mirrors the runtime field used by the
 * post-analysis enrichment-engine.
 */
const EmbeddingResultSchema = z.object({
  embedding: z.array(z.number()),
  inferenceMs: z.number(),
})

/** The two CLIP towers the encoder runs; a crash budget is kept per tower. */
export const EmbeddingTowerSchema = z.enum(['image', 'text'])
export type EmbeddingTower = z.infer<typeof EmbeddingTowerSchema>

/**
 * A tower in the terminal `failed` state (D649, D6): it crashed or failed to
 * load `crashes` times within `windowMs`, and is refused by name until an
 * operator `resetFailedModels` or a model change — never on a timer.
 *
 * `nodeId` is the node whose tower failed. The state lives in THAT node's
 * encoder process (in memory — a runner respawn clears it), and one node's
 * answer says nothing about another's.
 */
export const EmbeddingFailedModelSchema = z.object({
  modelId: z.string(),
  tower: EmbeddingTowerSchema,
  nodeId: z.string(),
  crashes: z.number(),
  windowMs: z.number(),
  sinceMs: z.number(),
  lastReason: z.string(),
})
export type EmbeddingFailedModel = z.infer<typeof EmbeddingFailedModelSchema>

/**
 * A model whose REQUIREMENTS can never be met on this node (D649 round 5):
 * an id the catalog does not know, a model URL answering 404/410, a declared
 * sibling (the tokenizer) that is not there. After `attempts` failed builds
 * it is terminally `requirements-failed`, refused by name until an operator
 * `resetFailedModels` or a model change — the same exits as a crashed tower.
 */
export const EmbeddingFailedRequirementSchema = z.object({
  modelId: z.string(),
  tower: EmbeddingTowerSchema,
  nodeId: z.string(),
  attempts: z.number(),
  sinceMs: z.number(),
  lastReason: z.string(),
})
export type EmbeddingFailedRequirement = z.infer<typeof EmbeddingFailedRequirementSchema>

const EmbeddingInfoSchema = z.object({
  modelId: z.string(),
  embeddingDim: z.number(),
  ready: z.boolean(),
  /**
   * The node that answered. Absent only from an encoder older than D649's
   * crash budget — whose `failedModels` is then UNKNOWN (D315), never "none".
   */
  nodeId: z.string().optional(),
  /**
   * Towers in `failed` on the answering node, each row naming it. `undefined`
   * means the node could not say (pre-budget encoder); a node that has the
   * budget always answers an array, empty included.
   */
  failedModels: z.array(EmbeddingFailedModelSchema).optional(),
  /** Models terminally `requirements-failed` on the answering node; same reading as above. */
  failedRequirements: z.array(EmbeddingFailedRequirementSchema).optional(),
})

/**
 * The THREE codes an encoder refusal can carry (D649, D6). Same shape as
 * `VECTOR_INDEX_DIM_CONFLICT`: the code rides in the MESSAGE, because an
 * Error's own properties do not survive the UDS/tRPC hop and its message does,
 * and both sides go through the helpers below — the encoder builds the
 * refusal, the live detail plane classifies on it to count refusals per
 * camera instead of logging one warning per track. The bracketed token
 * carries the code, the model, the tower and the node so a consumer never
 * parses prose.
 *
 * - `EMBEDDING_MODEL_FAILED`: the tower crashed / failed to load past the crash
 *   budget — terminal until `resetFailedModels` or a model change.
 * - `EMBEDDING_REQUIREMENTS_UNAVAILABLE`: files or runtime not there right now
 *   (a download or Python that failed, or the cooldown after one) — the next
 *   request past the cooldown tries again.
 * - `EMBEDDING_REQUIREMENTS_FAILED`: the requirements can never be met (unknown
 *   id, 404/410, missing sibling) and the bounded attempts are spent —
 *   terminal, same exits as a crashed tower.
 */
export const EMBEDDING_MODEL_FAILED = 'embedding-model-failed'
export const EMBEDDING_REQUIREMENTS_UNAVAILABLE = 'embedding-requirements-unavailable'
export const EMBEDDING_REQUIREMENTS_FAILED = 'embedding-requirements-failed'

export const EmbeddingRefusalCodeSchema = z.enum([
  EMBEDDING_MODEL_FAILED,
  EMBEDDING_REQUIREMENTS_UNAVAILABLE,
  EMBEDDING_REQUIREMENTS_FAILED,
])
export type EmbeddingRefusalCode = z.infer<typeof EmbeddingRefusalCodeSchema>

/** What every token names: enough to count a refusal and to point at the reset. */
export interface EmbeddingModelFailure {
  readonly modelId: string
  readonly tower: EmbeddingTower
  readonly nodeId: string
}

/** A parsed refusal: which of the three, and for what. */
export interface EmbeddingRefusal extends EmbeddingModelFailure {
  readonly code: EmbeddingRefusalCode
}

function embeddingRefusalToken(code: EmbeddingRefusalCode, on: EmbeddingModelFailure): string {
  return `[${code} model=${on.modelId} tower=${on.tower} node=${on.nodeId}]`
}

/** The encoder's refusal for a crashed tower, carrying {@link EMBEDDING_MODEL_FAILED}. */
export function embeddingModelFailedError(row: EmbeddingFailedModel): Error {
  return new Error(
    `${embeddingRefusalToken(EMBEDDING_MODEL_FAILED, row)} ` +
      `${row.modelId} (${row.tower} tower) crashed ${String(row.crashes)} times ` +
      `in ${String(Math.round(row.windowMs / 1000))}s on ${row.nodeId} — ${row.lastReason}. ` +
      `Cleared by embeddingEncoder.resetFailedModels({ modelId: "${row.modelId}", nodeId: "${row.nodeId}" }) ` +
      'or a model change.',
  )
}

/** The requirements refusal for THIS request, carrying {@link EMBEDDING_REQUIREMENTS_UNAVAILABLE}. */
export function embeddingRequirementsUnavailableError(
  on: EmbeddingModelFailure,
  reason: string,
): Error {
  return new Error(
    `${embeddingRefusalToken(EMBEDDING_REQUIREMENTS_UNAVAILABLE, on)} ` +
      `${on.modelId} (${on.tower} tower) on ${on.nodeId}: ${reason}`,
  )
}

/** The terminal requirements refusal, carrying {@link EMBEDDING_REQUIREMENTS_FAILED}. */
export function embeddingRequirementsFailedError(row: EmbeddingFailedRequirement): Error {
  return new Error(
    `${embeddingRefusalToken(EMBEDDING_REQUIREMENTS_FAILED, row)} ` +
      `${row.modelId} (${row.tower} tower) on ${row.nodeId}: requirements can never be met ` +
      `— ${String(row.attempts)} attempts, last: ${row.lastReason}. ` +
      `Cleared by embeddingEncoder.resetFailedModels({ modelId: "${row.modelId}", nodeId: "${row.nodeId}" }) ` +
      'or a model change.',
  )
}

const EMBEDDING_REFUSAL_TOKEN = new RegExp(
  `\\[(${EMBEDDING_MODEL_FAILED}|${EMBEDDING_REQUIREMENTS_UNAVAILABLE}|${EMBEDDING_REQUIREMENTS_FAILED}) ` +
    'model=([^\\s\\]]+) tower=(image|text) node=([^\\s\\]]+)\\]',
)

/** The refusal `err` (possibly re-wrapped by a transport) carries, or `null` for any other error. */
export function embeddingRefusalOf(err: unknown): EmbeddingRefusal | null {
  const message = err instanceof Error ? err.message : String(err)
  const match = EMBEDDING_REFUSAL_TOKEN.exec(message)
  if (match === null) return null
  const code = EmbeddingRefusalCodeSchema.safeParse(match[1])
  const tower = EmbeddingTowerSchema.safeParse(match[3])
  if (!code.success || !tower.success || match[2] === undefined || match[4] === undefined) {
    return null
  }
  return { code: code.data, modelId: match[2], tower: tower.data, nodeId: match[4] }
}

/** True when `err` is the crashed-tower refusal. */
export function isEmbeddingModelFailed(err: unknown): boolean {
  return embeddingModelFailedOf(err) !== null
}

/** The model, tower and node a crashed-tower refusal names, or `null` for any other error. */
export function embeddingModelFailedOf(err: unknown): EmbeddingModelFailure | null {
  const refusal = embeddingRefusalOf(err)
  if (refusal === null || refusal.code !== EMBEDDING_MODEL_FAILED) return null
  const { modelId, tower, nodeId } = refusal
  return { modelId, tower, nodeId }
}

/**
 * ONE provider per node (`placement: any-node`), addressed like every global
 * collection: the codegen injects a `{ nodeId?, addonId? }` selector on the
 * void methods and lifts a top-level `nodeId` off the object ones. A call
 * that names no node is answered by the HUB's provider — never by a merge
 * across nodes, because no global collection fans out across nodes (only the
 * providers of one node are `concatCollection`-fanned). So a fleet view of
 * `failedModels` is one `getInfo({ nodeId })` per node, and every answer
 * names the node it came from (D649 round 4); a node that cannot be asked is
 * UNKNOWN to the reader, never "no failures" (D315).
 */
export const embeddingEncoderCapability = {
  name: 'embedding-encoder',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /**
     * `internal: true` did not gate the mount (see the 2026-08-26 note on
     * `data-store-provider`) — every method below was reachable on the
     * AppRouter by ANY authenticated session at the default
     * `auth: 'protected'`. Consumers reach the encoder via `ctx.api` from
     * `addon-post-analysis`, never tRPC.
     */
    encode: method(
      z.object({ crop: z.instanceof(Uint8Array), width: z.number(), height: z.number() }),
      EmbeddingResultSchema,
      { auth: 'admin' },
    ),
    /**
     * `modelId` (a CLIP IMAGE model id, whose catalog `clip.textModelId` names
     * the text tower) encodes in that model's space; absent, the cluster row's
     * `clip-embedding` model — the space every writer is in (D649).
     */
    encodeText: method(
      z.object({ text: z.string(), modelId: z.string().min(1).optional() }),
      EmbeddingResultSchema,
      { auth: 'admin' },
    ),
    /** Answers for ONE node — the `nodeId` selector's, else the hub's. */
    getInfo: method(z.void(), EmbeddingInfoSchema, { auth: 'admin' }),
    /**
     * The operator's explicit clear of the `failed` state (one model, or all)
     * on ONE node — pass `nodeId` for an agent; the result names the node it
     * cleared. The only way out besides a model change: a crashing tower is
     * not retried on a timer.
     */
    resetFailedModels: method(
      z.object({ modelId: z.string().min(1).optional() }),
      z.object({ cleared: z.array(z.string()), nodeId: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IEmbeddingEncoderProvider = InferProvider<typeof embeddingEncoderCapability>

export { EmbeddingResultSchema, EmbeddingInfoSchema }
