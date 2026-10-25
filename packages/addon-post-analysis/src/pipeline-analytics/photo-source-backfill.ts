/**
 * Backfill `identity_samples.sourceMediaId` on photo samples that never got it
 * — VERIFIED, never inferred (D643 follow-up, operator-approved 2026-09-26).
 *
 * The live dry run of the photo re-enrol pass refused all nine photo samples
 * `no-source`: the column is empty on every one, although `enrollPhotoFace`
 * writes the template and then the photograph and a read-only measurement found
 * each original at `mediaId + 1` (9/9: a 112×112 template, then a 2316–5712 px
 * photo). An inference is not a fact. Written unchecked, one wrong `+1` hands
 * the re-enrol pass somebody else's photograph to re-derive a sample from.
 *
 * So the candidate is `mediaId + 1` and nothing else, and it is written only
 * when FOUR independent checks agree:
 *
 *  - **exists** — the row is there and its blob can be read;
 *  - **owner** — the row is owned by `identity` / THIS sample's identity;
 *  - **dims** — the bytes decode as an image larger than the 112×112 template
 *    on both sides (a template at +1 would be another sample's template);
 *  - **unreferenced** — no other sample names it as `mediaId` or
 *    `sourceMediaId`, counting what this run has already written.
 *
 * Every check is evaluated and reported, so a refusal says WHICH one failed.
 * A write is claimed only after it reads back. Idempotent: a sample that
 * already has a source is skipped. It never touches the photo pass or its arm.
 */
import type { IScopedLogger } from '@camstack/types'
import { readJpegSize } from './retrain/jpeg-dimensions.js'
import type { MediaOwnerRef } from './store/media-store.js'

/** The ArcFace template side; the source photo must exceed it on both sides. */
const PHOTO_SOURCE_MIN_SIDE_EXCLUSIVE = 112

/** One photo sample, as the backfill sees it. */
export interface PhotoSourceBackfillSample {
  readonly sampleId: string
  readonly identityId: string
  /** The aligned template. The candidate is this + 1. */
  readonly mediaId?: number
  readonly sourceMediaId?: number
}

/** The media ids one sample (any provenance) names. */
export interface SampleMediaRefs {
  readonly sampleId: string
  readonly mediaId?: number
  readonly sourceMediaId?: number
}

export interface PhotoSourceChecks {
  readonly exists: boolean
  readonly owner: boolean
  readonly dims: boolean
  readonly unreferenced: boolean
}

export type PhotoSourceBackfillOutcome =
  | 'backfilled'
  | 'would-backfill'
  | 'refused'
  /** Every check passed but the write did not read back. */
  | 'failed'
  | 'already-set'

export interface PhotoSourceBackfillEntry {
  readonly sampleId: string
  readonly identityId: string
  readonly candidate: number | null
  readonly checks: PhotoSourceChecks | null
  readonly outcome: PhotoSourceBackfillOutcome
}

export interface PhotoSourceBackfillResult {
  readonly dryRun: boolean
  readonly backfilled: number
  readonly wouldBackfill: number
  readonly refused: number
  readonly failed: number
  readonly alreadySet: number
  readonly samples: readonly PhotoSourceBackfillEntry[]
}

export interface PhotoSourceBackfillOptions {
  readonly dryRun?: boolean
}

export interface PhotoSourceBackfillDeps {
  listPhotoSamples(): Promise<readonly PhotoSourceBackfillSample[]>
  /** EVERY sample's media ids, any provenance, any identity. */
  listSampleMediaRefs(): Promise<readonly SampleMediaRefs[]>
  /** Who owns a media row; null when there is no such row. */
  mediaOwner(mediaId: number): Promise<MediaOwnerRef | null>
  /** A media row's bytes; null when the row or its blob is missing. */
  mediaBytes(mediaId: number): Promise<Buffer | null>
  writeSourceMediaId(sampleId: string, sourceMediaId: number): Promise<void>
  readSourceMediaId(sampleId: string): Promise<number | null>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isFullPhoto(bytes: Buffer | null): boolean {
  if (bytes === null) return false
  const size = readJpegSize(bytes)
  return (
    size !== null &&
    size.width > PHOTO_SOURCE_MIN_SIDE_EXCLUSIVE &&
    size.height > PHOTO_SOURCE_MIN_SIDE_EXCLUSIVE
  )
}

/** Every media id some OTHER sample names. */
function referencedBy(refs: readonly SampleMediaRefs[], exceptSampleId: string): Set<number> {
  const out = new Set<number>()
  for (const r of refs) {
    if (r.sampleId === exceptSampleId) continue
    if (r.mediaId !== undefined) out.add(r.mediaId)
    if (r.sourceMediaId !== undefined) out.add(r.sourceMediaId)
  }
  return out
}

async function evaluate(
  deps: PhotoSourceBackfillDeps,
  sample: PhotoSourceBackfillSample,
  candidate: number,
  claimedElsewhere: ReadonlySet<number>,
): Promise<PhotoSourceChecks> {
  const [owner, bytes] = await Promise.all([deps.mediaOwner(candidate), deps.mediaBytes(candidate)])
  return {
    exists: owner !== null && bytes !== null,
    owner: owner !== null && owner.ownerKind === 'identity' && owner.ownerId === sample.identityId,
    dims: isFullPhoto(bytes),
    unreferenced: !claimedElsewhere.has(candidate),
  }
}

function allPass(checks: PhotoSourceChecks): boolean {
  return checks.exists && checks.owner && checks.dims && checks.unreferenced
}

/** Write, then read back. True only when the column now holds the candidate. */
async function writeVerified(
  deps: PhotoSourceBackfillDeps,
  sample: PhotoSourceBackfillSample,
  candidate: number,
): Promise<boolean> {
  const meta = {
    sampleId: sample.sampleId,
    identityId: sample.identityId,
    sourceMediaId: candidate,
  }
  try {
    await deps.writeSourceMediaId(sample.sampleId, candidate)
    const readBack = await deps.readSourceMediaId(sample.sampleId)
    if (readBack === candidate) {
      deps.logger.info('photo source backfill: sourceMediaId written and read back', { meta })
      return true
    }
    deps.logger.warn('photo source backfill: the write did NOT read back — not counted', {
      meta: { ...meta, readBack },
    })
    return false
  } catch (err: unknown) {
    deps.logger.warn('photo source backfill: write failed', {
      meta: { ...meta, error: errorMessage(err) },
    })
    return false
  }
}

async function backfillOne(
  deps: PhotoSourceBackfillDeps,
  sample: PhotoSourceBackfillSample,
  refs: readonly SampleMediaRefs[],
  claimedThisRun: ReadonlySet<number>,
  dryRun: boolean,
): Promise<PhotoSourceBackfillEntry> {
  const base = { sampleId: sample.sampleId, identityId: sample.identityId }
  if (sample.sourceMediaId !== undefined) {
    return { ...base, candidate: null, checks: null, outcome: 'already-set' }
  }
  if (sample.mediaId === undefined) {
    deps.logger.warn(
      'photo source backfill: REFUSED — the sample has no template id to derive from',
      {
        meta: { ...base, dryRun },
      },
    )
    return { ...base, candidate: null, checks: null, outcome: 'refused' }
  }
  const candidate = sample.mediaId + 1
  const claimed = new Set([...referencedBy(refs, sample.sampleId), ...claimedThisRun])
  const checks = await evaluate(deps, sample, candidate, claimed)
  if (!allPass(checks)) {
    deps.logger.warn('photo source backfill: REFUSED — a check failed, nothing written', {
      meta: { ...base, candidate, ...checks, dryRun },
    })
    return { ...base, candidate, checks, outcome: 'refused' }
  }
  if (dryRun) {
    deps.logger.info('photo source backfill (DRY RUN): would write', {
      meta: { ...base, candidate },
    })
    return { ...base, candidate, checks, outcome: 'would-backfill' }
  }
  const landed = await writeVerified(deps, sample, candidate)
  return { ...base, candidate, checks, outcome: landed ? 'backfilled' : 'failed' }
}

export async function backfillPhotoSources(
  deps: PhotoSourceBackfillDeps,
  options: PhotoSourceBackfillOptions,
): Promise<PhotoSourceBackfillResult> {
  const dryRun = options.dryRun === true
  const samples = await deps.listPhotoSamples()
  const refs = await deps.listSampleMediaRefs()
  const claimedThisRun = new Set<number>()
  const entries: PhotoSourceBackfillEntry[] = []
  for (const sample of samples) {
    const entry = await backfillOne(deps, sample, refs, claimedThisRun, dryRun)
    // A candidate this run wrote — or would write — is claimed for the rest of it.
    if (
      entry.candidate !== null &&
      (entry.outcome === 'backfilled' || entry.outcome === 'would-backfill')
    ) {
      claimedThisRun.add(entry.candidate)
    }
    entries.push(entry)
  }
  const count = (o: PhotoSourceBackfillOutcome): number =>
    entries.filter((e) => e.outcome === o).length
  const result: PhotoSourceBackfillResult = {
    dryRun,
    backfilled: count('backfilled'),
    wouldBackfill: count('would-backfill'),
    refused: count('refused'),
    failed: count('failed'),
    alreadySet: count('already-set'),
    samples: entries,
  }
  const { samples: _entries, ...summary } = result
  deps.logger.info('photo source backfill finished', { meta: { ...summary } })
  return result
}
