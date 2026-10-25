/**
 * Multi-photo enrollment — the batch layer over the per-photo `photo.*` bridge.
 *
 * The server contract deliberately stays PER PHOTO: one `photo.analyze` per
 * photograph, one bounded expiring session each, one `photo.enroll` per named
 * face. The batch exists only on this side — it is the operator's review, not
 * a wire concept — so nothing here changes what crosses the wire, and the
 * two-gesture design (analyse, then name) is preserved photo by photo.
 *
 * The pieces the dialog leans on:
 *
 *  - {@link partitionPickedFiles} — a bounded pick that NAMES what it refused;
 *  - {@link mapWithConcurrency} — analyses run a few at a time (each one is a
 *    real pipeline run on a node, not a local parse);
 *  - one {@link BatchAssignmentDraft} across all photos, where every face is
 *    still an independent decision;
 *  - {@link enrollAssignedFaces} — batch confirmation, where one failed face
 *    fails alone and an EXPIRED session is healed by re-analysing that one
 *    photograph and retrying, never by guessing.
 */
import {
  buildEnrollPlan,
  countAssignable,
  type PhotoAnalyzeView,
  type PhotoAssignmentDraft,
  type PhotoEnrollRequest,
  type PhotoEnrollView,
  setAssignment,
} from './photo-enroll'
import i18n from '../i18n/index'

/**
 * The most photographs one review may hold.
 *
 * Strictly below the server's session bound (`DEFAULT_PHOTO_SESSION_MAX`, 16):
 * every analysed photo is a live server session until the operator confirms,
 * and a batch at the bound would evict its own first photos — their enrol then
 * fails "expired" while their crops are still on screen. 12 leaves slack for
 * a second tab.
 */
export const MAX_PHOTOS_PER_BATCH = 12

/**
 * How many `photo.analyze` calls run at once. Each one is a full
 * detect+align+embed pipeline run on a cluster node — 2 keeps a 12-photo batch
 * quick without stacking a dozen inference jobs on whatever node is first in
 * the rotation.
 */
export const ANALYZE_CONCURRENCY = 2

/** Where one photograph of the batch is in its life. */
export type BatchPhotoStatus = 'queued' | 'analyzing' | 'analyzed' | 'failed'

/**
 * One photograph in the batch. `photoBase64` is retained deliberately: it is
 * what lets an expired session be healed by re-analysing THIS photo, and a
 * failed analysis be retried, without asking the operator to pick the file
 * again.
 */
export interface BatchPhoto {
  readonly photoIndex: number
  readonly filename: string
  readonly photoBase64: string
  readonly status: BatchPhotoStatus
  readonly analysis?: PhotoAnalyzeView
  readonly error?: string
}

// ── Picking files ───────────────────────────────────────────────────────────

/** The slice of a `File` the partition needs — testable without DOM `File`s. */
export interface PickedFileInfo {
  readonly name: string
  readonly size: number
}

export interface PickedFileBounds {
  readonly maxCount: number
  readonly maxBytes: number
}

export interface PartitionedPick<T extends PickedFileInfo> {
  readonly accepted: readonly T[]
  /** Names of files over the size bound — refused, and SAID so. */
  readonly oversize: readonly string[]
  /** Names of files past the batch cap — refused, and SAID so. */
  readonly overflow: readonly string[]
}

/**
 * Bound a file pick. Oversized files are dropped FIRST so an unusable file
 * never burns a batch slot; both refusals come back named, because a file
 * that silently vanishes reads as "the upload is broken".
 */
export function partitionPickedFiles<T extends PickedFileInfo>(
  files: readonly T[],
  bounds: PickedFileBounds,
): PartitionedPick<T> {
  const oversize: string[] = []
  const sized: T[] = []
  for (const file of files) {
    if (file.size > bounds.maxBytes) oversize.push(file.name)
    else sized.push(file)
  }
  return {
    accepted: sized.slice(0, bounds.maxCount),
    oversize,
    overflow: sized.slice(bounds.maxCount).map((f) => f.name),
  }
}

// ── Bounded concurrency ─────────────────────────────────────────────────────

/**
 * Map with at most `limit` calls in flight, preserving input order in the
 * results. A rejection propagates — callers that want per-item failure catch
 * inside `fn` and return a variant instead.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = new Array<R>(items.length)
  const queue = items.map((item, index) => ({ item, index }))
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue[cursor]
      cursor += 1
      if (entry === undefined) return
      results[entry.index] = await fn(entry.item, entry.index)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker())
  await Promise.all(workers)
  return results
}

// ── Batch state helpers ─────────────────────────────────────────────────────

/** Replace one photo's fields immutably; every other element is kept as-is. */
export function patchBatchPhoto(
  photos: readonly BatchPhoto[],
  photoIndex: number,
  patch: Partial<Omit<BatchPhoto, 'photoIndex'>>,
): readonly BatchPhoto[] {
  return photos.map((photo) => (photo.photoIndex === photoIndex ? { ...photo, ...patch } : photo))
}

// ── The batch draft ─────────────────────────────────────────────────────────

/** `photoIndex → (faceIndex → identityId)`. Absent means IGNORED. */
export type BatchAssignmentDraft = Readonly<Record<number, PhotoAssignmentDraft>>

/** A stable key for one face of one photo — used for the new-name inputs. */
export function faceKey(photoIndex: number, faceIndex: number): string {
  return `${photoIndex}:${faceIndex}`
}

/** Assign one face of one photo, or (with `null`) take it back. Immutable. */
export function setBatchAssignment(
  draft: BatchAssignmentDraft,
  photoIndex: number,
  faceIndex: number,
  identityId: string | null,
): BatchAssignmentDraft {
  const photoDraft = setAssignment(draft[photoIndex] ?? {}, faceIndex, identityId)
  const next: Record<number, PhotoAssignmentDraft> = { ...draft }
  if (Object.keys(photoDraft).length === 0) delete next[photoIndex]
  else next[photoIndex] = photoDraft
  return next
}

/** Assigned AND server-enrollable faces, across every analysed photo. */
export function countBatchAssignable(
  photos: readonly BatchPhoto[],
  draft: BatchAssignmentDraft,
): number {
  let count = 0
  for (const photo of photos) {
    if (photo.analysis === undefined) continue
    count += countAssignable(photo.analysis.faces, draft[photo.photoIndex] ?? {})
  }
  return count
}

// ── New identities across the batch ─────────────────────────────────────────

/** The sentinel the dialog's `<select>` uses for "create a new person". */
export const NEW_IDENTITY_SENTINEL = '__new__'

/** `faceKey(photo, face) → the name typed for that face`. */
export type BatchNewNames = Readonly<Record<string, string>>

export type NewIdentityPlan =
  | {
      readonly kind: 'ok'
      /** Unique trimmed names, in first-appearance order — create each ONCE. */
      readonly names: readonly string[]
    }
  | { readonly kind: 'error'; readonly message: string }

/**
 * Collect the new people the batch needs, ONE per unique trimmed name: the
 * same name typed under two faces (or two photos) is the same person, and two
 * identities for one person is exactly the gallery corruption the identity
 * registry exists to prevent. An assigned new-person face with no name is an
 * error that names the photo and the face, so the operator knows which field
 * is empty.
 */
export function planNewIdentities(
  photos: readonly BatchPhoto[],
  draft: BatchAssignmentDraft,
  newNames: BatchNewNames,
): NewIdentityPlan {
  const names: string[] = []
  for (const photo of photos) {
    if (photo.analysis === undefined) continue
    const photoDraft = draft[photo.photoIndex] ?? {}
    for (const face of photo.analysis.faces) {
      if (!face.enrollable) continue
      if (photoDraft[face.faceIndex] !== NEW_IDENTITY_SENTINEL) continue
      const name = (newNames[faceKey(photo.photoIndex, face.faceIndex)] ?? '').trim()
      if (name === '') {
        return {
          kind: 'error',
          message: i18n.t('helpers.photoEnrollBatch.newPersonNoName', {
            filename: photo.filename,
            face: face.faceIndex + 1,
          }),
        }
      }
      if (!names.includes(name)) names.push(name)
    }
  }
  return { kind: 'ok', names }
}

/**
 * Swap every new-person sentinel for the identity id created for its name.
 * Pure: the created ids come in as a map, the draft comes back resolved.
 */
export function resolveNewIdentityAssignments(
  draft: BatchAssignmentDraft,
  newNames: BatchNewNames,
  nameToId: Readonly<Record<string, string>>,
): BatchAssignmentDraft {
  const resolved: Record<number, PhotoAssignmentDraft> = {}
  for (const [photoKey, photoDraft] of Object.entries(draft)) {
    const photoIndex = Number(photoKey)
    const nextPhoto: Record<number, string> = {}
    for (const [faceKeyStr, identityId] of Object.entries(photoDraft)) {
      const faceIndex = Number(faceKeyStr)
      if (identityId !== NEW_IDENTITY_SENTINEL) {
        nextPhoto[faceIndex] = identityId
        continue
      }
      const name = (newNames[faceKey(photoIndex, faceIndex)] ?? '').trim()
      const created = nameToId[name]
      if (created !== undefined) nextPhoto[faceIndex] = created
    }
    resolved[photoIndex] = nextPhoto
  }
  return resolved
}

// ── The enroll plan and its execution ───────────────────────────────────────

export interface BatchEnrollStep {
  readonly photoIndex: number
  readonly request: PhotoEnrollRequest
}

/**
 * One confirmation per assigned enrollable face, photo by photo in photo
 * order. Photos without an analysis (failed, still queued) plan nothing —
 * their faces were never on screen.
 */
export function buildBatchEnrollPlan(
  photos: readonly BatchPhoto[],
  draft: BatchAssignmentDraft,
): readonly BatchEnrollStep[] {
  const steps: BatchEnrollStep[] = []
  for (const photo of photos) {
    if (photo.analysis === undefined) continue
    const plan = buildEnrollPlan(
      photo.analysis.sessionId,
      photo.analysis.faces,
      draft[photo.photoIndex] ?? {},
    )
    for (const request of plan) steps.push({ photoIndex: photo.photoIndex, request })
  }
  return steps
}

/** The server's expiry wording — the one failure a retry can actually heal. */
export function isSessionExpiredMessage(message: string): boolean {
  return /expired/i.test(message)
}

export interface BatchEnrollDeps {
  enroll(request: PhotoEnrollRequest): Promise<PhotoEnrollView>
  /** Re-run `photo.analyze` over ONE photograph of the batch. */
  reanalyze(photo: BatchPhoto): Promise<PhotoAnalyzeView>
}

export interface BatchEnrollOutcome {
  readonly enrolled: number
  /** The model the server stamped — read back, never chosen here. */
  readonly stampedModelId: string | null
  /** One sentence per failed face, each naming its photo and face. */
  readonly failures: readonly string[]
  /** Fresh analyses minted by expiry retries, keyed by photoIndex — the dialog
   *  folds them back into its state so the review stays 1:1 with the server. */
  readonly refreshedAnalyses: Readonly<Record<number, PhotoAnalyzeView>>
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Confirm the whole batch, face by face.
 *
 * Failures are per FACE: one refused embedding (ambiguity, magnitude) is a
 * property of that face, and the rest of the batch still enrols. The one
 * failure that is healed rather than reported is an EXPIRED session — the
 * photograph is still held client-side, so it is re-analysed once and the
 * face retried against the fresh session. A retry whose re-analysis no longer
 * shows the same enrollable face refuses: enrolling from it would store a
 * vector whose crop the operator never saw, which breaks the 1:1 the gallery
 * depends on.
 */
export async function enrollAssignedFaces(
  photos: readonly BatchPhoto[],
  draft: BatchAssignmentDraft,
  deps: BatchEnrollDeps,
): Promise<BatchEnrollOutcome> {
  const byIndex = new Map<number, BatchPhoto>(photos.map((p) => [p.photoIndex, p]))
  const refreshedAnalyses: Record<number, PhotoAnalyzeView> = {}
  const failures: string[] = []
  let enrolled = 0
  let stampedModelId: string | null = null

  const label = (photoIndex: number, faceIndex: number): string => {
    const filename =
      byIndex.get(photoIndex)?.filename ??
      i18n.t('helpers.photoEnrollBatch.photoFallback', { n: photoIndex + 1 })
    return i18n.t('helpers.photoEnrollBatch.faceLabel', { filename, face: faceIndex + 1 })
  }

  for (const step of buildBatchEnrollPlan(photos, draft)) {
    const fresh = refreshedAnalyses[step.photoIndex]
    const request: PhotoEnrollRequest =
      fresh === undefined ? step.request : { ...step.request, sessionId: fresh.sessionId }
    try {
      const view = await deps.enroll(request)
      enrolled += 1
      stampedModelId = view.modelId
    } catch (err: unknown) {
      const message = errorText(err)
      if (!isSessionExpiredMessage(message) || fresh !== undefined) {
        failures.push(`${label(step.photoIndex, step.request.faceIndex)}: ${message}`)
        continue
      }
      // The session died between analysis and confirm. The photograph is
      // still here — re-analyse it ONCE and retry every remaining face of
      // this photo against the fresh session.
      const photo = byIndex.get(step.photoIndex)
      if (photo === undefined) {
        failures.push(`${label(step.photoIndex, step.request.faceIndex)}: ${message}`)
        continue
      }
      let reanalyzed: PhotoAnalyzeView
      try {
        reanalyzed = await deps.reanalyze(photo)
      } catch (reErr: unknown) {
        failures.push(
          `${label(step.photoIndex, step.request.faceIndex)}: the analysis expired and re-analysing failed (${errorText(reErr)})`,
        )
        continue
      }
      refreshedAnalyses[step.photoIndex] = reanalyzed
      const sameFace = reanalyzed.faces.find(
        (f) => f.faceIndex === step.request.faceIndex && f.enrollable,
      )
      if (sameFace === undefined) {
        // The fresh run no longer shows the face the operator named. Enrolling
        // anything from it would break crop↔vector 1:1 — refuse honestly.
        failures.push(
          `${label(step.photoIndex, step.request.faceIndex)}: the analysis expired, and re-analysing no longer finds this face — assign it again from the fresh result`,
        )
        continue
      }
      try {
        const view = await deps.enroll({
          ...step.request,
          sessionId: reanalyzed.sessionId,
        })
        enrolled += 1
        stampedModelId = view.modelId
      } catch (retryErr: unknown) {
        failures.push(`${label(step.photoIndex, step.request.faceIndex)}: ${errorText(retryErr)}`)
      }
    }
  }

  return { enrolled, stampedModelId, failures, refreshedAnalyses }
}
