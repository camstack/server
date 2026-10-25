/**
 * embedding-actions — operator buttons for the CLIP semantic-search index.
 *
 * These ride the generic `addons.custom` bridge rather than adding cap methods,
 * because the settings form already knows how to render an
 * `addon-action-button` and call it. The three operations they expose are the
 * ones an operator needs when the index and the world disagree:
 *
 *  - **Rebuild** re-embeds tracks from their key frames. It is the only way to
 *    change what a vector MEANS — crop margin, squaring, encoder model — since
 *    mixing feature spaces in one index makes cosine scores incomparable.
 *  - **Status** is what makes rebuild usable at all: a pass is ~1s per track,
 *    45 minutes for a fleet, so it runs detached and this is how progress is
 *    seen.
 *  - **Wipe** empties the index, for the clean slate before a policy change.
 *
 * Wipe is `danger` and carries a confirm prompt. It has already destroyed a
 * live index once when it was called casually — the button must not make that
 * easier than it needs to be.
 */

import {
  customAction,
  defineCustomActions,
  RebuildObjectEmbeddingsRefusalSchema,
} from '@camstack/types'
import { z } from 'zod'

const RebuildInputSchema = z.object({
  /** Restrict to one camera; omit for the whole fleet. */
  deviceId: z.number().optional(),
  // The crop margin and squaring used to be arguments HERE, which meant the
  // operator chose a convention per button press while the live path used a
  // different one permanently. They are now one cluster-wide setting
  // (Pipeline → Enrichment crop) applied by the runner to both paths.
  /** Stop after this many tracks; the status reports whether more remain. */
  maxTracks: z.number().int().positive().optional(),
  /**
   * Run every embedding on ONE named node instead of rotating the fleet.
   *
   * Not called `nodeId`: an inline `nodeId` in cap args is read as a routing
   * pin, and this value is data — the rebuild itself stays on the hub, only the
   * per-track step travels.
   */
  executeOnNodeId: z.string().optional(),
  /**
   * Milliseconds between tracks; omit for the default, `0` to run flat out.
   * A rebuild shares hub-main's only thread with every live request.
   */
  pacingMs: z.number().int().nonnegative().optional(),
  /**
   * Re-embed ONLY tracks already in the pinned space — to redo vectors cut
   * from the wrong box (D664). Requires `maxTracks`.
   */
  force: z.boolean().optional(),
})

const RebuildStartedSchema = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean(),
  /**
   * Why it did not start, by name — ONE vocabulary for both gates: the owner's
   * confirmation of the cluster model (D651) and the model's CLIP contract
   * (D649). See the cap's `RebuildObjectEmbeddingsRefusalSchema`.
   */
  refusal: RebuildObjectEmbeddingsRefusalSchema.optional(),
  /** The pinned CLIP model and the index the pass fills. */
  modelId: z.string().optional(),
  index: z.string().optional(),
})

const RebuildStatusSchema = z.object({
  running: z.boolean(),
  scanned: z.number(),
  rebuilt: z.number(),
  missingKeyFrame: z.number(),
  /** No object event at all — its own number since D664. */
  missingEvent: z.number(),
  missingBbox: z.number(),
  /** Which rule placed each judged track's box (D664). */
  boxSource: z.object({
    subjectBox: z.number(),
    positions: z.number(),
    event: z.number(),
    refused: z.number(),
  }),
  alreadyInSpace: z.number(),
  /** Whether the current / last pass was a `force` pass (D664). */
  force: z.boolean().nullable(),
  forcedInSpace: z.number(),
  /** Refused by the executing node (unreadable key frame / bad box), not broken. */
  notRunnable: z.number(),
  /** The pass STOPPED: no node in the cluster could serve the pinned model. */
  noCapableNode: z.number(),
  failed: z.number(),
  complete: z.boolean().nullable(),
  startedAtMs: z.number().nullable(),
  finishedAtMs: z.number().nullable(),
  error: z.string().nullable(),
  /** The pinned model of the current / last pass and the index it fills (D649). */
  modelId: z.string().nullable(),
  index: z.string().nullable(),
  /** Rows in THAT index — the number the operator is watching. `null` = unreadable. */
  indexed: z.number().nullable(),
  /** Every CLIP index's row count; `null` = unreadable (logged), never 0 (D393). */
  indexedByIndex: z.record(z.string(), z.number().nullable()),
})

const WipeResultSchema = z.object({
  deleted: z.number(),
  /** CLIP indexes that could NOT be emptied (D649) — additive. */
  failedIndexes: z.array(z.string()).optional(),
})

/**
 * An input-less action still takes an OBJECT, never `z.void()`.
 *
 * The `addons.custom` envelope requires an `input` field — omitting it fails
 * envelope validation before the action is even looked up — and the settings
 * form's button always sends one. So `z.void()` makes an action that resolves
 * and can never be called: the bridge insists on `{}` and the schema rejects
 * it. Verified on the live hub, both directions.
 */
const NoInputSchema = z.object({})

const ReembedFacesInputSchema = z.object({
  /** Stop after this many re-embeds; the result reports what remains. */
  maxSamples: z.number().int().positive().optional(),
  /** Run every embed on ONE named node instead of rotating the fleet. Data, not a pin. */
  executeOnNodeId: z.string().optional(),
})

/**
 * D658: re-embed each sample's stored template with ONE pinned model and
 * compare with the stored vector — does the stamp say what produced it?
 * Read-only: it reports and writes nothing.
 */
const AuditFaceEmbeddingsInputSchema = z.object({
  /** The stamp to verify. Omit for `auraface-r100` (the D651 default). */
  modelId: z.string().min(1).optional(),
  /** Only this identity's samples. */
  identityId: z.string().min(1).optional(),
  /** Stop after this many measured samples. */
  maxSamples: z.number().int().positive().optional(),
  /** Run every embed on ONE named node instead of rotating the fleet. Data, not a pin. */
  executeOnNodeId: z.string().optional(),
})

const AuditFaceEmbeddingsResultSchema = z.object({
  auditedModelId: z.string(),
  total: z.number(),
  ok: z.number(),
  mismatch: z.number(),
  inconclusive: z.number(),
  unmeasurable: z.number(),
  complete: z.boolean(),
  okMinCosine: z.number(),
  mismatchMaxCosine: z.number(),
  rows: z.array(
    z.object({
      sampleId: z.string(),
      identityId: z.string(),
      identityName: z.string(),
      stampedModelId: z.string(),
      verdict: z.enum(['ok', 'mismatch', 'inconclusive', 'unmeasurable']),
      cosine: z.number().optional(),
      reason: z
        .enum([
          'stamped-other-model',
          'no-pixels',
          'no-stored-vector',
          'embed-failed',
          'no-capable-node',
          'dimension-differs',
        ])
        .optional(),
      detail: z.string().optional(),
    }),
  ),
})

/** The most samples one forced re-embed call takes (a gallery is tens of rows). */
const MAX_FORCED_REEMBED_SAMPLES = 200

/**
 * D658: re-embed EXACTLY these samples with ONE pinned model, replacing their
 * vectors even when already stamped with it — the repair for what
 * `faceGallery.auditEmbeddings` accuses. See `face-sample-reembed.ts`.
 */
const ReembedSamplesInputSchema = z.object({
  sampleIds: z.array(z.string().min(1)).min(1).max(MAX_FORCED_REEMBED_SAMPLES),
  modelId: z.string().min(1),
  /** Run every embed on ONE named node instead of rotating the fleet. Data, not a pin. */
  executeOnNodeId: z.string().optional(),
})

const ReembedSamplesResultSchema = z.object({
  pinnedModelId: z.string(),
  requested: z.number(),
  reembedded: z.number(),
  failed: z.number(),
  rows: z.array(
    z.object({
      sampleId: z.string(),
      outcome: z.enum([
        'reembedded',
        'not-found',
        'duplicate',
        'no-pixels',
        'embed-failed',
        'no-capable-node',
        'no-model-stamp',
        'not-landed',
      ]),
      previousModelId: z.string().optional(),
      modelId: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
})

/** Mirrors `FaceReembedResult` (`face-reembed-pass.ts`) minus the sample-id set. */
const ReembedFacesResultSchema = z.object({
  targetModelId: z.string(),
  total: z.number(),
  alreadyInSpace: z.number(),
  reembedded: z.number(),
  noPixels: z.number(),
  failed: z.number(),
  noCapableNode: z.number(),
  remaining: z.number(),
  complete: z.boolean(),
  refused: z.string().optional(),
})

/** Mirrors `FaceReembedProgress` — "how much of the gallery is in the current space". */
const ReembedFacesStatusSchema = z.object({
  running: z.boolean(),
  modelId: z.string(),
  inSpace: z.number(),
  total: z.number(),
  /** Samples KNOWN pixel-less (probed by a pass) — never a guess from mediaKey. */
  unrecoverable: z.number(),
  byIdentity: z.array(
    z.object({
      identityId: z.string(),
      name: z.string(),
      inSpace: z.number(),
      total: z.number(),
      unrecoverable: z.number(),
    }),
  ),
  /**
   * Set when the owner could not say which model the cluster runs (D651):
   * `modelId` is then empty and `inSpace` counts nothing.
   */
  modelUnreadable: z.string().optional(),
  /** True when no model was ever stored and the cluster runs the default. */
  modelByAbsence: z.boolean().optional(),
})

const ReenrolPhotosInputSchema = z.object({
  /** Stop after this many re-enrols; the result reports what remains. A budgeted run does NOT arm the automatic pass. */
  maxSamples: z.number().int().positive().optional(),
  /** Analyse and choose, report each pick with its IoU/cosine, write NOTHING. Never arms. */
  dryRun: z.boolean().optional(),
})

const PhotoReenrolRefusalSchema = z.enum([
  'no-source',
  'no-old-vector',
  'no-enrollable-face',
  'model-mismatch',
  'no-iou-match',
  'ambiguous',
  'below-floor',
  'promiscuous',
])

const PhotoReenrolOutcomeSchema = z.object({
  sampleId: z.string(),
  identityId: z.string(),
  identityName: z.string(),
  outcome: z.enum([
    'reenrolled',
    'would-reenrol',
    'refused',
    'failed',
    'old-kept',
    'old-removal-retried',
    'old-removal-pending',
    'not-reached',
  ]),
  reason: PhotoReenrolRefusalSchema.optional(),
  step: z.string().optional(),
  pick: z
    .object({
      by: z.enum(['iou', 'cosine']),
      cosine: z.number(),
      iou: z.number().nullable(),
      faceIndex: z.number(),
    })
    .optional(),
  newSampleId: z.string().optional(),
})

/** Mirrors `PhotoReenrolResult` (`face-photo-reenrol-pass.ts`). */
const ReenrolPhotosResultSchema = z.object({
  dryRun: z.boolean(),
  total: z.number(),
  wouldReenrol: z.number(),
  alreadyV2: z.number(),
  reenrolled: z.number(),
  oldRemovalRetried: z.number(),
  refused: z.number(),
  failed: z.number(),
  oldKept: z.number(),
  remaining: z.number(),
  complete: z.boolean(),
  refusals: z.array(
    z.object({
      sampleId: z.string(),
      identityId: z.string(),
      reason: PhotoReenrolRefusalSchema,
    }),
  ),
  outcomes: z.array(PhotoReenrolOutcomeSchema),
})

/** Mirrors `FaceAlignmentStatus` (`face-alignment-jobs.ts`) — v1 vs v2, per identity (D643). */
const FaceAlignmentStatusSchema = z.object({
  photoPassRunning: z.boolean(),
  /** The automatic pass runs only after a real, unbudgeted admin run completed (D643). */
  autoArmed: z.boolean(),
  autoConverged: z.boolean(),
  lastPhotoPass: ReenrolPhotosResultSchema.extend({ finishedAtMs: z.number() }).nullable(),
  lastPrune: z.object({ finishedAtMs: z.number(), removed: z.number() }).nullable(),
  byIdentity: z.array(
    z.object({
      identityId: z.string(),
      name: z.string(),
      photoV1: z.number(),
      photoV2: z.number(),
      detectedV1: z.number(),
      detectedV2: z.number(),
    }),
  ),
})

const BackfillPhotoSourcesInputSchema = z.object({
  /** Evaluate every check, write nothing. */
  dryRun: z.boolean().optional(),
})

/** Mirrors `PhotoSourceBackfillResult` (`photo-source-backfill.ts`). */
const BackfillPhotoSourcesResultSchema = z.object({
  dryRun: z.boolean(),
  backfilled: z.number(),
  wouldBackfill: z.number(),
  refused: z.number(),
  failed: z.number(),
  alreadySet: z.number(),
  samples: z.array(
    z.object({
      sampleId: z.string(),
      identityId: z.string(),
      candidate: z.number().nullable(),
      checks: z
        .object({
          exists: z.boolean(),
          owner: z.boolean(),
          dims: z.boolean(),
          unreferenced: z.boolean(),
        })
        .nullable(),
      outcome: z.enum(['backfilled', 'would-backfill', 'refused', 'failed', 'already-set']),
    }),
  ),
})

const ResetToCoreInputSchema = z.object({
  /** Choose, analyse and report; write NOTHING. */
  dryRun: z.boolean().optional(),
  /** Samples kept per identity (default 3). */
  keepPerIdentity: z.number().int().positive().max(50).optional(),
  /**
   * Re-align v1 DETECTED picks from their stored template. Off by default:
   * measured at cosine 0.83 against the true new alignment (D644), under the
   * operator's 0.85 bar — so without it they are kept as they are.
   */
  realignDetected: z.boolean().optional(),
})

const ResetKeptSchema = z.object({
  sampleId: z.string(),
  reason: z.enum(['photo-v2', 'detected-v2', 'photo-v1', 'realigned', 'kept-as-is']),
  tier: z.enum(['photo-v2', 'detected-v2', 'photo-v1', 'detected-v1']),
  centroidCosine: z.number().nullable(),
  replacesSampleId: z.string().optional(),
  realign: z.object({ cosineToOld: z.number(), score: z.number() }).optional(),
  keptAsIsBecause: z.string().optional(),
})

/** Mirrors `GalleryResetResult` (`face-gallery-reset.ts`). */
const ResetToCoreResultSchema = z.object({
  dryRun: z.boolean(),
  keepPerIdentity: z.number(),
  realignDetected: z.boolean(),
  identities: z.array(
    z.object({
      identityId: z.string(),
      name: z.string(),
      before: z.number(),
      kept: z.array(ResetKeptSchema),
      removed: z.number(),
      wouldRemove: z.number(),
      failedRemovals: z.number(),
      skipped: z.string().optional(),
    }),
  ),
  pendingFaces: z.object({ found: z.number(), deleted: z.number() }),
  totals: z.object({
    before: z.number(),
    kept: z.number(),
    removed: z.number(),
    wouldRemove: z.number(),
    failedRemovals: z.number(),
  }),
})

/** Mirrors `FaceSourceDeviceStats` (`face-source-stats.ts`). */
const SourceFrameStatsSchema = z.object({
  devices: z.array(
    z.object({
      deviceId: z.number(),
      parks: z.number(),
      tracksParked: z.number(),
      parksPerTrackMean: z.number(),
      parksPerTrackMax: z.number(),
      keyFrameReuses: z.number(),
      parkMsP50: z.number().nullable(),
      parkMsP95: z.number().nullable(),
      parkMsMax: z.number().nullable(),
      parkFailures: z.number(),
      storedParked: z.number(),
      storedTrackKeyFrame: z.number(),
      storedBytes: z.number(),
      dropped: z.record(z.string(), z.number()),
    }),
  ),
})

/** The wipe's refusals, by name. */
export const WIPE_INCOMPLETE = 'wipe-incomplete'
export const WIPE_STORE_UNAVAILABLE = 'wipe-store-unavailable'

/**
 * The operator's "Empty the index" must not report success when a CLIP index
 * kept its vectors: `failedIndexes` non-empty is an ERROR naming them (the
 * button's success message cannot show a list, and "Removed N vectors" over a
 * partial wipe reads as a clean slate).
 */
export function requireCompleteWipe(result: {
  readonly deleted: number
  readonly failedIndexes: readonly string[]
}): { deleted: number; failedIndexes: string[] } {
  if (result.failedIndexes.length > 0) {
    throw new Error(
      `${WIPE_INCOMPLETE}: ${result.failedIndexes.join(', ')} NOT emptied ` +
        `(${String(result.deleted)} vectors removed from the others) — retry once the vector store is reachable`,
    )
  }
  return { deleted: result.deleted, failedIndexes: [] }
}

export const embeddingActions = defineCustomActions({
  'embedding.rebuild': customAction(RebuildInputSchema, RebuildStartedSchema, { auth: 'admin' }),
  'embedding.rebuildStatus': customAction(NoInputSchema, RebuildStatusSchema),
  'embedding.wipe': customAction(NoInputSchema, WipeResultSchema, { auth: 'admin' }),
  'embedding.reembedFaces': customAction(ReembedFacesInputSchema, ReembedFacesResultSchema, {
    auth: 'admin',
  }),
  'embedding.reembedFacesStatus': customAction(NoInputSchema, ReembedFacesStatusSchema),
  // D643: re-enrol PHOTO samples through the fixed SCRFD alignment, from their originals.
  'embedding.reenrolPhotos': customAction(ReenrolPhotosInputSchema, ReenrolPhotosResultSchema, {
    auth: 'admin',
  }),
  'embedding.faceAlignmentStatus': customAction(NoInputSchema, FaceAlignmentStatusSchema),
  // Set `sourceMediaId` = mediaId + 1 on photo samples that lack it, only where
  // four checks verify it. Never arms or starts the photo pass.
  'embedding.backfillPhotoSources': customAction(
    BackfillPhotoSourcesInputSchema,
    BackfillPhotoSourcesResultSchema,
    { auth: 'admin' },
  ),
  // D644: keep the best N samples per identity, discard the rest and every
  // pending face. Refuses while another gallery job runs.
  // D644: what keeping face source frames costs, per camera, since boot.
  'faceGallery.sourceFrameStats': customAction(NoInputSchema, SourceFrameStatsSchema),
  // D658: re-embed EXACTLY these samples, forced, one pinned model. Writes.
  'faceGallery.reembedSamples': customAction(
    ReembedSamplesInputSchema,
    ReembedSamplesResultSchema,
    {
      kind: 'mutation',
      auth: 'admin',
    },
  ),
  // D658: does each sample's stored vector come from the model it is stamped
  // with? A query — reads, runs inference, WRITES NOTHING.
  'faceGallery.auditEmbeddings': customAction(
    AuditFaceEmbeddingsInputSchema,
    AuditFaceEmbeddingsResultSchema,
    { auth: 'admin' },
  ),
  'faceGallery.resetToCore': customAction(ResetToCoreInputSchema, ResetToCoreResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
})

export type EmbeddingActions = typeof embeddingActions
export type EmbeddingRebuildInput = z.infer<typeof RebuildInputSchema>
export type EmbeddingRebuildStarted = z.infer<typeof RebuildStartedSchema>
export type EmbeddingRebuildStatus = z.infer<typeof RebuildStatusSchema>
export type ReembedFacesInput = z.infer<typeof ReembedFacesInputSchema>
export type ReembedFacesResult = z.infer<typeof ReembedFacesResultSchema>
export type ReembedFacesStatus = z.infer<typeof ReembedFacesStatusSchema>
export type ReenrolPhotosInput = z.infer<typeof ReenrolPhotosInputSchema>
export type ReenrolPhotosResult = z.infer<typeof ReenrolPhotosResultSchema>
export type FaceAlignmentStatusWire = z.infer<typeof FaceAlignmentStatusSchema>
export type BackfillPhotoSourcesInput = z.infer<typeof BackfillPhotoSourcesInputSchema>
export type BackfillPhotoSourcesResult = z.infer<typeof BackfillPhotoSourcesResultSchema>
export type ResetToCoreInput = z.infer<typeof ResetToCoreInputSchema>
export type ResetToCoreResult = z.infer<typeof ResetToCoreResultSchema>
export type SourceFrameStatsResult = z.infer<typeof SourceFrameStatsSchema>
export type ReembedSamplesInput = z.infer<typeof ReembedSamplesInputSchema>
export type ReembedSamplesResult = z.infer<typeof ReembedSamplesResultSchema>
export type AuditFaceEmbeddingsInput = z.infer<typeof AuditFaceEmbeddingsInputSchema>
export type AuditFaceEmbeddingsResult = z.infer<typeof AuditFaceEmbeddingsResultSchema>
