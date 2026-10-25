/**
 * Where a re-embed pass gets the model it pins.
 *
 * ## Why not `embeddingEncoder.getInfo`
 *
 * That is what the CLIP rebuild used, and it answers a subtly different
 * question: "which model is the encoder addon currently holding", not "which
 * model has the operator chosen for the cluster". The two agree until they do
 * not — an encoder mid-reload, a node that never picked up a change — and when
 * they disagree the pass writes a whole index in the wrong space with a status
 * line that looks fine. Since `face-embedding` and `clip-embedding` declare
 * `modelScope: 'cluster'`, there is now exactly one authority for each, and it
 * is a stored row rather than a live process's opinion.
 *
 * ## Why the read is not cached here
 *
 * A pass reads it ONCE, at the start, and pins that value for its whole run
 * (D54). A cache would only matter for a caller that re-read it mid-pass, which
 * is precisely the thing the pin exists to prevent — so there is nothing to
 * cache and the absence is deliberate.
 *
 * ## Why a failed read refuses instead of defaulting
 *
 * A pass that cannot name its model must not run. The previous CLIP path's
 * `?? 'unknown'` is the shipped version of the alternative: rows stamped with an
 * id nothing ran, in an index whose same-model gate then has nothing to reason
 * about.
 */
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  type ClusterModelChoiceUnreadableReason,
  ClusterModelChoiceSchema,
  type IScopedLogger,
  type ClusterStepModels,
  type HydratedClusterView,
  pickClusterStepModels,
} from '@camstack/types'

/** The addon whose GLOBAL settings hold the cluster row. */
export const CLUSTER_MODEL_OWNER_ADDON_ID = 'pipeline-orchestrator'

/** The step ids this module can pin — the same two the catalog declares. */
export const FACE_EMBEDDING_STEP_ID = 'face-embedding'
export const CLIP_EMBEDDING_STEP_ID = 'clip-embedding'

/** The hub-routed global-settings read, structurally typed so tests can fake it. */
export interface ClusterModelPinApi {
  readonly addonSettings: {
    readonly getGlobalSettings: {
      query(input: { addonId: string }): Promise<HydratedClusterView | null>
    }
  }
}

/**
 * The warn half of `IScopedLogger`. Narrowed rather than taken whole so a test
 * fake is one function, not five.
 */
export type ClusterModelPinLogger = Pick<IScopedLogger, 'warn'>

/**
 * The cluster row, or `null` when it could not be read.
 *
 * `null` and not "the defaults": a caller that cannot distinguish "the operator
 * chose arcface" from "I could not ask" will run a pass on a guess. The one
 * production caller turns `null` into a refusal to start.
 */
export async function readClusterModelRow(
  api: ClusterModelPinApi,
  logger: ClusterModelPinLogger,
): Promise<ClusterStepModels | null> {
  try {
    const view = await api.addonSettings.getGlobalSettings.query({
      addonId: CLUSTER_MODEL_OWNER_ADDON_ID,
    })
    // A `null` VIEW reads as the registry defaults. Acceptable ONLY for the
    // read-only surfaces that still call this (search gate, rescore, audit):
    // a pass that REWRITES an index must use `readClusterModelPinStrict`,
    // because a hydrated view cannot tell a default nobody chose from a choice
    // (D651). A read that THROWS is handled below and is not an answer at all.
    return pickClusterStepModels(view)
  } catch (err: unknown) {
    logger.warn(
      'cluster model row unreadable — a re-embed pass must not guess which encoder the operator chose',
      {
        meta: {
          owner: CLUSTER_MODEL_OWNER_ADDON_ID,
          error: err instanceof Error ? err.message : String(err),
        },
      },
    )
    return null
  }
}

/**
 * Pin one cluster-scoped step's model for a whole pass.
 *
 * Returns `null` on an unreadable row OR an unknown step id — both mean the
 * caller must not start, and folding them together is safe because the caller's
 * move is identical: refuse, loudly.
 */
export async function resolveClusterModelPin(
  api: ClusterModelPinApi,
  stepId: string,
  logger: ClusterModelPinLogger,
): Promise<string | null> {
  if (!CLUSTER_MODEL_SCOPED_STEPS.some((s) => s.stepId === stepId)) {
    logger.warn('cluster model pin requested for a step that is not cluster-scoped', {
      meta: { stepId, clusterScoped: CLUSTER_MODEL_SCOPED_STEPS.map((s) => s.stepId) },
    })
    return null
  }
  const row = await readClusterModelRow(api, logger)
  if (row === null) return null
  const modelId = row[stepId]
  return modelId !== undefined && modelId !== '' ? modelId : null
}

/** The owner's cap read, structurally typed so tests can fake it. */
export interface ClusterModelChoiceApi {
  readonly pipelineOrchestrator?: {
    readonly getClusterModelChoice?: {
      query(input: { stepId: string }): Promise<unknown>
    }
  }
}

/** Why a strict pin read gave no model. */
export type ClusterPinUnknownReason =
  /** The owner answered `unreadable`; its own reason (`owner-not-ready`, `invalid-stored`, …). */
  | ClusterModelChoiceUnreadableReason
  /**
   * The orchestrator this node reaches has no `getClusterModelChoice` — a
   * rolling release where post-analysis is newer than the owner. No pass runs.
   */
  | 'method-unavailable'
  /** The call failed for any other reason, or answered something unparseable. */
  | 'read-failed'

/** One strict read of a cluster pin. */
export type ClusterPinRead =
  /** The operator's written choice. */
  | { readonly kind: 'known'; readonly modelId: string }
  /** Nobody wrote the key: the cluster runs the default BY ABSENCE. */
  | { readonly kind: 'not-stored'; readonly defaultModelId: string }
  | { readonly kind: 'unknown'; readonly reason: ClusterPinUnknownReason; readonly error?: string }

/**
 * The error texts a cap call carries when the provider or the router has no
 * such method: the kernel's `Capability "…" has no method "…"`, tRPC's
 * `No procedure found on path`, and the forked-child hop's
 * `method '…' not found on provider '…'` (child-cap-dispatch.ts). NOT `is not a function`: that is any
 * `TypeError` thrown INSIDE the owner while it answers, and reading it as
 * "the owner predates the method" would file a bug in the owner under a
 * rolling-release reason nobody investigates.
 */
const METHOD_UNAVAILABLE_FINGERPRINTS: readonly RegExp[] = [
  /has no method/i,
  /no procedure found/i,
  /method not found/i,
  /method '[^']*' not found on provider/i,
]

/**
 * The pin read for a pass that REWRITES an index (D651 fix rounds 1–3).
 *
 * Asks the OWNER. The orchestrator owns `clusterModel:*` and answers from a
 * three-way read of its own store, once its boot has settled
 * (`pipelineOrchestrator.getClusterModelChoice`). Never the hydrated view,
 * which answers `value ?? default`, and never the owner's private store
 * layout. Silent on purpose: the callers log state CHANGES.
 */
export async function readClusterModelPinStrict(
  api: ClusterModelChoiceApi,
  stepId: string,
): Promise<ClusterPinRead> {
  const method = api.pipelineOrchestrator?.getClusterModelChoice
  if (method === undefined) return { kind: 'unknown', reason: 'method-unavailable' }
  let raw: unknown
  try {
    raw = await method.query({ stepId })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    return METHOD_UNAVAILABLE_FINGERPRINTS.some((re) => re.test(error))
      ? { kind: 'unknown', reason: 'method-unavailable', error }
      : { kind: 'unknown', reason: 'read-failed', error }
  }
  if (raw === undefined) return { kind: 'unknown', reason: 'method-unavailable' }
  const parsed = ClusterModelChoiceSchema.safeParse(raw)
  if (!parsed.success) {
    return { kind: 'unknown', reason: 'read-failed', error: 'unparseable owner answer' }
  }
  const choice = parsed.data
  if (choice.kind === 'stored') return { kind: 'known', modelId: choice.modelId }
  if (choice.kind === 'absent') return { kind: 'not-stored', defaultModelId: choice.defaultModelId }
  return choice.error !== undefined
    ? { kind: 'unknown', reason: choice.reason, error: choice.error }
    : { kind: 'unknown', reason: choice.reason }
}
