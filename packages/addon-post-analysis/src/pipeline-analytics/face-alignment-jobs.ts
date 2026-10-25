/**
 * face-alignment-jobs — the addon side of D643: the photo re-enrol pass, the
 * old-alignment prune, and the status that reports both.
 *
 * The two pure halves (`face-photo-reenrol-pass.ts`, `face-gallery-prune.ts`)
 * say what they need; this module is that sentence wired to the stores, with
 * the state the addon has to keep between calls: one photo pass at a time,
 * prunes serialised, the last results for the status, the automatic trigger's
 * ARM, and the set of photo samples it must not keep re-attempting.
 *
 * ## The automatic pass is ARMED, not on by default
 *
 * Every real re-enrol deletes an old sample irreversibly, so the timer never
 * starts one on its own after a deploy. It is armed by the first ADMIN run that
 * is real (`dryRun` false) AND unbudgeted (no `maxSamples`) and completes — the
 * operator's own "go for all of them". A dry run or a `maxSamples` canary does
 * not arm it. The arm is in memory: a restart disarms, which is harmless
 * because every photo sample written since D643 is already v2 — once the
 * gallery has converged there is nothing for the timer to do, and a partial
 * conversion interrupted by a restart is finished by running the admin action
 * again. Once armed, the timer scans only until the gallery converges (every
 * photo sample v2, or every v1 one attempted) and then stops scanning.
 *
 * Kept out of `index.ts` on purpose: the addon supplies stores and one
 * analyze function, and nothing here reaches back into it.
 */
import type { IScopedLogger } from '@camstack/types'
import { isV2Aligned } from './face-alignment-version.js'
import { type PruneResult, pruneV1DetectedSamples } from './face-gallery-prune.js'
import {
  type GalleryResetOptions,
  type GalleryResetResult,
  type PendingFaceRef,
  type ResetSample,
  resetGalleryToCore,
} from './face-gallery-reset.js'
import {
  type PhotoReenrolDeps,
  type PhotoReenrolReplacement,
  type PhotoReenrolResult,
  type PhotoReenrolSample,
  reenrolPhotoSamples,
} from './face-photo-reenrol-pass.js'
import { PHOTO_ENROLL_DEVICE_ID, type PhotoFace } from './photo-enrollment.js'
import {
  backfillPhotoSources,
  type PhotoSourceBackfillOptions,
  type PhotoSourceBackfillResult,
} from './photo-source-backfill.js'
import { analyzeFaceSourceWindow } from './face-source-window.js'
import { letterboxFaceTemplate, realignVerdictFrom } from './face-template-realign.js'
import type { FaceStore } from './store/face-store.js'
import type { IdentityStore } from './store/identity-store.js'
import type { MediaStore } from './store/media-store.js'

/** The stores the jobs need; null until the addon has them (hub only). */
export interface FaceAlignmentStores {
  readonly identityStore: IdentityStore
  readonly mediaStore: MediaStore
  /** The faces buffer — the reset deletes its pending faces (D644). */
  readonly faceStore: FaceStore
}

export interface FaceAlignmentJobsDeps {
  stores(): FaceAlignmentStores | null
  /** The REAL photo analyze path: detect + align + embed on a cluster node. */
  analyzePhoto(photoJpeg: Buffer): Promise<readonly PhotoFace[]>
  /**
   * Remove a DETECTED sample the way the operator's Remove button does — row,
   * vector, template blob, and the buffered faces' references to it
   * (`FaceGalleryProvider.removeSample`). NEVER used for a photo sample: that
   * path also deletes `sourceMediaId`, which the replacement row owns.
   */
  removeDetectedSample(identityId: string, sampleId: string): Promise<void>
  refreshGallery(): Promise<void>
  /** The model re-embed pass restamps rows by id; the two must not interleave. */
  isReembedRunning(): boolean
  readonly logger: IScopedLogger
}

export interface PhotoReenrolRunInput {
  readonly maxSamples?: number
  readonly dryRun?: boolean
}

/** Per identity, where the gallery stands between the two alignments. */
export interface FaceAlignmentIdentityStatus {
  readonly identityId: string
  readonly name: string
  readonly photoV1: number
  readonly photoV2: number
  readonly detectedV1: number
  readonly detectedV2: number
}

/** The last photo pass, stamped with when it finished. */
export type FinishedPhotoPass = PhotoReenrolResult & { readonly finishedAtMs: number }

/** The last prune. */
export interface FinishedPrune {
  readonly finishedAtMs: number
  readonly removed: number
}

export interface FaceAlignmentStatus {
  readonly photoPassRunning: boolean
  /** The automatic pass runs only once an unbudgeted real admin run completed. */
  readonly autoArmed: boolean
  /** The automatic scan found nothing left to try and stopped. */
  readonly autoConverged: boolean
  readonly lastPhotoPass: FinishedPhotoPass | null
  readonly lastPrune: FinishedPrune | null
  readonly byIdentity: readonly FaceAlignmentIdentityStatus[]
}

/**
 * Should the automatic trigger start a photo pass now? Pure.
 *
 * Only for a v1 photo sample no real run has already attempted: a refusal does
 * not change by asking again, and a failure (no node, say) must not turn into a
 * full-photo detect+embed every minute. The admin action always runs.
 */
export function shouldAutoReenrolPhotos(
  samples: readonly PhotoReenrolSample[],
  attempted: ReadonlySet<string>,
  busy: boolean,
): boolean {
  if (busy) return false
  return samples.some((s) => !isV2Aligned(s) && !attempted.has(s.sampleId))
}

/** Does this admin run arm the automatic pass? Pure. */
export function armsAutoPass(input: PhotoReenrolRunInput): boolean {
  return input.dryRun !== true && input.maxSamples === undefined
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What happened to the pending faces of one camera. */
interface PendingDeleteTally {
  deleted: number
  skipped: number
  failed: number
}

export class FaceAlignmentJobs {
  private photoPassRunning = false
  private resetRunning = false
  private backfillRunning = false
  private pruneRunning = false
  private autoArmed = false
  private autoConverged = false
  private lastPhotoPass: FinishedPhotoPass | null = null
  private lastPrune: FinishedPrune | null = null
  /** v1 photo samples a REAL run already looked at and could not finish. */
  private readonly attempted = new Set<string>()
  /** Prunes run one after another: two concurrent ones would remove a row twice. */
  private pruneChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: FaceAlignmentJobsDeps) {}

  get isPhotoPassRunning(): boolean {
    return this.photoPassRunning
  }

  /** The gallery reset (D644) is rewriting the gallery. */
  get isResetRunning(): boolean {
    return this.resetRunning
  }

  /** The admin action. Refuses rather than queues when it cannot run now. */
  async runPhotoPass(input: PhotoReenrolRunInput): Promise<PhotoReenrolResult> {
    const result = await this.runPass(input)
    if (armsAutoPass(input) && !this.autoArmed) {
      this.autoArmed = true
      this.deps.logger.info('face photo re-enrol: automatic pass ARMED by a full admin run', {
        meta: { remaining: result.remaining },
      })
    }
    return result
  }

  /**
   * One pass. The running flag is set before the first await, in the same
   * synchronous step as the checks, so a re-embed pass that checks
   * `isPhotoPassRunning` cannot slip in between (and vice versa).
   */
  private async runPass(input: PhotoReenrolRunInput): Promise<PhotoReenrolResult> {
    const stores = this.deps.stores()
    if (stores === null) {
      throw new Error('embedding.reenrolPhotos: the gallery stores are not ready')
    }
    if (this.photoPassRunning) {
      throw new Error('embedding.reenrolPhotos: a photo re-enrol pass is already running')
    }
    if (this.resetRunning) {
      throw new Error('embedding.reenrolPhotos: a face gallery reset is running')
    }
    if (this.deps.isReembedRunning()) {
      throw new Error(
        'embedding.reenrolPhotos: a face re-embed pass is running — the photo pass waits for it',
      )
    }
    this.photoPassRunning = true
    try {
      const result = await reenrolPhotoSamples(this.passDeps(stores), {
        ...(input.maxSamples !== undefined ? { maxSamples: input.maxSamples } : {}),
        ...(input.dryRun === true ? { dryRun: true } : {}),
      })
      if (!result.dryRun) {
        // Only what a REAL run actually looked at and could not finish.
        for (const o of result.outcomes) {
          if (o.outcome === 'refused' || o.outcome === 'failed' || o.outcome === 'old-kept') {
            this.attempted.add(o.sampleId)
          }
        }
        this.autoConverged = false
      }
      this.lastPhotoPass = { ...result, finishedAtMs: Date.now() }
      return result
    } finally {
      this.photoPassRunning = false
    }
  }

  /** The timer's half of "automatic": armed only, and quiet once converged. */
  async maybeAutoRunPhotoPass(): Promise<void> {
    if (!this.autoArmed || this.autoConverged) return
    try {
      const stores = this.deps.stores()
      if (stores === null) return
      if (this.photoPassRunning || this.resetRunning || this.deps.isReembedRunning()) return
      const samples = await stores.identityStore.listPhotoSamplesForReenrol()
      if (!shouldAutoReenrolPhotos(samples, this.attempted, false)) {
        this.autoConverged = true
        this.deps.logger.info('face photo re-enrol: converged — the automatic scan stops', {
          meta: {
            total: samples.length,
            v1Left: samples.filter((s) => !isV2Aligned(s)).length,
            attempted: this.attempted.size,
          },
        })
        return
      }
      this.deps.logger.info('face photo re-enrol: auto-starting — untried v1 photo samples', {
        meta: { v1: samples.filter((s) => !isV2Aligned(s)).length, total: samples.length },
      })
      await this.runPass({})
    } catch (err: unknown) {
      this.deps.logger.warn('face photo re-enrol: automatic run failed', {
        meta: { error: errorMessage(err) },
      })
    }
  }

  /**
   * The VERIFIED `sourceMediaId` backfill (`photo-source-backfill.ts`). Admin
   * only. It neither arms nor starts the photo pass, and it refuses while one
   * runs — the pass reads the column it writes.
   */
  async backfillPhotoSources(
    input: PhotoSourceBackfillOptions,
  ): Promise<PhotoSourceBackfillResult> {
    const stores = this.deps.stores()
    if (stores === null) {
      throw new Error('embedding.backfillPhotoSources: the gallery stores are not ready')
    }
    if (this.photoPassRunning) {
      throw new Error('embedding.backfillPhotoSources: a photo re-enrol pass is running')
    }
    if (this.resetRunning) {
      throw new Error('embedding.backfillPhotoSources: a face gallery reset is running')
    }
    this.backfillRunning = true
    try {
      return await this.runBackfill(stores, input)
    } finally {
      this.backfillRunning = false
    }
  }

  private async runBackfill(
    stores: FaceAlignmentStores,
    input: PhotoSourceBackfillOptions,
  ): Promise<PhotoSourceBackfillResult> {
    const { identityStore, mediaStore } = stores
    return backfillPhotoSources(
      {
        listPhotoSamples: () => identityStore.listPhotoSamplesForReenrol(),
        listSampleMediaRefs: () => identityStore.listSampleMediaRefs(),
        mediaOwner: (mediaId) => mediaStore.ownerOf(mediaId),
        mediaBytes: async (mediaId) => {
          const file = await mediaStore.getById(mediaId)
          return file === null ? null : Buffer.from(file.base64, 'base64')
        },
        writeSourceMediaId: (sampleId, sourceMediaId) =>
          identityStore.setSourceMediaId(sampleId, sourceMediaId),
        readSourceMediaId: (sampleId) => identityStore.readSourceMediaId(sampleId),
        logger: this.deps.logger,
      },
      input,
    )
  }

  /**
   * Run the old-alignment prune — every identity, or one after an enrol.
   * Serialised; never throws (a prune is housekeeping, and its failures are
   * logged inside).
   */
  prune(identityId?: string): Promise<PruneResult | null> {
    const next = this.pruneChain.then(() => this.pruneNow(identityId))
    this.pruneChain = next.catch(() => undefined)
    return next
  }

  private async pruneNow(identityId: string | undefined): Promise<PruneResult | null> {
    const stores = this.deps.stores()
    if (stores === null) return null
    if (this.deps.isReembedRunning() || this.resetRunning) {
      this.deps.logger.info('face gallery prune: skipped — a re-embed pass or a reset is running', {
        meta: { identityId: identityId ?? null, resetRunning: this.resetRunning },
      })
      return null
    }
    this.pruneRunning = true
    try {
      const result = await pruneV1DetectedSamples(
        {
          listIdentities: () => stores.identityStore.listIdentities(),
          // Projected and index-covered (D447): the prune runs hourly.
          listSamples: (id) => stores.identityStore.listSamplesForPrune(id),
          removeSample: (id, sampleId) => this.deps.removeDetectedSample(id, sampleId),
          refreshGallery: () => {
            void this.deps.refreshGallery()
          },
          logger: this.deps.logger,
        },
        identityId !== undefined ? { identityId } : {},
      )
      this.lastPrune = { finishedAtMs: Date.now(), removed: result.removed }
      return result
    } catch (err: unknown) {
      this.deps.logger.warn('face gallery prune failed', {
        meta: { identityId: identityId ?? null, error: errorMessage(err) },
      })
      return null
    } finally {
      this.pruneRunning = false
    }
  }

  /**
   * The gallery reset (D644). Admin only. REFUSES — never queues — while any
   * other job that rewrites the gallery is running: the photo pass, the model
   * re-embed pass, a prune, or another reset. The flag is claimed in the same
   * synchronous step as the checks, before the first await.
   */
  async resetToCore(input: GalleryResetOptions): Promise<GalleryResetResult> {
    const stores = this.deps.stores()
    if (stores === null) {
      throw new Error('faceGallery.resetToCore: the gallery stores are not ready')
    }
    const busy = this.busyReason()
    if (busy !== null) throw new Error(`faceGallery.resetToCore: refused — ${busy}`)
    this.resetRunning = true
    try {
      return await resetGalleryToCore(this.resetDeps(stores), input)
    } finally {
      this.resetRunning = false
    }
  }

  /** What stops a reset now, or null. */
  private busyReason(): string | null {
    if (this.resetRunning) return 'a reset is already running'
    if (this.photoPassRunning) return 'a photo re-enrol pass is running'
    if (this.backfillRunning) return 'a photo source backfill is running'
    if (this.pruneRunning) return 'a gallery prune is running'
    if (this.deps.isReembedRunning()) return 'a face re-embed pass is running'
    return null
  }

  private resetDeps(stores: FaceAlignmentStores): Parameters<typeof resetGalleryToCore>[0] {
    const { identityStore, mediaStore, faceStore } = stores
    return {
      listIdentities: () => identityStore.listIdentities(),
      listSamples: async (identityId) =>
        (await identityStore.listSamples(identityId)).map(
          (s): ResetSample => ({
            sampleId: s.id,
            identityId,
            source: s.source,
            modelId: s.modelId,
            addedAt: s.addedAt,
            ...(s.mediaId !== undefined ? { mediaId: s.mediaId } : {}),
            ...(s.deviceId !== undefined ? { deviceId: s.deviceId } : {}),
            ...(s.alignment !== undefined ? { alignment: s.alignment } : {}),
            ...(s.replacesSampleId !== undefined ? { replacesSampleId: s.replacesSampleId } : {}),
          }),
        ),
      loadVectors: (ids) => identityStore.loadSampleVectors(ids),
      realign: async (sample, oldVector) => {
        if (sample.mediaId === undefined) return { kind: 'refused', reason: 'no-template' }
        const file = await mediaStore.getById(sample.mediaId)
        if (file === null) return { kind: 'refused', reason: 'the template blob is gone' }
        const letterboxed = await letterboxFaceTemplate(Buffer.from(file.base64, 'base64'))
        const faces = await this.deps.analyzePhoto(letterboxed)
        return realignVerdictFrom(faces, oldVector, sample.modelId)
      },
      putTemplate: (sample, jpeg) =>
        mediaStore.put({
          deviceId: sample.deviceId ?? PHOTO_ENROLL_DEVICE_ID,
          // `identity` routes the blob to `galleryMedia`, out of a footage wipe's reach (D197).
          ownerKind: 'identity',
          ownerId: sample.identityId,
          kind: 'faceCrop',
          timestamp: Date.now(),
          data: jpeg,
        }),
      deleteMedia: (mediaId) => mediaStore.deleteById(mediaId),
      addSample: (input) => identityStore.addSample(input),
      sampleExists: (sampleId) => identityStore.sampleExists(sampleId),
      removeSample: (identityId, sampleId) => this.deps.removeDetectedSample(identityId, sampleId),
      listPendingFaces: () => faceStore.listPendingFaces(),
      deleteFaces: (faces) => this.deletePendingFaces(stores, faces),
      refreshGallery: () => this.deps.refreshGallery(),
      logger: this.deps.logger,
    }
  }

  /**
   * Drop pending faces with their media (crop and source frame — both are
   * `face`-owned). Per face, a GUARDED step: the pending predicate is read
   * again first (the listing may be minutes old and the operator may have
   * assigned the face since), the media goes, then the row — and the row's
   * delete re-checks once more. Only deletions that happened are counted;
   * every skip and failure is logged with its camera.
   */
  private async deletePendingFaces(
    stores: FaceAlignmentStores,
    faces: readonly PendingFaceRef[],
  ): Promise<number> {
    let deleted = 0
    const perDevice = new Map<number, PendingDeleteTally>()
    const tally = (deviceId: number): PendingDeleteTally => {
      const t = perDevice.get(deviceId) ?? { deleted: 0, skipped: 0, failed: 0 }
      perDevice.set(deviceId, t)
      return t
    }
    for (const face of faces) {
      const outcome = await this.deleteOnePending(stores, face)
      tally(face.deviceId)[outcome] += 1
      if (outcome === 'deleted') deleted += 1
    }
    for (const [deviceId, t] of perDevice) {
      this.deps.logger.info('face gallery reset: pending faces', {
        tags: { deviceId },
        meta: { ...t },
      })
    }
    return deleted
  }

  private async deleteOnePending(
    stores: FaceAlignmentStores,
    face: PendingFaceRef,
  ): Promise<keyof PendingDeleteTally> {
    const fail = (step: string, err: unknown): 'failed' => {
      this.deps.logger.warn('face gallery reset: a pending face would not go', {
        tags: { deviceId: face.deviceId },
        meta: { faceId: face.faceId, step, error: errorMessage(err) },
      })
      return 'failed'
    }
    try {
      if ((await stores.faceStore.isPending(face.faceId)) !== true) {
        this.deps.logger.info('face gallery reset: face no longer pending — kept', {
          tags: { deviceId: face.deviceId },
          meta: { faceId: face.faceId },
        })
        return 'skipped'
      }
    } catch (err: unknown) {
      return fail('re-check', err)
    }
    try {
      await stores.mediaStore.deleteForOwner('face', [face.faceId])
    } catch (err: unknown) {
      return fail('media', err)
    }
    // Second guard, as close to the delete as the store allows.
    if ((await stores.faceStore.isPending(face.faceId).catch(() => null)) !== true) {
      // Its media is already gone: the row survives without its crop and
      // source frame, which must be visible (a silent drop reads as "kept").
      this.deps.logger.warn(
        'face gallery reset: face stopped being pending after its media was deleted — row kept without media',
        {
          tags: { deviceId: face.deviceId },
          meta: { faceId: face.faceId },
        },
      )
      return 'skipped'
    }
    return (await stores.faceStore.delete(face.faceId)) ? 'deleted' : 'failed'
  }

  async status(): Promise<FaceAlignmentStatus> {
    const stores = this.deps.stores()
    if (stores === null) {
      throw new Error('embedding.faceAlignmentStatus: the identity store is not ready')
    }
    const identities = await stores.identityStore.listIdentities()
    const byIdentity: FaceAlignmentIdentityStatus[] = []
    for (const identity of identities) {
      const samples = await stores.identityStore.listSamplesForPrune(identity.id)
      const count = (source: 'photo' | 'detected', v2: boolean): number =>
        samples.filter((s) => s.source === source && isV2Aligned(s) === v2).length
      byIdentity.push({
        identityId: identity.id,
        name: identity.name,
        photoV1: count('photo', false),
        photoV2: count('photo', true),
        detectedV1: count('detected', false),
        detectedV2: count('detected', true),
      })
    }
    return {
      photoPassRunning: this.photoPassRunning,
      autoArmed: this.autoArmed,
      autoConverged: this.autoConverged,
      lastPhotoPass: this.lastPhotoPass,
      lastPrune: this.lastPrune,
      byIdentity,
    }
  }
  /**
   * Remove an OLD photo sample: its row and vector, then its OLD template —
   * and nothing else. Not `FaceGalleryProvider.removeSample`: that deletes
   * `sourceMediaId` too, and the replacement row owns that photograph now.
   * The template goes only once the row is known gone (a row pointing at a
   * deleted template is worse than an orphan blob).
   */
  private async removeOldPhotoSample(
    stores: FaceAlignmentStores,
    sample: PhotoReenrolSample,
    replacement: PhotoReenrolReplacement,
  ): Promise<void> {
    const { identityStore, mediaStore } = stores
    // A DETECTED sample is named by the buffered face it was enrolled from
    // (D644). That face moves to the replacement BEFORE the old row goes: a
    // face naming a removed sample would lose its link to the source frame
    // it still shares with the replacement. A failure throws — the old
    // sample stays, and the pass reports it.
    if (sample.source === 'detected') {
      for (const ref of await stores.faceStore.listFacesForSample(
        sample.identityId,
        sample.sampleId,
      )) {
        await stores.faceStore.repointSample(ref.faceId, {
          sampleId: replacement.sampleId,
          ...(replacement.mediaId !== undefined && ref.mediaId === sample.mediaId
            ? { mediaId: replacement.mediaId }
            : {}),
        })
      }
    }
    let removeError: unknown = null
    try {
      await identityStore.removeSample(sample.identityId, sample.sampleId)
    } catch (err: unknown) {
      removeError = err
    }
    const rowGone =
      removeError === null || !(await identityStore.sampleExists(sample.sampleId).catch(() => true))
    if (rowGone && sample.mediaId !== undefined) {
      await mediaStore.deleteById(sample.mediaId).catch((err: unknown) => {
        this.deps.logger.warn('face photo re-enrol: old template blob could not be deleted', {
          meta: {
            sampleId: sample.sampleId,
            identityId: sample.identityId,
            mediaId: sample.mediaId,
            error: errorMessage(err),
          },
        })
      })
    }
    if (removeError !== null) throw removeError
  }

  private passDeps(stores: FaceAlignmentStores): PhotoReenrolDeps {
    const { identityStore, mediaStore } = stores
    return {
      // Photo samples AND detected samples that name their source frame (D644).
      listPhotoSamples: () => identityStore.listSourcedSamplesForReenrol(),
      loadSourcePhoto: async (sample) => {
        if (sample.sourceMediaId === undefined) return null
        const file = await mediaStore.getById(sample.sourceMediaId)
        return file === null ? null : Buffer.from(file.base64, 'base64')
      },
      analyzePhoto: (sample, photo) =>
        sample.source === 'detected' && sample.sourceBbox !== undefined
          ? analyzeFaceSourceWindow(photo, sample.sourceBbox, (jpeg) =>
              this.deps.analyzePhoto(jpeg),
            )
          : this.deps.analyzePhoto(photo),
      loadOldVector: async (sample) =>
        (await identityStore.loadSampleVectors([sample.sampleId])).get(sample.sampleId) ?? null,
      loadGallery: () => identityStore.loadGallery(),
      putTemplate: (sample, jpeg) =>
        mediaStore.put({
          // A photograph has no camera — see PHOTO_ENROLL_DEVICE_ID.
          deviceId: sample.deviceId ?? PHOTO_ENROLL_DEVICE_ID,
          // `identity` routes the blob to `galleryMedia`, out of a footage wipe's reach (D197).
          ownerKind: 'identity',
          ownerId: sample.identityId,
          kind: 'faceCrop',
          timestamp: Date.now(),
          data: jpeg,
        }),
      deleteMedia: (mediaId) => mediaStore.deleteById(mediaId),
      addSample: (input) => identityStore.addSample(input),
      sampleExists: (sampleId) => identityStore.sampleExists(sampleId),
      removeOldSample: (sample, replacement) =>
        this.removeOldPhotoSample(stores, sample, replacement),
      refreshGallery: () => this.deps.refreshGallery(),
      pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      logger: this.deps.logger,
    }
  }
}
