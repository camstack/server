/**
 * gallery-reconcile — a sample whose blob is gone from the filesystem is a
 * DELETED sample, and the row follows it.
 *
 * ## Why the policy flipped (operator decision, 2026-08-21)
 *
 * The boot relocate (`relocateExemptMediaToGallery`) used to leave a
 * pixel-less row standing on the theory that its embedding still matches.
 * That theory aged badly: with the gallery photo-first and the cluster model
 * flippable (D199), a pixel-less row is dead weight that STRANDS on the next
 * flip — it can never be re-embedded, it drags `unrecoverable` counts around
 * forever, and 28 of them sat for days claiming pixels they did not have.
 * The operator's rule is now the simple one: **not on the filesystem means
 * deleted** — remove the reference, keep the person.
 *
 * ## What bounds it (same shape as the orphan audit, same reasons)
 *
 * - **Grace window**: a sample younger than `graceMs` is never touched — the
 *   write-then-index race must not look like a wipe.
 * - **A probe that THROWS aborts the pass**, keeping everything: an
 *   unreachable volume must never read as "all blobs missing".
 * - **A reclaim ceiling per run**: a probe that lies (an unmounted root
 *   answering `false`) costs one ceiling, visibly, not the gallery.
 * - Removal goes through the SAME path the operator's delete uses (blob
 *   cleanup + row + cover heal) — no second delete implementation.
 * - **A MASS miss aborts the pass** (2026-09-08). On this hub the
 *   `galleryMedia` location was re-pointed at a new basePath and the blobs
 *   stayed at the old one: 304 files, untouched, under the previous path,
 *   while every row probed "missing". This pass — whose rule is "not on the
 *   filesystem means deleted" — was one boot away from removing 276
 *   references, a ceiling at a time, and the ceiling cannot tell that shape
 *   apart from real rot. It is not the samples that died, it is the volume
 *   that moved, and the only honest reading of "everything is missing at
 *   once" is a question about the location.
 */

/** The three answers a reference probe can give. Errors THROW, never map here. */
export type GalleryBlobState = 'exists' | 'missing-blob' | 'missing-row'

export interface GalleryReconcileSampleRow {
  readonly id: string
  /** The enrolled crop's media row id, absent when the sample never had one —
   *  never `0`, which would name a rowid that cannot exist (D482). */
  readonly mediaId?: number
  readonly addedAt: number
}

export interface GalleryReconcileDeps {
  listIdentities(): Promise<ReadonlyArray<{ readonly id: string; readonly name: string }>>
  listSamples(identityId: string): Promise<readonly GalleryReconcileSampleRow[]>
  /** Row + filesystem state of one media reference. MUST throw on probe error. */
  blobState(mediaId: number): Promise<GalleryBlobState>
  /** The provider-level removal: blobs, row, cover heal. */
  removeSample(identityId: string, sampleId: string): Promise<void>
  readonly logger: {
    info: (message: string, extras?: { meta?: Record<string, unknown> }) => void
    warn: (message: string, extras?: { meta?: Record<string, unknown> }) => void
  }
}

export interface GalleryReconcileOptions {
  readonly now: number
  /** Samples younger than this are never candidates. */
  readonly graceMs: number
  /** Hard cap on removals per run — an outage costs one ceiling, not the gallery. */
  readonly maxReclaimPerRun: number
  /** Below this many probes there is nothing to generalise from, so the
   *  mass-miss bar does not apply. A person who deleted their own two photos
   *  is not a moved volume. Defaults to {@link MASS_MISS_MIN_PROBES}. */
  readonly massMissMinProbes?: number
  /** Abort when at least this FRACTION of the probes so far came back missing.
   *  Defaults to {@link MASS_MISS_FRACTION}. */
  readonly massMissFraction?: number
}

/** See {@link GalleryReconcileOptions.massMissMinProbes}. */
const MASS_MISS_MIN_PROBES = 8
/** See {@link GalleryReconcileOptions.massMissFraction}. */
const MASS_MISS_FRACTION = 0.5

export const DEFAULT_GALLERY_RECONCILE_GRACE_MS = 10 * 60 * 1000
export const DEFAULT_GALLERY_RECLAIM_CEILING = 16

export interface GalleryReconcileReport {
  readonly checked: number
  /** References whose blob is gone — removed. */
  readonly reclaimed: number
  /** Rows with no mediaId at all: nothing to probe, left alone, counted. */
  readonly keyless: number
  readonly skippedGrace: number
  readonly stoppedByCeiling: boolean
  /** Set when a probe threw: the pass stopped and kept everything else. */
  readonly aborted?: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function reconcileGallerySamples(
  deps: GalleryReconcileDeps,
  options: GalleryReconcileOptions,
): Promise<GalleryReconcileReport> {
  let checked = 0
  let reclaimed = 0
  let keyless = 0
  let skippedGrace = 0
  let stoppedByCeiling = false
  let missed = 0
  /** Verdicts held until there are enough of them to tell rot from a move. */
  const held: Array<{ identityId: string; sampleId: string; mediaId: number }> = []

  const identities = await deps.listIdentities()
  for (const identity of identities) {
    const samples = await deps.listSamples(identity.id)
    for (const sample of samples) {
      if (sample.mediaId === undefined) {
        keyless += 1
        continue
      }
      if (options.now - sample.addedAt < options.graceMs) {
        skippedGrace += 1
        continue
      }
      if (reclaimed >= options.maxReclaimPerRun) {
        stoppedByCeiling = true
        deps.logger.warn(
          'gallery reconcile: reclaim ceiling reached — remaining dead references keep until the next run',
          { meta: { ceiling: options.maxReclaimPerRun } },
        )
        return { checked, reclaimed, keyless, skippedGrace, stoppedByCeiling }
      }

      let state: GalleryBlobState
      try {
        state = await deps.blobState(sample.mediaId)
      } catch (err: unknown) {
        const reason = errorMessage(err)
        deps.logger.warn(
          'gallery reconcile: a blob probe FAILED — aborting the pass, keeping every row',
          { meta: { sampleId: sample.id, identity: identity.name, error: reason } },
        )
        return { checked, reclaimed, keyless, skippedGrace, stoppedByCeiling, aborted: reason }
      }
      checked += 1
      if (state === 'exists') continue
      missed += 1

      // The bar is judged BEFORE anything is removed. Everything missing at
      // once is a statement about the VOLUME — on 2026-09-08 the gallery
      // location was re-pointed and 304 blobs sat untouched under the previous
      // path — and the per-run ceiling cannot tell that shape from real rot,
      // it only makes losing the gallery take more boots. So the first
      // `minProbes` verdicts are HELD: if they say the volume moved, the pass
      // ends having deleted nothing at all, which is the whole point.
      const minProbes = options.massMissMinProbes ?? MASS_MISS_MIN_PROBES
      const bar = options.massMissFraction ?? MASS_MISS_FRACTION
      if (checked < minProbes) {
        held.push({ identityId: identity.id, sampleId: sample.id, mediaId: sample.mediaId })
        continue
      }
      if (missed / checked >= bar) {
        const reason = `mass miss: ${String(missed)} of ${String(checked)} probes found no blob`
        deps.logger.warn(
          'gallery reconcile: nearly every blob is missing — that is the volume, not the samples. ' +
            'Aborting and keeping every row; check where the gallery location points.',
          { meta: { checked, missed, held: held.length, identity: identity.name } },
        )
        return { checked, reclaimed, keyless, skippedGrace, stoppedByCeiling, aborted: reason }
      }
      // Past the bar: the held verdicts were real stragglers after all.
      for (const pending of held.splice(0, held.length)) {
        await deps.removeSample(pending.identityId, pending.sampleId)
        reclaimed += 1
        deps.logger.warn(
          'gallery reconcile: sample blob is gone from the filesystem — reference removed',
          {
            meta: { sampleId: pending.sampleId, mediaId: pending.mediaId, state: 'missing-blob' },
          },
        )
      }

      await deps.removeSample(identity.id, sample.id)
      reclaimed += 1
      deps.logger.warn(
        'gallery reconcile: sample blob is gone from the filesystem — reference removed',
        {
          meta: {
            sampleId: sample.id,
            identity: identity.name,
            mediaId: sample.mediaId,
            state,
          },
        },
      )
    }
  }
  // A gallery too small to judge never reached the bar. Those verdicts stand
  // on their own: two samples both gone is a person who deleted their photos,
  // not a volume that moved, and refusing there would leave dead references
  // forever on every small install.
  for (const pending of held.splice(0, held.length)) {
    if (reclaimed >= options.maxReclaimPerRun) {
      stoppedByCeiling = true
      break
    }
    await deps.removeSample(pending.identityId, pending.sampleId)
    reclaimed += 1
  }
  if (reclaimed > 0) {
    deps.logger.info('gallery reconcile: dead references removed', {
      meta: { checked, reclaimed, keyless, skippedGrace },
    })
  }
  return { checked, reclaimed, keyless, skippedGrace, stoppedByCeiling }
}
