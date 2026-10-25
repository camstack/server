/**
 * Prune old-aligned DETECTED samples once an identity has enough new ones
 * (D643, operator decision 2026-09-26: 10).
 *
 * ## Why it waits
 *
 * The SCRFD fix moved every aligned template. Measured the same day, a
 * new-aligned camera face checked against today's (old-aligned) gallery
 * auto-matches ~10 points less often — and the old samples are what bounds
 * that drop. So nothing old is removed until the identity has
 * {@link DEFAULT_PRUNE_MIN_V2_DETECTED} new-aligned DETECTED samples to stand
 * on. Photo samples are never pruned here: the photo re-enrol pass
 * (`face-photo-reenrol-pass.ts`) replaces them from their originals, and a
 * v2 PHOTO sample does not count toward the threshold — the photo↔camera
 * domain gap (~0.2 cosine) means it cannot carry camera matching.
 *
 * ## Why it reads twice
 *
 * This is a destructive decision taken off a read. A read that failed changes
 * nothing; a plan is only executed where a SECOND read agrees with it, and only
 * for the samples both reads condemn (D49 — a read contradicting the mirror in
 * the direction that destroys work needs a second read to agree). And whatever
 * the threshold says, an identity is never left with zero samples.
 *
 * Pure and deps-injected; the addon supplies the stores and the cadence.
 */
import type { IScopedLogger } from '@camstack/types'
import { type FaceAlignmentVersion, isV2Aligned } from './face-alignment-version.js'

/** Operator decision (2026-09-26): prune once an identity has 10 v2 detected samples. */
export const DEFAULT_PRUNE_MIN_V2_DETECTED = 10

/** Hourly: the threshold is crossed by operator assignments, never by the second. */
export const FACE_GALLERY_PRUNE_INTERVAL_MS = 60 * 60 * 1000

/** The slice of a sample the prune reads. */
export interface PruneSample {
  readonly id: string
  readonly source: 'detected' | 'photo'
  readonly deviceId?: number
  readonly alignment?: FaceAlignmentVersion
}

export interface PrunePlan {
  /** Sample ids to remove: v1 DETECTED only. */
  readonly remove: readonly string[]
  readonly v1Detected: number
  readonly v2Detected: number
  readonly v1Photo: number
}

/**
 * Which samples of ONE identity may go. Pure.
 *
 * `minV2Detected` is a parameter only so the last-sample guard can be exercised
 * on its own; the addon always passes the operator's number.
 */
export function planV1DetectedPrune(
  samples: readonly PruneSample[],
  minV2Detected: number = DEFAULT_PRUNE_MIN_V2_DETECTED,
): PrunePlan {
  const v1Detected = samples.filter((s) => s.source === 'detected' && !isV2Aligned(s))
  const v2Detected = samples.filter((s) => s.source === 'detected' && isV2Aligned(s)).length
  const v1Photo = samples.filter((s) => s.source === 'photo' && !isV2Aligned(s)).length
  const counts = { v1Detected: v1Detected.length, v2Detected, v1Photo }
  if (v2Detected < minV2Detected || v1Detected.length === 0) return { remove: [], ...counts }
  // Never the last sample: an identity with no samples is a person the matcher
  // can no longer recognise at all, which no alignment gain is worth.
  const keepOne = samples.length - v1Detected.length === 0
  const remove = (keepOne ? v1Detected.slice(1) : v1Detected).map((s) => s.id)
  return { remove, ...counts }
}

/** Per identity, what the prune found and did. */
export interface PruneIdentityReport {
  readonly identityId: string
  readonly name: string
  readonly removed: number
  /** v1 detected samples LEFT after this run. */
  readonly v1Detected: number
  readonly v2Detected: number
  readonly v1Photo: number
}

export interface PruneResult {
  readonly byIdentity: readonly PruneIdentityReport[]
  readonly removed: number
}

export interface PruneIdentity {
  readonly id: string
  readonly name: string
}

export interface GalleryPruneDeps {
  listIdentities(): Promise<readonly PruneIdentity[]>
  listSamples(identityId: string): Promise<readonly PruneSample[]>
  /** Removes the row, its vector and its template blob. */
  removeSample(identityId: string, sampleId: string): Promise<void>
  refreshGallery(): void
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

export interface PruneOptions {
  /** Narrow to one identity — the after-enrol trigger. Omit for all. */
  readonly identityId?: string
  readonly minV2Detected?: number
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Read one identity's samples; a failure is logged and answered with null. */
async function readSamples(
  deps: GalleryPruneDeps,
  identity: PruneIdentity,
  which: 'plan' | 'confirm',
): Promise<readonly PruneSample[] | null> {
  try {
    return await deps.listSamples(identity.id)
  } catch (err: unknown) {
    deps.logger.warn('face gallery prune: sample read failed — this identity is left untouched', {
      meta: {
        identityId: identity.id,
        identity: identity.name,
        read: which,
        error: errorMessage(err),
      },
    })
    return null
  }
}

async function pruneIdentity(
  deps: GalleryPruneDeps,
  identity: PruneIdentity,
  minV2Detected: number,
): Promise<PruneIdentityReport | null> {
  const first = await readSamples(deps, identity, 'plan')
  if (first === null) return null
  const plan = planV1DetectedPrune(first, minV2Detected)
  const report = (removed: number): PruneIdentityReport => ({
    identityId: identity.id,
    name: identity.name,
    removed,
    v1Detected: plan.v1Detected - removed,
    v2Detected: plan.v2Detected,
    v1Photo: plan.v1Photo,
  })
  if (plan.remove.length === 0) return report(0)

  const second = await readSamples(deps, identity, 'confirm')
  if (second === null) return report(0)
  const confirmed = new Set(planV1DetectedPrune(second, minV2Detected).remove)
  const agreed = plan.remove.filter((id) => confirmed.has(id))
  if (agreed.length < plan.remove.length) {
    deps.logger.warn(
      'face gallery prune: the confirm read disagreed — only what both reads condemn goes',
      {
        meta: {
          identityId: identity.id,
          identity: identity.name,
          planned: plan.remove.length,
          confirmed: agreed.length,
        },
      },
    )
  }

  const byId = new Map(first.map((s) => [s.id, s]))
  let removed = 0
  for (const sampleId of agreed) {
    const deviceId = byId.get(sampleId)?.deviceId
    const tags = deviceId !== undefined ? { deviceId } : {}
    try {
      await deps.removeSample(identity.id, sampleId)
      removed += 1
      deps.logger.info('face gallery prune: removed an old-aligned detected sample', {
        tags,
        meta: { identityId: identity.id, identity: identity.name, sampleId },
      })
    } catch (err: unknown) {
      deps.logger.warn('face gallery prune: sample removal failed — it stays', {
        tags,
        meta: {
          identityId: identity.id,
          identity: identity.name,
          sampleId,
          error: errorMessage(err),
        },
      })
    }
  }
  return report(removed)
}

/**
 * Remove v1 DETECTED samples from every identity (or one) that has reached the
 * v2 threshold. Logs one summary line per identity, including the ones it left
 * alone — "v1 left, v2 count" is the number the operator watches.
 */
export async function pruneV1DetectedSamples(
  deps: GalleryPruneDeps,
  options: PruneOptions,
): Promise<PruneResult> {
  const minV2Detected = options.minV2Detected ?? DEFAULT_PRUNE_MIN_V2_DETECTED
  let identities: readonly PruneIdentity[]
  try {
    identities = await deps.listIdentities()
  } catch (err: unknown) {
    deps.logger.warn('face gallery prune: identity read failed — nothing was pruned', {
      meta: { error: errorMessage(err), identityId: options.identityId ?? null },
    })
    return { byIdentity: [], removed: 0 }
  }
  const scope =
    options.identityId === undefined
      ? identities
      : identities.filter((i) => i.id === options.identityId)

  const byIdentity: PruneIdentityReport[] = []
  for (const identity of scope) {
    const report = await pruneIdentity(deps, identity, minV2Detected)
    if (report === null) continue
    byIdentity.push(report)
    deps.logger.info('face gallery prune: identity standing', {
      meta: { ...report, minV2Detected },
    })
  }
  const removed = byIdentity.reduce((n, r) => n + r.removed, 0)
  if (removed > 0) deps.refreshGallery()
  return { byIdentity, removed }
}
