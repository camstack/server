/**
 * Reset the face gallery to a CORE of the best samples per identity (D644).
 *
 * The operator's decision of 2026-09-26: "cancelliamo e ripartiamo, tieni 3
 * esemplari migliori per soggetto … discard tutto il resto anche quelle
 * pending" [let us delete and restart, keep the 3 best exemplars per subject … discard everything else, including the pending ones]. The gallery after D643 is two alignments mixed, 518 detected
 * samples of which none can be re-derived; starting again from a small, clean
 * core is cheaper than pruning it into shape.
 *
 * ## The selection rule
 *
 * Per identity, exactly `keepPerIdentity` samples when it has that many:
 * photo v2, then detected v2, then photo v1, then detected v1. Inside a tier
 * the sample closest to the identity's CENTROID wins — the mean of its current
 * vectors in its dominant model space — because the most representative
 * sample is the one least likely to be an outlier crop. A sample from another
 * model space, or with no vector, ranks last in its tier: it cannot be
 * measured, so it cannot be called representative.
 *
 * ## Re-aligning a v1 detected pick — OFF unless asked
 *
 * A detected v1 sample keeps only its 112×112 template. `realign` re-runs the
 * fixed detector on it (upscaled and letterboxed) and embeds the new
 * alignment. Measured on the live hub (D644): against the TRUE new-aligned
 * embedding of the same frame, the re-aligned template scores cosine 0.83 on
 * average (0.76–0.89, 8 same-instant pairs) where the untouched v1 template
 * scores 0.65. Better than keeping it, and still under the 0.85 the operator
 * set as "good". So the default keeps the v1 representatives AS THEY ARE, and
 * re-alignment runs only with `realignDetected: true`.
 *
 * ## Order, and D49
 *
 * Per identity: every replacement is written and ADDED first, and read back
 * (`sampleExists`) — a second read that must agree before anything of that
 * identity is removed. A replacement that failed or did not read back leaves
 * its old sample in the keep set, as it is. The kept set is read back too; an
 * identity whose kept set does not read back at all is SKIPPED, so no identity
 * can end with zero samples. Only then are the other samples removed, through
 * the operator's Remove path (row, vector, blobs, and the buffered faces that
 * named them are detached, never deleted). The reset never removes a row it
 * added itself.
 *
 * ## Pending faces
 *
 * The buffered faces nobody has named — unassigned, with or without a
 * suggestion — are deleted with their media. Faces carrying an identity
 * (assigned, or auto-recognised onto a track) are history and stay.
 *
 * `dryRun` analyses and chooses exactly as a real run (re-alignment included,
 * when asked) and writes nothing.
 */
import { cosineSimilarity, type IScopedLogger } from '@camstack/types'
import {
  FACE_ALIGNMENT_SCRFD_V2,
  type FaceAlignmentVersion,
  isV2Aligned,
} from './face-alignment-version.js'

/** The operator's number. */
export const DEFAULT_KEEP_PER_IDENTITY = 3

/** One sample as the reset sees it — metadata, never the vector. */
export interface ResetSample {
  readonly sampleId: string
  readonly identityId: string
  readonly source: 'photo' | 'detected'
  readonly modelId: string
  readonly mediaId?: number
  readonly deviceId?: number
  readonly addedAt: number
  readonly alignment?: FaceAlignmentVersion
  /** Set on a re-aligned replacement: the v1 sample it replaces (crash recovery). */
  readonly replacesSampleId?: string
}

/** Which preference tier a pick came from. */
export type CoreTier = 'photo-v2' | 'detected-v2' | 'photo-v1' | 'detected-v1'

/** Why a sample is in the core after the run. */
export type CoreKeepReason = 'photo-v2' | 'detected-v2' | 'photo-v1' | 'realigned' | 'kept-as-is'

export interface CorePick {
  readonly sample: ResetSample
  readonly tier: CoreTier
  /** Cosine to the identity centroid; null when the sample cannot be measured. */
  readonly centroidCosine: number | null
}

/** What `realign` concluded about one v1 detected template. */
export type RealignVerdict =
  | {
      readonly kind: 'realigned'
      readonly embedding: readonly number[]
      readonly modelId: string
      readonly templateJpeg: Buffer
      readonly cosineToOld: number
      readonly score: number
    }
  | { readonly kind: 'refused'; readonly reason: string }

/** The replacement row a re-alignment writes. */
export interface ResetAddSampleInput {
  readonly identityId: string
  readonly embedding: readonly number[]
  readonly modelId: string
  readonly source: 'detected'
  readonly mediaId: number
  readonly deviceId?: number
  readonly alignment: FaceAlignmentVersion
  /** The v1 sample this row replaces — what lets a rerun finish instead of redo. */
  readonly replacesSampleId: string
}

/** The row a replacement wrote. */
export interface ResetAddedSample {
  readonly id: string
}

/** What happened to the pending faces. */
export interface PendingFacesOutcome {
  readonly found: number
  readonly deleted: number
}

/** A buffered face nobody has named. */
export interface PendingFaceRef {
  readonly faceId: string
  readonly deviceId: number
}

export interface ResetIdentityRef {
  readonly id: string
  readonly name: string
}

export interface GalleryResetDeps {
  listIdentities(): Promise<readonly ResetIdentityRef[]>
  listSamples(identityId: string): Promise<readonly ResetSample[]>
  loadVectors(sampleIds: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>>
  /** Re-run the FIXED alignment over a stored template. Compute only; may throw. */
  realign(sample: ResetSample, oldVector: readonly number[]): Promise<RealignVerdict>
  putTemplate(sample: ResetSample, templateJpeg: Buffer): Promise<number>
  deleteMedia(mediaId: number): Promise<void>
  addSample(input: ResetAddSampleInput): Promise<ResetAddedSample>
  sampleExists(sampleId: string): Promise<boolean>
  /** The operator's Remove: row, vector, blobs; detaches the faces naming it. */
  removeSample(identityId: string, sampleId: string): Promise<void>
  listPendingFaces(): Promise<readonly PendingFaceRef[]>
  /** Delete these faces with their media; returns how many went. */
  deleteFaces(faces: readonly PendingFaceRef[]): Promise<number>
  refreshGallery(): Promise<void>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

export interface GalleryResetOptions {
  readonly dryRun?: boolean
  readonly keepPerIdentity?: number
  /** Re-align v1 detected picks from their template. Off by default (see docblock). */
  readonly realignDetected?: boolean
}

/** One sample that stays. */
export interface ResetKeptEntry {
  /** The row that stands after the run — the NEW id for a re-aligned pick. */
  readonly sampleId: string
  readonly reason: CoreKeepReason
  readonly tier: CoreTier
  readonly centroidCosine: number | null
  /** The v1 row a re-aligned pick replaces. */
  readonly replacesSampleId?: string
  readonly realign?: { readonly cosineToOld: number; readonly score: number }
  /** Why a v1 pick was kept as it is when re-alignment was asked for. */
  readonly keptAsIsBecause?: string
}

export interface ResetIdentityReport {
  readonly identityId: string
  readonly name: string
  readonly before: number
  readonly kept: readonly ResetKeptEntry[]
  readonly removed: number
  readonly wouldRemove: number
  readonly failedRemovals: number
  /** Set when nothing of this identity was removed, and why. */
  readonly skipped?: string
}

export interface GalleryResetResult {
  readonly dryRun: boolean
  readonly keepPerIdentity: number
  readonly realignDetected: boolean
  readonly identities: readonly ResetIdentityReport[]
  readonly pendingFaces: PendingFacesOutcome
  readonly totals: {
    readonly before: number
    readonly kept: number
    readonly removed: number
    readonly wouldRemove: number
    readonly failedRemovals: number
  }
}

const TIER_ORDER: readonly CoreTier[] = ['photo-v2', 'detected-v2', 'photo-v1', 'detected-v1']

function tierOf(sample: ResetSample): CoreTier {
  const v2 = isV2Aligned(sample)
  if (sample.source === 'photo') return v2 ? 'photo-v2' : 'photo-v1'
  return v2 ? 'detected-v2' : 'detected-v1'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The model space most of the identity's measurable samples live in. */
function dominantModel(
  samples: readonly ResetSample[],
  vectors: ReadonlyMap<string, readonly number[]>,
): string | null {
  const counts = new Map<string, number>()
  for (const s of samples) {
    if (!vectors.has(s.sampleId)) continue
    counts.set(s.modelId, (counts.get(s.modelId) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model
      bestCount = count
    }
  }
  return best
}

/** Mean of the comparable vectors (unnormalised — cosine does not care). */
function centroidOf(vectors: readonly (readonly number[])[]): Float32Array | null {
  const first = vectors[0]
  if (first === undefined) return null
  const sum = new Float32Array(first.length)
  for (const v of vectors) {
    if (v.length !== first.length) continue
    for (let i = 0; i < v.length; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0)
  }
  return sum
}

/**
 * The core of one identity: at most `keep` picks, in preference order. Pure.
 */
export function selectCoreSamples(
  samples: readonly ResetSample[],
  vectors: ReadonlyMap<string, readonly number[]>,
  keep: number,
): readonly CorePick[] {
  const model = dominantModel(samples, vectors)
  const comparable = (s: ResetSample): readonly number[] | undefined =>
    s.modelId === model ? vectors.get(s.sampleId) : undefined
  const centroid = centroidOf(
    samples.flatMap((s) => {
      const v = comparable(s)
      return v === undefined ? [] : [v]
    }),
  )
  const scored: CorePick[] = samples.map((sample) => {
    const v = comparable(sample)
    const centroidCosine =
      v === undefined || centroid === null || v.length !== centroid.length
        ? null
        : cosineSimilarity(new Float32Array(v), centroid)
    return { sample, tier: tierOf(sample), centroidCosine }
  })
  const rank = (p: CorePick): number => p.centroidCosine ?? Number.NEGATIVE_INFINITY
  const ordered = scored.toSorted((a, b) => {
    const byTier = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
    if (byTier !== 0) return byTier
    const byRank = rank(b) - rank(a)
    if (byRank !== 0) return byRank
    // Deterministic among equals: the newer sample first.
    return b.sample.addedAt - a.sample.addedAt
  })
  return ordered.slice(0, Math.max(0, keep))
}

/** A pick as the run settles it, before the read-back. */
interface SettledPick {
  readonly pick: CorePick
  readonly entry: ResetKeptEntry
}

function keptAsIs(pick: CorePick, because?: string): SettledPick {
  const replaces = pick.sample.replacesSampleId
  if (replaces !== undefined) {
    // A replacement an earlier (interrupted) run already landed: it stands.
    return {
      pick,
      entry: {
        sampleId: pick.sample.sampleId,
        reason: 'realigned',
        tier: pick.tier,
        centroidCosine: pick.centroidCosine,
        replacesSampleId: replaces,
      },
    }
  }
  const reason: CoreKeepReason = pick.tier === 'detected-v1' ? 'kept-as-is' : pick.tier
  return {
    pick,
    entry: {
      sampleId: pick.sample.sampleId,
      reason,
      tier: pick.tier,
      centroidCosine: pick.centroidCosine,
      ...(because !== undefined ? { keptAsIsBecause: because } : {}),
    },
  }
}

interface RealignContext {
  readonly deps: GalleryResetDeps
  readonly dryRun: boolean
  readonly vectors: ReadonlyMap<string, readonly number[]>
}

function sampleMeta(sample: ResetSample): Record<string, unknown> {
  return { identityId: sample.identityId, sampleId: sample.sampleId }
}

/** Log a v1 pick that stays as it is, with its reason, and settle it. */
function keepLogged(ctx: RealignContext, pick: CorePick, because: string): SettledPick {
  ctx.deps.logger.warn('face gallery reset: re-alignment REFUSED — the sample is kept as it is', {
    ...(pick.sample.deviceId !== undefined ? { tags: { deviceId: pick.sample.deviceId } } : {}),
    meta: { ...sampleMeta(pick.sample), because, dryRun: ctx.dryRun },
  })
  return keptAsIs(pick, because)
}

/** Write the replacement: template, row, then a read-back that must agree. */
async function writeReplacement(
  ctx: RealignContext,
  pick: CorePick,
  verdict: Extract<RealignVerdict, { kind: 'realigned' }>,
): Promise<string | null> {
  const { deps } = ctx
  const s = pick.sample
  let mediaId: number
  try {
    mediaId = await deps.putTemplate(s, verdict.templateJpeg)
  } catch (err: unknown) {
    deps.logger.warn('face gallery reset: the replacement template could not be written', {
      ...(s.deviceId !== undefined ? { tags: { deviceId: s.deviceId } } : {}),
      meta: { ...sampleMeta(s), error: errorMessage(err) },
    })
    return null
  }
  let newId: string | null = null
  try {
    newId = (
      await deps.addSample({
        identityId: s.identityId,
        embedding: verdict.embedding,
        modelId: verdict.modelId,
        source: 'detected',
        mediaId,
        ...(s.deviceId !== undefined ? { deviceId: s.deviceId } : {}),
        alignment: FACE_ALIGNMENT_SCRFD_V2,
        replacesSampleId: s.sampleId,
      })
    ).id
  } catch (err: unknown) {
    deps.logger.warn('face gallery reset: addSample threw', {
      meta: { ...sampleMeta(s), mediaId, error: errorMessage(err) },
    })
  }
  const landed = newId !== null && (await deps.sampleExists(newId).catch(() => false))
  if (landed) return newId
  // Absent on read-back: the blob would be named by nothing, and an
  // identity-owned blob is exempt from every sweep.
  await deps.deleteMedia(mediaId).catch((err: unknown) => {
    deps.logger.warn('face gallery reset: could not reclaim the replacement template', {
      meta: { ...sampleMeta(s), mediaId, error: errorMessage(err) },
    })
  })
  return null
}

async function settleV1Detected(ctx: RealignContext, pick: CorePick): Promise<SettledPick> {
  const oldVector = ctx.vectors.get(pick.sample.sampleId)
  if (oldVector === undefined) return keepLogged(ctx, pick, 'no-old-vector')
  let verdict: RealignVerdict
  try {
    verdict = await ctx.deps.realign(pick.sample, oldVector)
  } catch (err: unknown) {
    return keepLogged(ctx, pick, `realign failed: ${errorMessage(err)}`)
  }
  if (verdict.kind === 'refused') return keepLogged(ctx, pick, verdict.reason)
  const realign = { cosineToOld: verdict.cosineToOld, score: verdict.score }
  const base = {
    tier: pick.tier,
    centroidCosine: pick.centroidCosine,
    replacesSampleId: pick.sample.sampleId,
    realign,
    reason: 'realigned' as const,
  }
  if (ctx.dryRun) return { pick, entry: { ...base, sampleId: pick.sample.sampleId } }
  const newId = await writeReplacement(ctx, pick, verdict)
  if (newId === null) return keepLogged(ctx, pick, 'the replacement did not read back')
  ctx.deps.logger.info('face gallery reset: re-aligned replacement enrolled', {
    ...(pick.sample.deviceId !== undefined ? { tags: { deviceId: pick.sample.deviceId } } : {}),
    meta: { ...sampleMeta(pick.sample), newSampleId: newId, ...realign },
  })
  return { pick, entry: { ...base, sampleId: newId } }
}

async function settlePicks(
  ctx: RealignContext,
  picks: readonly CorePick[],
  realignDetected: boolean,
): Promise<readonly SettledPick[]> {
  const settled: SettledPick[] = []
  for (const pick of picks) {
    settled.push(
      pick.tier === 'detected-v1' && realignDetected
        ? await settleV1Detected(ctx, pick)
        : keptAsIs(pick),
    )
  }
  return settled
}

/** The second read: only kept rows that are really there count. */
async function verifyKept(
  deps: GalleryResetDeps,
  settled: readonly SettledPick[],
): Promise<readonly ResetKeptEntry[]> {
  const verified: ResetKeptEntry[] = []
  for (const s of settled) {
    if (await deps.sampleExists(s.entry.sampleId).catch(() => false)) verified.push(s.entry)
  }
  return verified
}

async function removeRest(
  deps: GalleryResetDeps,
  identityId: string,
  targets: readonly ResetSample[],
): Promise<RemovalTally> {
  let removed = 0
  let failed = 0
  for (const s of targets) {
    try {
      await deps.removeSample(identityId, s.sampleId)
      removed += 1
    } catch (err: unknown) {
      failed += 1
      deps.logger.warn('face gallery reset: a sample would not go — it stays', {
        ...(s.deviceId !== undefined ? { tags: { deviceId: s.deviceId } } : {}),
        meta: { ...sampleMeta(s), error: errorMessage(err) },
      })
    }
  }
  return { removed, failed }
}

interface RemovalTally {
  readonly removed: number
  readonly failed: number
}

interface IdentityRunInput {
  readonly identity: ResetIdentityRef
  readonly keep: number
  readonly dryRun: boolean
  readonly realignDetected: boolean
}

async function resetIdentity(
  deps: GalleryResetDeps,
  input: IdentityRunInput,
): Promise<ResetIdentityReport> {
  const { identity, keep, dryRun } = input
  const samples = await deps.listSamples(identity.id)
  const vectors = await deps.loadVectors(samples.map((s) => s.sampleId))
  // Crash recovery: a v1 sample whose replacement already landed is never a
  // pick again (it would be re-aligned twice) — it is only removed.
  const superseded = new Set(
    samples.flatMap((s) => (s.replacesSampleId !== undefined ? [s.replacesSampleId] : [])),
  )
  const candidates = samples.filter((s) => !superseded.has(s.sampleId))
  const picks = selectCoreSamples(candidates, vectors, keep)
  const settled = await settlePicks({ deps, dryRun, vectors }, picks, input.realignDetected)
  const keepIds = new Set(settled.map((s) => s.entry.sampleId))
  // A re-aligned pick's OLD row is NOT kept: its replacement stands instead.
  const targets = samples.filter((s) => !keepIds.has(s.sampleId))
  const base = { identityId: identity.id, name: identity.name, before: samples.length }
  if (dryRun) {
    return {
      ...base,
      kept: settled.map((s) => s.entry),
      removed: 0,
      wouldRemove: targets.length,
      failedRemovals: 0,
    }
  }
  const kept = await verifyKept(deps, settled)
  if (kept.length === 0 && samples.length > 0) {
    const skipped = 'no kept sample read back — nothing of this identity was removed'
    deps.logger.warn(`face gallery reset: identity SKIPPED — ${skipped}`, {
      meta: { identityId: identity.id, name: identity.name, before: samples.length },
    })
    return { ...base, kept, removed: 0, wouldRemove: 0, failedRemovals: 0, skipped }
  }
  const verifiedIds = new Set(kept.map((k) => k.sampleId))
  // A pick whose row did not read back is not removed either: it is not
  // verified present, and removing it would only make the count less true.
  const removable = targets.filter((s) => !verifiedIds.has(s.sampleId))
  const { removed, failed } = await removeRest(deps, identity.id, removable)
  deps.logger.info('face gallery reset: identity done', {
    meta: {
      identityId: identity.id,
      name: identity.name,
      before: samples.length,
      kept: kept.map((k) => `${k.sampleId}:${k.reason}`),
      removed,
      failedRemovals: failed,
    },
  })
  return { ...base, kept, removed, wouldRemove: 0, failedRemovals: failed }
}

async function resetPending(deps: GalleryResetDeps, dryRun: boolean): Promise<PendingFacesOutcome> {
  const pending = await deps.listPendingFaces()
  if (dryRun || pending.length === 0) return { found: pending.length, deleted: 0 }
  const deleted = await deps.deleteFaces(pending)
  return { found: pending.length, deleted }
}

function totalsOf(identities: readonly ResetIdentityReport[]): GalleryResetResult['totals'] {
  const sum = (f: (r: ResetIdentityReport) => number): number =>
    identities.reduce((acc, r) => acc + f(r), 0)
  return {
    before: sum((r) => r.before),
    kept: sum((r) => r.kept.length),
    removed: sum((r) => r.removed),
    wouldRemove: sum((r) => r.wouldRemove),
    failedRemovals: sum((r) => r.failedRemovals),
  }
}

/** Run the reset. See the module docblock for the order and why it is safe. */
export async function resetGalleryToCore(
  deps: GalleryResetDeps,
  options: GalleryResetOptions,
): Promise<GalleryResetResult> {
  const dryRun = options.dryRun === true
  const keep = options.keepPerIdentity ?? DEFAULT_KEEP_PER_IDENTITY
  const realignDetected = options.realignDetected === true
  deps.logger.info('face gallery reset starting', { meta: { dryRun, keep, realignDetected } })
  const identities: ResetIdentityReport[] = []
  let pendingFaces: PendingFacesOutcome
  try {
    for (const identity of await deps.listIdentities()) {
      identities.push(await resetIdentity(deps, { identity, keep, dryRun, realignDetected }))
    }
    pendingFaces = await resetPending(deps, dryRun)
  } finally {
    // Whatever landed before a throw is live in the stores; the matcher must
    // see it, or it keeps matching against removed samples until the next
    // enrol.
    if (!dryRun) {
      await deps.refreshGallery().catch((err: unknown) => {
        deps.logger.warn('face gallery reset: gallery refresh failed', {
          meta: { error: errorMessage(err) },
        })
      })
    }
  }
  const result: GalleryResetResult = {
    dryRun,
    keepPerIdentity: keep,
    realignDetected,
    identities,
    pendingFaces,
    totals: totalsOf(identities),
  }
  deps.logger.info('face gallery reset finished', {
    meta: { dryRun, ...result.totals, pendingFaces },
  })
  return result
}
