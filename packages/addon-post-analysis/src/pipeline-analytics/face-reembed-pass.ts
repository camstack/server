/**
 * Re-embed the enrolled face gallery into the cluster's CURRENT model space.
 *
 * ## Why this had to exist before AuraFace could ship
 *
 * Every enrolled sample carries the model that produced it, and `face-matcher`
 * only ever compares like with like. That protects the gallery from a mixed
 * feature space — it does NOT make a model change survivable. On the day the
 * cluster model changes, every sample stamped with the previous model becomes
 * dead weight: still there, still readable, matchable by nothing. On
 * 2026-08-20 that would have left Carol — 64 recognitions that day — with zero
 * usable samples and the operator reading it as a threshold problem.
 *
 * So the model choice is only half the mechanism. This is the other half: the
 * workflow a scope change requires.
 *
 * ## The trap that makes the obvious implementation wrong
 *
 * `identity_samples.mediaId` is NOT a source frame. It is the **112×112
 * aligned crop** the embedder was actually fed (`face-recognizer.ts` re-owns
 * `faceAlignedCrop` as the sample's media). Re-running detection + alignment
 * over it is the obvious "just run the pipeline again", and it is silently
 * wrong: SCRFD upscales the template to 640, finds a face ~90-110 px (well over
 * the 24 px landmark floor), and the aligner applies a SECOND warp to pixels
 * that are already a template. Every gate passes. The vector is plausible and
 * useless.
 *
 * So this pass runs `face-embedding` ALONE over the template, sent as the whole
 * frame with {@link FULL_IMAGE_BBOX}. That is not a shortcut around the crop
 * convention — it goes THROUGH it, and comes out unchanged, because padding a
 * full-frame box can only leave the frame and both edge modes bring it back
 * (see the constant's docblock; the identity is asserted against the real
 * derivation in `face-reembed-pass.spec.ts`).
 *
 * ## What it is bounded by
 *
 * Everything, deliberately. A pass takes a budget and reports what is LEFT, so
 * it is resumable and can never become an unbounded background walk; a sample
 * whose blob is gone is skipped and counted rather than retried forever; a
 * store that did not land is a failure even though `embed` returned (D58 — a
 * live CLIP pass once reported 704 rebuilt against an index holding 0); and
 * "no node can serve this model" ends the PASS on the first sample rather than
 * being rediscovered once per sample after a media read (D54, and the 43-minute
 * hub-main saturation of 2026-08-06).
 *
 * ## Where it hangs
 *
 * This module is pure and deps-injected on purpose — it lives beside
 * `pipeline-analytics` but touches none of its state. The wiring point is
 * `PipelineAnalyticsAddon`, which supplies:
 *   - `listSamples` ← `IdentityStore` rows (+ identity names),
 *   - `loadAlignedCrop` ← the media store, by the sample's `mediaId`,
 *   - `embed` ← `pipelineRunner.runStatelessStep`, node-pinned, ONE model for
 *     the whole pass (`rebuild-step-dispatch.ts` is the same shape),
 *   - `store` ← `IdentityStore` sample update, reporting whether it landed.
 */
import { FULL_IMAGE_BBOX } from '@camstack/types'

/** One enrolled sample, as the pass needs to see it. */
export interface FaceReembedSample {
  readonly sampleId: string
  readonly identityId: string
  /** For the log line and the operator-facing per-identity progress. */
  readonly identityName: string
  /** The model that produced the STORED vector. */
  readonly modelId: string
  readonly dim: number
  /**
   * Where the aligned 112×112 template lives. Absent means the sample was
   * enrolled before the crop was retained, or its blob is gone — 28 of 32 on
   * 2026-08-20. Either way there is nothing to re-embed from.
   */
  readonly mediaId?: number
}

/** What one embed attempt answers. A union, so three outcomes need three counters. */
export type FaceReembedOutcome =
  | {
      readonly kind: 'embedded'
      readonly embedding: readonly number[]
      readonly dim: number
      /**
       * The model the node reported it RAN (`RunStatelessStepResult.modelId`,
       * D658). The forced sample re-embed stamps from this and refuses without
       * it; the gallery pass pins by construction.
       */
      readonly modelId?: string
    }
  | { readonly kind: 'failed'; readonly reason: string }
  /** Terminal for the PASS: nowhere in the cluster can serve the pinned model. */
  | { readonly kind: 'no-capable-node'; readonly reason: string }

/** Did the row actually land? `embed` returning is not the same question. */
export interface FaceReembedWriteOutcome {
  readonly landed: boolean
  readonly reason?: string
}

export interface FaceReembedDeps {
  /** Every enrolled sample, newest-first or not — the pass does not care about order. */
  listSamples(): Promise<readonly FaceReembedSample[]>
  /**
   * The stored ALIGNED template's JPEG bytes; `null` when the blob is gone.
   *
   * Must never throw: a gallery with a missing blob is the ordinary case right
   * now, not an exceptional one.
   */
  loadAlignedCrop(sample: FaceReembedSample): Promise<Buffer | null>
  /** Run `face-embedding` over the template with the pass's pinned model. */
  embed(sample: FaceReembedSample, alignedCropJpeg: Buffer): Promise<FaceReembedOutcome>
  /** Persist the new vector + its model stamp, reporting whether the row landed. */
  store(
    sample: FaceReembedSample,
    embedding: readonly number[],
    modelId: string,
    dim: number,
  ): Promise<FaceReembedWriteOutcome>
  /** Yield the thread between samples — injected so pacing is testable without real time. */
  pause(ms: number): Promise<void>
  readonly logger: {
    info: (message: string, extras?: { meta?: Record<string, unknown> }) => void
    warn: (
      message: string,
      extras?: { tags?: { deviceId?: number }; meta?: Record<string, unknown> },
    ) => void
  }
}

export interface FaceReembedOptions {
  /** The cluster's chosen `face-embedding` model. Pinned for the WHOLE pass. */
  readonly targetModelId: string
  /** Stop after this many re-embeds; the outcome reports what remains. */
  readonly maxSamples?: number
  /** Milliseconds between samples. Defaults to {@link DEFAULT_FACE_REEMBED_PACING_MS}. */
  readonly pacingMs?: number
}

/**
 * A gallery is tens of rows, not thousands, so the pacing exists only to keep
 * the loop off hub-main's single thread — not to stretch the job out.
 */
const DEFAULT_FACE_REEMBED_PACING_MS = 25

export interface FaceReembedResult {
  readonly total: number
  /** Already stamped with the target model — nothing to do, and the proof the pass reads the right state. */
  readonly alreadyInSpace: number
  readonly reembedded: number
  /** Blob gone or never stored. Counted, never retried: the pixels do not come back. */
  readonly noPixels: number
  readonly failed: number
  /** Non-zero means the PASS stopped because no node could serve the model. */
  readonly noCapableNode: number
  /** Samples still outside the target space when the pass ended. */
  readonly remaining: number
  /** False when the budget ran out, or the cluster did. */
  readonly complete: boolean
  /** Set instead of running when the pass could not be pinned at all. */
  readonly refused?: string
  /**
   * The sample ids this pass PROBED and found pixel-less.
   *
   * Returned rather than only counted because the operator surface needs the
   * SET: it is the only honest input to `faceReembedProgress`'s
   * `unrecoverable`, which cannot be derived from a sample's `mediaId` — 27 of
   * 28 real rows carry a key whose blob is gone.
   */
  readonly pixellessSampleIds: readonly string[]
}

const EMPTY_RESULT: FaceReembedResult = {
  total: 0,
  alreadyInSpace: 0,
  reembedded: 0,
  noPixels: 0,
  failed: 0,
  noCapableNode: 0,
  remaining: 0,
  complete: false,
  pixellessSampleIds: [],
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Bring every enrolled sample that CAN be re-embedded into `targetModelId`'s
 * space, under a bound, resumably.
 *
 * Idempotent by construction: a sample already stamped with the target model is
 * skipped, so running the pass twice does nothing the second time and running
 * it with the CURRENT model is a declared no-op. That is not just an
 * optimisation — it is how the pass can be re-run after a partial one without
 * re-embedding what already landed.
 */
export async function reembedFaceGallery(
  deps: FaceReembedDeps,
  options: FaceReembedOptions,
): Promise<FaceReembedResult> {
  const targetModelId = options.targetModelId
  if (targetModelId === '') {
    // Refusing beats the alternative: a pass with no pin stamps rows with an id
    // nothing ran, and the matcher's same-model gate can then reason about
    // nothing. The old CLIP path's `?? 'unknown'` is the version of this bug
    // that shipped.
    deps.logger.warn(
      'face gallery re-embed: refusing to start without a target model — a pass that cannot pin one would stamp vectors nothing ran',
    )
    return { ...EMPTY_RESULT, refused: 'no target model' }
  }

  const pacingMs = options.pacingMs ?? DEFAULT_FACE_REEMBED_PACING_MS
  const budget = options.maxSamples ?? Number.POSITIVE_INFINITY
  const samples = await deps.listSamples()

  let alreadyInSpace = 0
  let reembedded = 0
  let noPixels = 0
  let failed = 0
  let noCapableNode = 0
  const pixelless: string[] = []
  let abandoned: string | null = null
  let budgetExhausted = false
  /** Samples the pass never reached, or reached and could not land. */
  const outstanding = new Set<string>()

  deps.logger.info('face gallery re-embed starting', {
    meta: { targetModelId, samples: samples.length, maxSamples: options.maxSamples ?? null },
  })

  for (const sample of samples) {
    if (sample.modelId === targetModelId) {
      alreadyInSpace += 1
      continue
    }
    if (abandoned !== null || reembedded >= budget) {
      if (reembedded >= budget) budgetExhausted = true
      outstanding.add(sample.sampleId)
      continue
    }

    const crop = await deps.loadAlignedCrop(sample).catch((err: unknown) => {
      // A media read that throws is indistinguishable from a missing blob for
      // this pass's purposes, but it must still be SAID: silence here reads
      // as "the sample never had pixels", which is a different diagnosis.
      deps.logger.warn('face gallery re-embed: aligned crop read failed', {
        meta: {
          sampleId: sample.sampleId,
          identity: sample.identityName,
          error: errorMessage(err),
        },
      })
      return null
    })

    if (crop === null) {
      // NOT a failure and NOT silent. This is the 28-of-32 case, and the number
      // an operator needs is "how much of my gallery is unrecoverable", which
      // only exists if this branch counts itself.
      noPixels += 1
      pixelless.push(sample.sampleId)
      outstanding.add(sample.sampleId)
      deps.logger.warn(
        'face gallery re-embed: SKIPPED, the aligned crop is gone — this sample can never be re-embedded',
        {
          meta: {
            sampleId: sample.sampleId,
            identity: sample.identityName,
            identityId: sample.identityId,
            mediaId: sample.mediaId ?? null,
            storedModelId: sample.modelId,
          },
        },
      )
      continue
    }

    let outcome: FaceReembedOutcome
    try {
      outcome = await deps.embed(sample, crop)
    } catch (err: unknown) {
      // One sample's pool death is not a verdict on the gallery.
      outcome = { kind: 'failed', reason: errorMessage(err) }
    }

    if (outcome.kind === 'no-capable-node') {
      // Terminal for the PASS. The answer cannot change mid-pass, and asking it
      // again per sample means one media read per sample buying nothing.
      noCapableNode += 1
      abandoned = outcome.reason
      outstanding.add(sample.sampleId)
      deps.logger.warn(
        'face gallery re-embed ABANDONED: no node can serve the cluster face model — stopping before reading any further media',
        { meta: { targetModelId, reason: outcome.reason, sampleId: sample.sampleId } },
      )
      continue
    }

    if (outcome.kind === 'failed') {
      failed += 1
      outstanding.add(sample.sampleId)
      deps.logger.warn('face gallery re-embed: sample failed', {
        meta: { sampleId: sample.sampleId, identity: sample.identityName, reason: outcome.reason },
      })
      await deps.pause(pacingMs)
      continue
    }

    // D58: the gate is "did it LAND", never "did the call return". A store that
    // logs its own failure and returns normally is exactly how a pass reports
    // hundreds rebuilt against an index holding none.
    const written = await deps
      .store(sample, outcome.embedding, targetModelId, outcome.dim)
      .catch((err: unknown) => ({ landed: false, reason: errorMessage(err) }))
    if (!written.landed) {
      failed += 1
      outstanding.add(sample.sampleId)
      deps.logger.warn('face gallery re-embed: the vector did not land', {
        meta: {
          sampleId: sample.sampleId,
          identity: sample.identityName,
          reason: written.reason ?? 'store reported no landing',
        },
      })
      await deps.pause(pacingMs)
      continue
    }

    reembedded += 1
    await deps.pause(pacingMs)
  }

  const result: FaceReembedResult = {
    total: samples.length,
    alreadyInSpace,
    reembedded,
    noPixels,
    failed,
    noCapableNode,
    remaining: outstanding.size,
    // "Complete" = the pass did everything it COULD, not "remaining is zero".
    // A sample with no pixels stays in `remaining` forever and must not keep
    // `complete` false: that would make a healthy pass look permanently stuck
    // and hide a real budget stop behind it. A FAILED sample is different — it
    // is retryable, so it does hold `complete` back.
    complete: abandoned === null && !budgetExhausted && failed === 0,
    pixellessSampleIds: pixelless,
  }
  if (budgetExhausted) {
    // Not a failure: the pass stopped where it was told to. It must still be
    // SAID, or a gallery that converges over several passes reads as stuck.
    deps.logger.info('face gallery re-embed: per-pass budget reached — the next pass resumes', {
      meta: {
        targetModelId,
        maxSamples: options.maxSamples ?? null,
        reembedded,
        remaining: result.remaining,
      },
    })
  }
  deps.logger.info('face gallery re-embed finished', { meta: { ...result, targetModelId } })
  return result
}

/** One identity's standing in the current model space. */
export interface FaceReembedIdentityProgress {
  readonly identityId: string
  readonly name: string
  readonly inSpace: number
  readonly total: number
  /** Samples KNOWN to have no pixels — they can never join the new space. */
  readonly unrecoverable: number
}

/** "How much of the gallery is in the current space" — the flip-safety number. */
export interface FaceReembedProgress {
  readonly modelId: string
  readonly inSpace: number
  readonly total: number
  /** Samples KNOWN unrecoverable. Never a guess — see `faceReembedProgress`. */
  readonly unrecoverable: number
  readonly byIdentity: readonly FaceReembedIdentityProgress[]
}

/**
 * Summarise the gallery against `modelId`, per identity.
 *
 * Per IDENTITY and not just in total, because the total is the number that
 * misleads: a gallery 80% re-embedded can still have one person at zero, and
 * `minIdentitySamples` means that person simply stops being recognised. On
 * 2026-08-20 that person would have been Carol, with 64 recognitions that day.
 * Pure — the operator surface reads it, the pass does not.
 *
 * ## Why `unrecoverable` is an INPUT and not derived here
 *
 * The obvious derivation — "a sample with no `mediaId` has no pixels" — is
 * wrong on this cluster, and the REAL ROWS are what proved it: of the 28
 * samples in the 2026-08-19 evidence copy, exactly ONE has a null `mediaId`
 * while 27 carry a well-formed key whose BLOB is gone (D196 §2, D197). The
 * derivation would have reported 1 unrecoverable against a true 27 — and
 * reported it confidently, on the screen an operator uses to decide whether a
 * model flip is safe. It was written that way here first, and only the fixture
 * built from those rows caught it.
 *
 * Only a probe knows, so only the PASS knows: `reembedFaceGallery` counts
 * `noPixels` by actually attempting each blob read and returns the ids. With no
 * observation supplied this reports zero, which means NOT MEASURED — the
 * caller must not render it as "all fine".
 */
export function faceReembedProgress(
  samples: readonly FaceReembedSample[],
  modelId: string,
  pixellessSampleIds: ReadonlySet<string> = new Set(),
): FaceReembedProgress {
  const byId = new Map<
    string,
    { name: string; inSpace: number; total: number; unrecoverable: number }
  >()
  for (const s of samples) {
    const entry = byId.get(s.identityId) ?? {
      name: s.identityName,
      inSpace: 0,
      total: 0,
      unrecoverable: 0,
    }
    entry.total += 1
    if (s.modelId === modelId) entry.inSpace += 1
    else if (s.mediaId === undefined || pixellessSampleIds.has(s.sampleId)) {
      entry.unrecoverable += 1
    }
    byId.set(s.identityId, entry)
  }
  const byIdentity = [...byId.entries()].map(([identityId, e]) => ({
    identityId,
    name: e.name,
    inSpace: e.inSpace,
    total: e.total,
    unrecoverable: e.unrecoverable,
  }))
  return {
    modelId,
    inSpace: byIdentity.reduce((n, e) => n + e.inSpace, 0),
    total: samples.length,
    unrecoverable: byIdentity.reduce((n, e) => n + e.unrecoverable, 0),
    byIdentity,
  }
}

/** Re-exported so the wiring site names the same constant the pass asserts on. */
export { FULL_IMAGE_BBOX }
