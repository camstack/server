/**
 * Re-enrol every PHOTO sample from the photograph it was cut from, through the
 * FIXED face alignment (D643).
 *
 * ## Why only photo samples, and why this is possible at all
 *
 * The SCRFD fix of 2026-09-26 moved every aligned template. A DETECTED sample
 * keeps only its old 112×112 template — its source frame is gone with footage
 * retention — so it cannot be re-derived; it is replaced over time by new
 * detected samples and pruned (`face-gallery-prune.ts`). A PHOTO sample keeps
 * the original (`sourceMediaId`, D196/D197), so it can be run through the
 * REAL photo analyze path again — detect + align with the fixed SCRFD + embed
 * with the cluster's model — exactly as `photo.analyze` does. Which face in
 * the photo is chosen, and when the pass refuses, is `face-photo-choice.ts`.
 *
 * ## Dry run
 *
 * `dryRun: true` analyses and chooses exactly as a real run would — the pick
 * with its IoU and cosine is in `outcomes` — and writes NOTHING: no blob, no
 * row, no removal.
 *
 * ## Order, and D49
 *
 * add the new sample → only then remove the old one. Every step before the add
 * leaves the old sample exactly as it was. If `addSample` throws, the pass
 * READS BACK whether the row landed anyway (an `addSample` can throw after its
 * insert, on the identity bump): a landed row keeps its template and the pass
 * continues; an absent one gets its template blob reclaimed; an unreadable
 * answer keeps the blob and says so with the media id (a failed read changes
 * nothing). A removal that throws is checked the same way — the old row gone
 * counts as removed, still present means both stay and the next run finds the
 * landed replacement (same identity, same `sourceMediaId`, v2) and retries only
 * the removal. The source photograph is shared by the old and new row and is
 * never deleted here.
 *
 * Residual, accepted: a PROCESS crash between writing the template and
 * `addSample` leaves one ≤10 KB identity-owned blob no row names. The line
 * `template written` carries its media id, so it is findable.
 *
 * Idempotent through the stamp: a v2 photo sample is skipped.
 */
import type { IScopedLogger } from '@camstack/types'
import {
  FACE_ALIGNMENT_SCRFD_V2,
  type FaceAlignmentVersion,
  isV2Aligned,
} from './face-alignment-version.js'
import {
  choosePhotoFace,
  type PhotoFaceChosen,
  type PhotoReenrolRefusal,
} from './face-photo-choice.js'
import type { PhotoBbox, PhotoFace } from './photo-enrollment.js'
import { enrollmentPromiscuity, type GallerySample } from './pipeline/face-matcher.js'

export {
  choosePhotoFace,
  PHOTO_REENROL_AMBIGUITY_MARGIN,
  PHOTO_REENROL_COSINE_FLOOR,
  PHOTO_REENROL_MIN_IOU,
  type PhotoFaceChoice,
  type PhotoFaceChoiceInput,
  type PhotoReenrolRefusal,
} from './face-photo-choice.js'

/** Tens of rows, each a full detect+embed on a node: pacing only keeps hub-main breathing. */
const DEFAULT_PHOTO_REENROL_PACING_MS = 25

/**
 * One re-derivable sample, as the pass needs to see it: a photo sample, or a
 * detected sample that names its source frame (D644, "source re-enrol").
 */
export interface PhotoReenrolSample {
  readonly sampleId: string
  readonly identityId: string
  readonly identityName: string
  readonly modelId: string
  /** Absent = `photo` (every row this pass saw before D644). */
  readonly source?: 'photo' | 'detected'
  /** The camera a detected sample came from; a photo has none. */
  readonly deviceId?: number
  /** The OLD aligned template. Removed with the old row. */
  readonly mediaId?: number
  /** The original photograph — read from the column, never inferred. */
  readonly sourceMediaId?: number
  /** The face's rectangle in the original, when the row recorded one. */
  readonly sourceBbox?: PhotoBbox
  readonly alignment?: FaceAlignmentVersion
}

/** What the pass enrols. `sourceMediaId` is the OLD row's, kept. */
export interface PhotoReenrolAddInput {
  readonly identityId: string
  readonly embedding: readonly number[]
  readonly modelId: string
  /** The OLD row's provenance, kept: a re-derived detected sample stays detected. */
  readonly source: 'photo' | 'detected'
  readonly deviceId?: number
  readonly mediaId: number
  readonly sourceMediaId: number
  readonly sourceBbox: PhotoBbox
  readonly alignment: FaceAlignmentVersion
}

/** The row `addSample` wrote. */
export interface PhotoReenrolAddedSample {
  readonly id: string
}

/** The row that replaces an old one — what faces naming the old one move to. */
export interface PhotoReenrolReplacement {
  readonly sampleId: string
  readonly mediaId?: number
}

export interface PhotoReenrolDeps {
  listPhotoSamples(): Promise<readonly PhotoReenrolSample[]>
  /** The original photograph's bytes; null when the blob is gone. */
  loadSourcePhoto(sample: PhotoReenrolSample): Promise<Buffer | null>
  /** The REAL photo analyze path (detect + align + embed). May throw. */
  analyzePhoto(sample: PhotoReenrolSample, photoJpeg: Buffer): Promise<readonly PhotoFace[]>
  /** The old sample's vector off the gallery index; null when unreadable. */
  loadOldVector(sample: PhotoReenrolSample): Promise<readonly number[] | null>
  loadGallery(): Promise<readonly GallerySample[]>
  /** Write the new aligned template, owned by the identity. Returns its media id. */
  putTemplate(sample: PhotoReenrolSample, templateJpeg: Buffer): Promise<number>
  deleteMedia(mediaId: number): Promise<void>
  addSample(input: PhotoReenrolAddInput): Promise<PhotoReenrolAddedSample>
  /** Is a sample row with this id present? Asked only after a write threw. */
  sampleExists(sampleId: string): Promise<boolean>
  /**
   * Remove the OLD row, its vector and its OLD template — never the source.
   * A detected sample's buffered faces are moved to `replacement` first.
   */
  removeOldSample(sample: PhotoReenrolSample, replacement: PhotoReenrolReplacement): Promise<void>
  refreshGallery(): Promise<void> | void
  pause(ms: number): Promise<void>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

export interface PhotoReenrolOptions {
  /** Stop after this many re-enrols (or would-be re-enrols); the result reports what remains. */
  readonly maxSamples?: number
  /** Analyse and choose, report the pick, write nothing. */
  readonly dryRun?: boolean
  readonly pacingMs?: number
}

export interface PhotoReenrolRefusalEntry {
  readonly sampleId: string
  readonly identityId: string
  readonly reason: PhotoReenrolRefusal
}

/** The face a run chose, with the evidence for it. */
export interface PhotoReenrolPick {
  readonly by: 'iou' | 'cosine'
  readonly cosine: number
  readonly iou: number | null
  readonly faceIndex: number
}

export type PhotoReenrolOutcomeKind =
  | 'reenrolled'
  | 'would-reenrol'
  | 'refused'
  | 'failed'
  /** Replaced, but the old row is still there. */
  | 'old-kept'
  /** Its replacement had landed earlier; this run removed the old row. */
  | 'old-removal-retried'
  /** Its replacement had landed earlier; a dry run leaves the removal owed. */
  | 'old-removal-pending'
  /** Past the budget — not looked at. */
  | 'not-reached'

/** What happened to ONE v1 photo sample. */
export interface PhotoReenrolSampleOutcome {
  readonly sampleId: string
  readonly identityId: string
  readonly identityName: string
  readonly outcome: PhotoReenrolOutcomeKind
  readonly reason?: PhotoReenrolRefusal
  /** The step that failed, for `failed`. */
  readonly step?: string
  readonly pick?: PhotoReenrolPick
  readonly newSampleId?: string
}

export interface PhotoReenrolResult {
  readonly dryRun: boolean
  /** Photo samples seen. */
  readonly total: number
  readonly alreadyV2: number
  readonly reenrolled: number
  /** Dry run only: how many a real run would have re-enrolled. */
  readonly wouldReenrol: number
  /** An old sample whose replacement had landed on a previous run; only its removal was retried. */
  readonly oldRemovalRetried: number
  readonly refused: number
  readonly failed: number
  /** Replaced, but the old row is still present — both exist until the next run. */
  readonly oldKept: number
  /** v1 photo samples still present when the pass ended. */
  readonly remaining: number
  /** Everything that COULD be done was done. A refusal does not hold this back; a failure does. */
  readonly complete: boolean
  readonly refusals: readonly PhotoReenrolRefusalEntry[]
  /** One entry per v1 photo sample the run saw, in order. */
  readonly outcomes: readonly PhotoReenrolSampleOutcome[]
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A landed v2 replacement of `sample`: same identity, same original photo. */
function replacementOf(
  sample: PhotoReenrolSample,
  all: readonly PhotoReenrolSample[],
): PhotoReenrolSample | undefined {
  if (sample.sourceMediaId === undefined) return undefined
  return all.find(
    (s) =>
      s.sampleId !== sample.sampleId &&
      isV2Aligned(s) &&
      s.identityId === sample.identityId &&
      s.sourceMediaId === sample.sourceMediaId,
  )
}

/** One sample's result inside the pass, before it is tallied. */
type SampleVerdict =
  | {
      readonly kind: 'reenrolled'
      readonly oldKept: boolean
      readonly pick: PhotoReenrolPick
      readonly newSampleId: string
    }
  | { readonly kind: 'would-reenrol'; readonly pick: PhotoReenrolPick }
  | { readonly kind: 'refused'; readonly reason: PhotoReenrolRefusal }
  | { readonly kind: 'failed'; readonly step: string }

type SampleLogMeta = Record<string, unknown>

/** A detected sample's lines carry its camera; a photo has none to name. */
interface SampleLogTags {
  readonly tags?: { readonly deviceId: number }
}

function deviceTags(sample: PhotoReenrolSample): SampleLogTags {
  return sample.deviceId !== undefined ? { tags: { deviceId: sample.deviceId } } : {}
}

function sampleMeta(sample: PhotoReenrolSample): SampleLogMeta {
  return {
    sampleId: sample.sampleId,
    identityId: sample.identityId,
    identity: sample.identityName,
    sourceMediaId: sample.sourceMediaId ?? null,
  }
}

function pickOf(choice: PhotoFaceChosen): PhotoReenrolPick {
  return {
    by: choice.by,
    cosine: choice.cosine,
    iou: choice.iou ?? null,
    faceIndex: choice.face.faceIndex,
  }
}

/** After a write threw: is the row there? `null` = the read failed too. */
async function rowPresent(deps: PhotoReenrolDeps, sampleId: string): Promise<boolean | null> {
  try {
    return await deps.sampleExists(sampleId)
  } catch {
    return null
  }
}

/**
 * Remove the old row. A throw is checked against the store: gone counts as
 * removed, present (or unknown) means the old sample is still there.
 */
async function removeOld(
  deps: PhotoReenrolDeps,
  sample: PhotoReenrolSample,
  replacement: PhotoReenrolReplacement,
): Promise<boolean> {
  try {
    await deps.removeOldSample(sample, replacement)
    return true
  } catch (err: unknown) {
    const present = await rowPresent(deps, sample.sampleId)
    if (present === false) {
      deps.logger.warn(
        'face photo re-enrol: the old sample removal threw AFTER its row went — counted as removed',
        { ...deviceTags(sample), meta: { ...sampleMeta(sample), error: errorMessage(err) } },
      )
      return true
    }
    deps.logger.warn(
      present === true
        ? 'face photo re-enrol: the OLD sample is still present — old and new both stand, the next run retries the removal'
        : 'face photo re-enrol: the OLD sample removal threw and its row could not be read back — the next run re-checks',
      { ...deviceTags(sample), meta: { ...sampleMeta(sample), error: errorMessage(err) } },
    )
    return false
  }
}

/** What a sample's choice is made from. */
interface LoadedInputs {
  readonly faces: readonly PhotoFace[]
  readonly oldVector: readonly number[]
}

/** The replacement row's fields, minus the template id written just before it. */
type ReplacementFields = Omit<PhotoReenrolAddInput, 'mediaId'>

/** Read the inputs; a refusal or failure is returned instead. */
async function loadInputs(
  deps: PhotoReenrolDeps,
  sample: PhotoReenrolSample,
  refuse: (reason: PhotoReenrolRefusal, detail: string) => SampleVerdict,
  fail: (step: string, err: unknown) => SampleVerdict,
): Promise<SampleVerdict | LoadedInputs> {
  if (sample.sourceMediaId === undefined)
    return refuse('no-source', 'the row names no original photo')
  let photo: Buffer | null
  try {
    photo = await deps.loadSourcePhoto(sample)
  } catch (err: unknown) {
    return fail('load-source', err)
  }
  if (photo === null)
    return refuse('no-source', `the original photo ${sample.sourceMediaId} is gone`)
  let oldVector: readonly number[] | null
  try {
    oldVector = await deps.loadOldVector(sample)
  } catch (err: unknown) {
    return fail('load-old-vector', err)
  }
  if (oldVector === null) return refuse('no-old-vector', 'the old vector is not in the index')
  try {
    return { faces: await deps.analyzePhoto(sample, photo), oldVector }
  } catch (err: unknown) {
    return fail('analyze', err)
  }
}

/** Write the template and the row. A failure reclaims only what no row names. */
async function writeReplacement(
  deps: PhotoReenrolDeps,
  sample: PhotoReenrolSample,
  input: ReplacementFields,
  template: Buffer,
  fail: (step: string, err: unknown) => SampleVerdict,
): Promise<SampleVerdict | PhotoReenrolReplacement> {
  let mediaId: number
  try {
    mediaId = await deps.putTemplate(sample, template)
  } catch (err: unknown) {
    return fail('put-template', err)
  }
  deps.logger.info('face photo re-enrol: template written', {
    ...deviceTags(sample),
    meta: { ...sampleMeta(sample), mediaId },
  })
  let added: PhotoReenrolAddedSample | null = null
  let addError: unknown = null
  try {
    added = await deps.addSample({ ...input, mediaId })
  } catch (err: unknown) {
    addError = err
  }
  if (added !== null) return { sampleId: added.id, mediaId }
  return reclaimAfterFailedAdd(deps, sample, mediaId, addError, fail)
}

async function reclaimAfterFailedAdd(
  deps: PhotoReenrolDeps,
  sample: PhotoReenrolSample,
  mediaId: number,
  addError: unknown,
  fail: (step: string, err: unknown) => SampleVerdict,
): Promise<SampleVerdict | PhotoReenrolReplacement> {
  let landed: PhotoReenrolSample | undefined
  try {
    landed = (await deps.listPhotoSamples()).find(
      (s) => isV2Aligned(s) && s.identityId === sample.identityId && s.mediaId === mediaId,
    )
  } catch (readErr: unknown) {
    deps.logger.warn(
      'face photo re-enrol: addSample threw and the read-back failed — the template blob is KEPT (it may be named by a landed row)',
      {
        ...deviceTags(sample),
        meta: { ...sampleMeta(sample), mediaId, error: errorMessage(readErr) },
      },
    )
    return fail('add-sample', addError)
  }
  if (landed !== undefined) {
    deps.logger.warn('face photo re-enrol: addSample threw but the row LANDED — continuing', {
      meta: {
        ...sampleMeta(sample),
        mediaId,
        newSampleId: landed.sampleId,
        error: errorMessage(addError),
      },
    })
    return { sampleId: landed.sampleId, mediaId }
  }
  // An identity-owned blob is exempt from every sweep: an orphan here lives forever.
  await deps.deleteMedia(mediaId).catch((delErr: unknown) => {
    deps.logger.warn('face photo re-enrol: could not reclaim the new template blob', {
      ...deviceTags(sample),
      meta: { ...sampleMeta(sample), mediaId, error: errorMessage(delErr) },
    })
  })
  return fail('add-sample', addError)
}

async function reenrolOne(
  deps: PhotoReenrolDeps,
  sample: PhotoReenrolSample,
  dryRun: boolean,
): Promise<SampleVerdict> {
  const refuse = (reason: PhotoReenrolRefusal, detail: string): SampleVerdict => {
    deps.logger.warn('face photo re-enrol: REFUSED — the old sample stays as it is', {
      ...deviceTags(sample),
      meta: { ...sampleMeta(sample), reason, detail, dryRun },
    })
    return { kind: 'refused', reason }
  }
  const fail = (step: string, err: unknown): SampleVerdict => {
    deps.logger.warn('face photo re-enrol: FAILED — the old sample stays as it is', {
      ...deviceTags(sample),
      meta: { ...sampleMeta(sample), step, error: errorMessage(err), dryRun },
    })
    return { kind: 'failed', step }
  }

  const inputs = await loadInputs(deps, sample, refuse, fail)
  if ('kind' in inputs) return inputs
  const choice = choosePhotoFace({
    faces: inputs.faces,
    ...(sample.sourceBbox !== undefined ? { oldBox: sample.sourceBbox } : {}),
    oldVector: inputs.oldVector,
    modelId: sample.modelId,
  })
  if (choice.kind === 'refused') return refuse(choice.reason, choice.detail)
  const { face } = choice
  const { embedding, modelId, alignedCropBase64: template } = face
  if (embedding === undefined || modelId === undefined || template === undefined) {
    return refuse('no-enrollable-face', 'the chosen face lost its vector or template')
  }
  let gallery: readonly GallerySample[]
  try {
    gallery = await deps.loadGallery()
  } catch (err: unknown) {
    return fail('load-gallery', err)
  }
  const foreign = enrollmentPromiscuity(embedding, modelId, sample.identityId, gallery)
  if (foreign !== null) {
    return refuse(
      'promiscuous',
      `cosine ${foreign.cosine.toFixed(3)} with a sample of identity ${foreign.identityId}`,
    )
  }
  const pick = pickOf(choice)
  const pickMeta = { ...sampleMeta(sample), ...pick, modelId }
  if (dryRun) {
    deps.logger.info('face photo re-enrol (DRY RUN): would re-enrol — nothing written', {
      ...deviceTags(sample),
      meta: pickMeta,
    })
    return { kind: 'would-reenrol', pick }
  }

  const sourceMediaId = sample.sourceMediaId
  if (sourceMediaId === undefined) return refuse('no-source', 'the row names no original photo')
  const written = await writeReplacement(
    deps,
    sample,
    {
      identityId: sample.identityId,
      embedding,
      modelId,
      source: sample.source ?? 'photo',
      ...(sample.deviceId !== undefined ? { deviceId: sample.deviceId } : {}),
      sourceMediaId,
      sourceBbox: face.bbox,
      alignment: FACE_ALIGNMENT_SCRFD_V2,
    },
    Buffer.from(template, 'base64'),
    fail,
  )
  if ('kind' in written) return written
  deps.logger.info('face photo re-enrol: new sample enrolled from the original', {
    ...deviceTags(sample),
    meta: { ...pickMeta, newSampleId: written.sampleId },
  })
  const removed = await removeOld(deps, sample, written)
  return { kind: 'reenrolled', oldKept: !removed, pick, newSampleId: written.sampleId }
}

function outcomeOf(sample: PhotoReenrolSample, verdict: SampleVerdict): PhotoReenrolSampleOutcome {
  const base = {
    sampleId: sample.sampleId,
    identityId: sample.identityId,
    identityName: sample.identityName,
  }
  switch (verdict.kind) {
    case 'reenrolled':
      return {
        ...base,
        outcome: verdict.oldKept ? 'old-kept' : 'reenrolled',
        pick: verdict.pick,
        newSampleId: verdict.newSampleId,
      }
    case 'would-reenrol':
      return { ...base, outcome: 'would-reenrol', pick: verdict.pick }
    case 'refused':
      return { ...base, outcome: 'refused', reason: verdict.reason }
    case 'failed':
      return { ...base, outcome: 'failed', step: verdict.step }
  }
}

/** The replacement had landed earlier: only the removal is owed. */
async function settleReplaced(
  deps: PhotoReenrolDeps,
  sample: PhotoReenrolSample,
  replacement: PhotoReenrolSample,
  dryRun: boolean,
): Promise<PhotoReenrolOutcomeKind> {
  if (dryRun) return 'old-removal-pending'
  const moveTo: PhotoReenrolReplacement = {
    sampleId: replacement.sampleId,
    ...(replacement.mediaId !== undefined ? { mediaId: replacement.mediaId } : {}),
  }
  if (!(await removeOld(deps, sample, moveTo))) return 'old-kept'
  deps.logger.info('face photo re-enrol: removed an old sample whose replacement had landed', {
    ...deviceTags(sample),
    meta: { ...sampleMeta(sample), replacementSampleId: replacement.sampleId },
  })
  return 'old-removal-retried'
}

function tally(
  samples: readonly PhotoReenrolSample[],
  outcomes: readonly PhotoReenrolSampleOutcome[],
  dryRun: boolean,
): PhotoReenrolResult {
  const count = (kind: PhotoReenrolOutcomeKind): number =>
    outcomes.filter((o) => o.outcome === kind).length
  const refusals: PhotoReenrolRefusalEntry[] = []
  for (const o of outcomes) {
    if (o.outcome === 'refused' && o.reason !== undefined) {
      refusals.push({ sampleId: o.sampleId, identityId: o.identityId, reason: o.reason })
    }
  }
  const reenrolled = count('reenrolled') + count('old-kept')
  const oldRemovalRetried = count('old-removal-retried')
  const failed = count('failed')
  const oldKept = count('old-kept')
  const notReached = count('not-reached')
  return {
    dryRun,
    total: samples.length,
    alreadyV2: samples.filter((s) => isV2Aligned(s)).length,
    reenrolled: dryRun ? 0 : reenrolled,
    wouldReenrol: count('would-reenrol'),
    oldRemovalRetried,
    refused: refusals.length,
    failed,
    oldKept,
    // v1 photo rows still present: everything seen, minus the old rows that went.
    remaining: outcomes.length - count('reenrolled') - oldRemovalRetried,
    complete: notReached === 0 && failed === 0 && oldKept === 0,
    refusals,
    outcomes,
  }
}

/**
 * Bring every v1 photo sample into the fixed alignment, under a bound,
 * resumably. See the module docblock for the order and why it is safe.
 */
export async function reenrolPhotoSamples(
  deps: PhotoReenrolDeps,
  options: PhotoReenrolOptions,
): Promise<PhotoReenrolResult> {
  const pacingMs = options.pacingMs ?? DEFAULT_PHOTO_REENROL_PACING_MS
  const budget = options.maxSamples ?? Number.POSITIVE_INFINITY
  const dryRun = options.dryRun === true
  const samples = await deps.listPhotoSamples()
  const outcomes: PhotoReenrolSampleOutcome[] = []
  let spent = 0

  deps.logger.info('face photo re-enrol starting', {
    meta: { samples: samples.length, maxSamples: options.maxSamples ?? null, dryRun },
  })

  for (const sample of samples) {
    if (isV2Aligned(sample)) continue
    const base = {
      sampleId: sample.sampleId,
      identityId: sample.identityId,
      identityName: sample.identityName,
    }
    const replacement = replacementOf(sample, samples)
    if (replacement !== undefined) {
      outcomes.push({ ...base, outcome: await settleReplaced(deps, sample, replacement, dryRun) })
      continue
    }
    if (spent >= budget) {
      outcomes.push({ ...base, outcome: 'not-reached' })
      continue
    }
    const verdict = await reenrolOne(deps, sample, dryRun)
    if (verdict.kind === 'reenrolled' || verdict.kind === 'would-reenrol') spent += 1
    outcomes.push(outcomeOf(sample, verdict))
    await deps.pause(pacingMs)
  }

  const result = tally(samples, outcomes, dryRun)
  if (!dryRun && (result.reenrolled > 0 || result.oldRemovalRetried > 0)) {
    await deps.refreshGallery()
  }
  const { outcomes: _perSample, ...summary } = result
  deps.logger.info('face photo re-enrol finished', { meta: { ...summary } })
  return result
}
