/**
 * The one-shot 4g migration: pre-tier `label` values → the tiered slots.
 *
 * Before 4g there was ONE label column and it held the finest thing known —
 * a species, an identity, a plate read, sometimes a raw detector sub-class,
 * and (five known live rows) a MACRO class that regressed a person track to
 * `animal`. After 4g `label` is tier 1 (the sub-class) and `subLabel` is tier 2
 * (the instance), so every one of those values is now in a column whose meaning
 * has changed underneath it.
 *
 * **Two rules, and it does not guess beyond them.**
 *
 * 1. A value that IS a macro class is a proven tier collapse — the 2026-08-07
 *    rule refuses it at write time and it should never have been on the row.
 *    It is CLEARED.
 * 2. Every other value moves to TIER 2, attributed to {@link MIGRATION_STEP_ID}.
 *
 * Rule 2 is asymmetric on purpose. Nothing recorded which step decided a
 * pre-4g label, so its true tier is unknowable from the row — and the two
 * possible mistakes are not equally bad:
 *
 *  - Moving a genuine tier-1 value (`dog`) DOWN into tier 2 costs nothing that
 *    matters: the display value is `subLabel ?? label`, so the row reads
 *    exactly as it did, and the empty tier-1 slot is still available to the
 *    sub-class classifier.
 *  - Moving a genuine tier-2 value (`Turdus migratorius`) UP into tier 1 would
 *    park a species in the coarse slot AND block the `bird` that belongs
 *    there — recreating, permanently, the exact defect 4g exists to fix.
 *
 * And the migrated value is not permanent: because its attribution is the
 * migration sentinel, the write rule lets ANY properly-attributed write of the
 * same tier replace it outright, score comparison skipped. A camera that keeps
 * seeing the subject heals its own rows.
 *
 * **It is stateless and needs no media, no model and no node.** Unlike the
 * embedding rebuild (D54), which re-runs inference over stored pixels through
 * `runStatelessStep`, this pass answers from the row alone. It reuses the
 * SHAPE of that work — bounded pages, resumable, one collection at a time —
 * and none of its dispatch machinery, because there is nothing to dispatch.
 *
 * **It is idempotent.** A row that already carries a tier is skipped, so a
 * re-run after a crash resumes rather than re-deciding, and the completion
 * marker is an optimisation, not a correctness requirement.
 */

import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { MIGRATION_STEP_ID } from '../pipeline/label-tier.js'
import { isMacroClass } from '../pipeline/label-utils.js'
import type { MigrationMarkerPort } from './migration-marker-store.js'

/** Rows read (and at most rewritten) per page. */
const MIGRATION_PAGE_SIZE = 500

/**
 * Hard bound on rows visited per collection in ONE run. The pass runs at addon
 * initialize; a fleet with a million event rows must not turn a boot into an
 * hour of writes. What is not reached this run is reached the next, because the
 * marker is only set when a collection completes.
 */
const MIGRATION_MAX_ROWS = 200_000

/**
 * The legacy collection of the completion markers — kept for the classification,
 * the adoption mapper and docs. The markers now live in the `migrations` record
 * kind (`MigrationMarkerStore`).
 */
export const MIGRATION_MARKER_COLLECTION = 'pipeline-analytics:migrations'
export const MIGRATION_MARKER_KEY = 'label-tier-4g'

/** What one collection's pass did. */
export interface LabelTierMigrationStats {
  readonly collection: string
  /** Rows examined. */
  readonly scanned: number
  /** Rows whose pre-4g value moved into tier 2. */
  readonly demoted: number
  /** Rows whose value was a macro class and was cleared. */
  readonly cleared: number
  /** Rows already tiered (a resumed run), or carrying no label at all. */
  readonly skipped: number
  /** The bound was hit — another run is needed. */
  readonly truncated: boolean
}

interface MigrationDeps {
  readonly store: SettingsStoreClient
  /** Where the completion marker is read and written. */
  readonly markers: MigrationMarkerPort
  readonly logger: IScopedLogger
  /** Injected so a test can freeze it; the value lands in the attribution. */
  readonly now: () => number
}

/**
 * The decision for ONE row, exposed so the rule is testable without a store.
 *
 * `null` = leave the row alone.
 */
export function decideRowMigration(
  data: Record<string, unknown>,
  now: number,
): Record<string, unknown> | null {
  const label = data['label']
  if (typeof label !== 'string' || label.length === 0) return null
  // Already tiered — either by a post-4g write or by an earlier run of this
  // pass. Both mean the row's tiers are authoritative and must not be re-decided.
  if (typeof data['subLabel'] === 'string' && data['subLabel'].length > 0) return null
  if (data['labelMeta'] !== null && data['labelMeta'] !== undefined) return null
  if (isMacroClass(label)) {
    return { label: null, labelScore: null, labelMeta: null }
  }
  return {
    label: null,
    labelScore: null,
    labelMeta: null,
    subLabel: label,
    // No score: nothing measured this value. Left NULL rather than invented —
    // a fabricated 1.0 would make it unbeatable, a fabricated 0 would read as
    // a real measurement of zero confidence.
    subLabelScore: null,
    subLabelMeta: { stepId: MIGRATION_STEP_ID, decidedAt: now },
  }
}

/** Migrate one collection, paged and bounded. */
async function migrateCollectionLabelTiers(
  deps: MigrationDeps,
  collection: string,
): Promise<LabelTierMigrationStats> {
  let scanned = 0
  let demoted = 0
  let cleared = 0
  let skipped = 0
  let offset = 0
  let truncated = false

  for (;;) {
    if (scanned >= MIGRATION_MAX_ROWS) {
      truncated = true
      break
    }
    const rows = await deps.store.query.query({
      collection,
      filter: { limit: MIGRATION_PAGE_SIZE, offset },
    })
    if (rows.length === 0) break
    for (const row of rows) {
      scanned++
      const patch = decideRowMigration(row.data, deps.now())
      if (patch === null) {
        skipped++
        continue
      }
      try {
        await deps.store.update.mutate({ collection, id: row.id, data: patch })
        if (patch['subLabel'] === undefined) cleared++
        else demoted++
      } catch (err) {
        // A row that fails is left as it was and retried on the next run: the
        // decision is idempotent, so a partial pass is never a wrong pass.
        deps.logger.warn('label tier migration row failed', {
          meta: { collection, id: row.id, error: String(err) },
        })
        skipped++
      }
    }
    if (rows.length < MIGRATION_PAGE_SIZE) break
    offset += rows.length
  }

  return { collection, scanned, demoted, cleared, skipped, truncated }
}

/**
 * Run the migration across the collections that carry the tiered columns, once.
 *
 * The marker short-circuits a completed migration; it is written only when
 * NEITHER collection was truncated, so an interrupted pass resumes on the next
 * boot instead of declaring itself done.
 */
export async function runLabelTierMigration(
  deps: MigrationDeps,
  collections: readonly string[],
): Promise<readonly LabelTierMigrationStats[]> {
  try {
    if (await deps.markers.has(MIGRATION_MARKER_KEY)) return []
  } catch {
    // No marker collection yet — first run. Not an error.
  }

  const stats: LabelTierMigrationStats[] = []
  for (const collection of collections) {
    stats.push(await migrateCollectionLabelTiers(deps, collection))
  }

  const complete = stats.every((s) => !s.truncated)
  if (complete) {
    try {
      await deps.markers.set(MIGRATION_MARKER_KEY, { completedAt: deps.now() })
    } catch (err) {
      // Losing the marker costs a re-scan, never correctness — the row
      // decision is idempotent.
      deps.logger.warn('label tier migration marker failed', { meta: { error: String(err) } })
    }
  }

  for (const s of stats) {
    deps.logger.info('label tier migration', {
      meta: {
        collection: s.collection,
        scanned: s.scanned,
        demoted: s.demoted,
        cleared: s.cleared,
        skipped: s.skipped,
        truncated: s.truncated,
      },
    })
  }
  return stats
}
