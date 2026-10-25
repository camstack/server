/**
 * face-rescore-actions — "score this face against the gallery AS IT IS NOW".
 *
 * ## Why an `addons.custom` action and not a `faceGallery` cap method
 *
 * Same reason `photo.*`, `embedding.*` and `debug.*` ride this bridge: a cap
 * method's wire schema lives in `@camstack/types`, which travels inside the
 * `@camstack/server` closure, so a new one is not callable until a server train
 * ships — however current the addon is. Here the schema lives in the addon's
 * own dist and the hub forwards an opaque envelope, so `camstack deploy` is the
 * whole delivery.
 *
 * ## Why re-embedding is an explicit flag and not a fallback
 *
 * `face.rescoreTrack` with `reembed: false` (the default) reads a persisted
 * vector and does arithmetic — microseconds, no GPU, no node hop. With
 * `reembed: true` it runs the `face-embedding` step on a cluster node. Those
 * are different enough in cost and in consequence (a re-embed WRITES the face
 * row) that a button labelled "recompute" must not choose between them on the
 * operator's behalf. The report says whether a re-embed is possible
 * (`reembedAvailable`); the operator asks for it.
 *
 * See `face-rescore.ts` for why the number already on the track is stale by
 * construction — that is the whole reason this action exists.
 */
import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import { FaceRescoreJobStatusSchema } from './face-rescore-job-status.js'

const FaceRescoreVerdictSchema = z.enum([
  'auto-assignable',
  'ambiguous',
  'suggestion',
  'below-threshold',
  'no-eligible-identity',
  'empty-gallery',
  'model-mismatch',
])

const FaceRescoreParamsSchema = z.object({
  threshold: z.number(),
  margin: z.number(),
  minIdentitySamples: z.number().int(),
  /** DERIVED from `threshold`, never stored (D222) — see `suggestionBandFactor`. */
  suggestionMinCosine: z.number(),
  /** The fraction of `threshold` that `suggestionMinCosine` is, so the report
   *  states the RULE and not only its current result. */
  suggestionBandFactor: z.number(),
})

const FaceRescoreIdentityRowSchema = z.object({
  identityId: z.string(),
  name: z.string(),
  /** Raw cosine. The UI formats; the wire stays in the matcher's units. */
  score: z.number(),
  sampleCount: z.number().int(),
  eligible: z.boolean(),
  meetsThreshold: z.boolean(),
  wouldAutoAssign: z.boolean(),
})

/**
 * Why a re-embed did not happen, in the addon's vocabulary.
 *
 * `not-a-template` is the one that matters and the one that is easy to get
 * wrong: a face's stored crop is the 112×112 ArcFace template ONLY when the
 * detection carried landmarks. When it does not, the crop is a padded bbox cut
 * — and feeding THAT to `face-embedding` as a whole frame produces a vector
 * that is plausible and useless, exactly the trap `face-reembed-pass.ts`
 * documents from the other direction. Refusing is the honest answer.
 */
const FaceReembedRefusalSchema = z.enum([
  'not-requested',
  'no-pixels',
  'not-a-template',
  'no-capable-node',
  'failed',
  'not-persisted',
])

const FaceReembedReportSchema = z.object({
  attempted: z.boolean(),
  /** True only when a NEW vector was embedded AND read back off the face row. */
  succeeded: z.boolean(),
  reason: FaceReembedRefusalSchema.optional(),
  detail: z.string().optional(),
  /** The model the re-embed pinned — the cluster row's, never a substitute. */
  modelId: z.string().optional(),
})

const FaceRescoreInputSchema = z.object({
  deviceId: z.number().int(),
  trackId: z.string().min(1),
  /**
   * Run `face-embedding` over the face's stored aligned template first, so a
   * face left in a superseded feature space becomes comparable again. Costs a
   * node round-trip and WRITES the face row. Never implicit.
   */
  reembed: z.boolean().default(false),
})

const FaceRescoreResultSchema = z.object({
  faceId: z.string(),
  deviceId: z.number().int(),
  trackId: z.string(),
  /** The face's current assignment, so the UI can mark "already this person". */
  assigned: z.boolean(),
  assignedIdentityId: z.string().optional(),
  /** What the track has been SHOWING until now — read BEFORE this call
   *  writes, so it is whatever a previous track close or a previous
   *  `face.rescoreTrack` last persisted. Returned so the UI can put the stale
   *  number beside the fresh one. */
  storedSuggestedIdentityId: z.string().optional(),
  storedSuggestedMatchScore: z.number().optional(),
  verdict: FaceRescoreVerdictSchema,
  comparable: z.boolean(),
  probeModelId: z.string(),
  clusterModelId: z.string(),
  params: FaceRescoreParamsSchema,
  identities: z.array(FaceRescoreIdentityRowSchema).readonly(),
  runnerUpGap: z.number().optional(),
  /** Whether a `reembed: true` retry could actually do anything. Lets the UI
   *  offer the escape hatch only when it exists. */
  reembedAvailable: z.boolean(),
  reembed: FaceReembedReportSchema,
})

export const faceRescoreActions = defineCustomActions({
  /**
   * Persists its own result onto the SUGGESTED tier (`suggestedIdentityId` /
   * `suggestedMatchScore`) — never an assignment, never automatic; see
   * `rescoreFaceForTrack` in `pipeline-analytics/index.ts` and
   * `persistRescoreResult` in `face-rescore.ts`. `admin` because the report
   * also names every enrolled person and how well an arbitrary face matches
   * them — the gallery's shape, which is not a viewer-level fact.
   */
  'face.rescoreTrack': customAction(FaceRescoreInputSchema, FaceRescoreResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  /**
   * Whole-archive rescore (D866): EVERY unassigned face against ONE gallery
   * snapshot, as a paced single-flight job. Returns at once with the running
   * job's status (a second call while one runs returns THAT job); poll
   * `face.rescoreStatus` for progress and the final report. Same persistence
   * rules as `face.rescoreTrack` — suggestions only, never an assignment, never
   * a `model-mismatch` write — and a weaker or vanished match LOWERS or CLEARS
   * the stored suggestion (see `face-rescore-job.ts`).
   */
  'face.rescoreAll': customAction(z.object({}), FaceRescoreJobStatusSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  /** Progress of the running whole-archive rescore, else the last report. */
  'face.rescoreStatus': customAction(z.object({}), FaceRescoreJobStatusSchema, {
    kind: 'query',
    auth: 'admin',
  }),
})

export type FaceRescoreActions = typeof faceRescoreActions
export type FaceRescoreActionInput = z.infer<typeof FaceRescoreInputSchema>
export type FaceRescoreActionResult = z.infer<typeof FaceRescoreResultSchema>
export type FaceReembedReport = z.infer<typeof FaceReembedReportSchema>
export type FaceReembedRefusal = z.infer<typeof FaceReembedRefusalSchema>
