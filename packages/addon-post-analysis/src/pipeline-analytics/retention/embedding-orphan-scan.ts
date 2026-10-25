/**
 * The vector-index leg of the orphan audit — the scopes that are not
 * settings-store collections.
 *
 * ONE algorithm, two wirings: the CLIP indexes (`object-clip-<model>`), whose rows are owned by a TRACK,
 * and `face-arcface`, whose rows are owned by a FACE row. The owner is a
 * parameter (`liveOwnerIds`) precisely so the second scope is a wiring and not
 * a second copy of an algorithm that was wrong in three independent ways the
 * first time. What each scope means by "owner" is the load-bearing difference
 * and it is decided by the caller — see `face-vector-orphans.ts` for why
 * guessing it from a face vector's `trackId` metadata would delete the
 * enrolled identities the operator registered by hand.
 *
 * ## Why this is a module and not four lines in `index.ts`
 *
 * Because the four lines it replaces were wrong in three independent ways at
 * once, and none of them was visible from the log line they produced:
 *
 *  1. They enumerated the index by asking for a KNN of
 *     `EMBEDDING_ORPHAN_SCAN_LIMIT` (20,000) against a **zero probe vector**.
 *     sqlite-vec clamps `k` to 4,096 (`VEC_KNN_MAX_K`) and WARNED about it — in
 *     the provider's log, not in its answer — so the audit consumed 4,096 rows
 *     of a 22,128-row index and reported `examined: 4096` as though it had
 *     walked the whole thing. It reported that number every six hours for
 *     weeks. A zero vector also has no direction, so the 4,096 it did see were
 *     not a sample of anything in particular.
 *  2. They built the live-track set by listing up to 20,000 **recent** ids PER
 *     DEVICE and unioning them. A device with more tracks than that limit would
 *     have its oldest tracks silently absent from the set — and absent from
 *     that set is precisely the definition of "orphan". A reclaim keyed off a
 *     truncated liveness list deletes live rows.
 *  3. They had no grace window and no unresolvable class. Every row was either
 *     live or doomed.
 *
 * This walks the index by CURSOR (`vectorStore.scan`, which has no `k` ceiling
 * because it computes no distance), asks liveness **per page** through the same
 * `existingTrackIds` membership probe every other scope uses, and keeps the
 * three protective classes the settings-store engine already has. It is a
 * separate module so those properties are tested rather than asserted in a
 * comment — see `__tests__/embedding-orphan-scan.spec.ts`.
 *
 * ## What it may never do
 *
 * Delete a row whose track still exists. Everything below is arranged so that
 * "I could not find out" and "it is not there" are different answers:
 *
 *  - the probe THROWS on failure and the pass abandons with what it has;
 *  - a row that names no track is `unresolvable`, counted, never touched;
 *  - a row younger than `graceMs` is protected whatever the probe says, because
 *    a vector written milliseconds before its track row lands is not an orphan;
 *  - the reclaim is VERIFIED (`deleteVerified`), so a delete that did nothing
 *    is reported as kept rather than counted as reclaimed.
 */

import type { IScopedLogger } from '@camstack/types'
import type { OrphanAuditMode, OrphanScopeStop } from './orphan-audit.js'

/**
 * One index row, as this scan needs to see it. Each wiring maps its own store's
 * page onto this — the scan never reads a store type, so it cannot inherit one
 * store's idea of who owns a row.
 */
export interface VectorOrphanRow {
  readonly id: string
  /**
   * WHO owns this row, in whatever namespace `liveOwnerIds` probes. `null` when
   * the row names nobody: unresolvable, counted, never deleted.
   */
  readonly ownerId: string | null
  readonly deviceId: number | null
  readonly timestamp: number | null
}

/** One page of a vector index, resumable by offset. */
export interface VectorOrphanScanPage {
  readonly rows: readonly VectorOrphanRow[]
  /** `null` = the walk reached the end. Never inferred from a short page. */
  readonly nextCursor: number | null
}

export interface EmbeddingOrphanScanDeps {
  /** The scope id reported and persisted under. */
  readonly scope: string
  /** One page of index rows, resumed from `cursor`. */
  readonly scanPage: (cursor: number, limit: number) => Promise<VectorOrphanScanPage>
  /**
   * The SUBSET of `ids` whose OWNER row still exists. MUST throw rather than
   * answer partially — the same contract as `OrphanAuditDeps.liveTrackIds`, and
   * for the same reason: a quiet under-report here deletes live rows.
   */
  readonly liveOwnerIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>
  /** Only ever called in `'reclaim'` mode. Returns what is VERIFIABLY gone. */
  readonly reclaim: (
    ids: readonly string[],
  ) => Promise<{ deleted: readonly string[]; stillPresent: readonly string[] }>
  readonly now: () => number
  readonly logger: IScopedLogger
  /** Awaited after every page so a long pass gives hub-main's thread back. */
  readonly breathe?: () => Promise<void>
}

export interface EmbeddingOrphanScanLimits {
  readonly mode: OrphanAuditMode
  /** A row younger than this is never an orphan. Protective only. */
  readonly graceMs: number
  readonly pageSize: number
  /** Rows examined per run — the pacing bound. */
  readonly maxRows: number
  /** Rows reclaimed per run — the blast-radius bound. */
  readonly maxReclaim: number
}

export interface EmbeddingOrphanScanReport {
  readonly scope: string
  readonly examined: number
  readonly orphans: number
  readonly reclaimed: number
  /**
   * Rows whose OWNER is STILL THERE.
   *
   * Reported because the two numbers that matter are not `orphans` and `0` but
   * `orphans` and `kept`: a pass that keeps nothing has either found a truly
   * dead slice of index or lost its liveness probe, and only this counter can
   * tell those apart.
   */
  readonly kept: number
  /** Orphaned by ownership but SAVED by the grace window. */
  readonly withinGrace: number
  /** Rows naming no owner. Counted, never reclaimed. */
  readonly unresolvable: number
  /** Rows the reclaim asked for and the index still holds. */
  readonly notReclaimed: number
  readonly deviceIds: readonly number[]
  readonly stoppedBy: OrphanScopeStop
  /** Where the next run resumes. `0` means the index was walked to the end. */
  readonly nextCursor: number
}

interface ScanTally {
  examined: number
  orphans: number
  reclaimed: number
  kept: number
  withinGrace: number
  unresolvable: number
  notReclaimed: number
}

/**
 * Walk the index once, resuming at `cursor`.
 *
 * Never throws: a probe failure ends the pass with what it has and says which
 * bound stopped it, so a short pass can never be read as a clean one.
 */
export async function scanEmbeddingOrphans(
  deps: EmbeddingOrphanScanDeps,
  limits: EmbeddingOrphanScanLimits,
  cursor: number,
): Promise<EmbeddingOrphanScanReport> {
  const tally: ScanTally = {
    examined: 0,
    orphans: 0,
    reclaimed: 0,
    kept: 0,
    withinGrace: 0,
    unresolvable: 0,
    notReclaimed: 0,
  }
  const deviceIds = new Set<number>()
  const graceFloor = deps.now() - limits.graceMs
  let offset = Math.max(0, cursor)
  let stoppedBy: OrphanScopeStop = 'exhausted'

  for (;;) {
    if (tally.examined >= limits.maxRows) {
      stoppedBy = 'row-ceiling'
      break
    }

    let page: VectorOrphanScanPage
    try {
      page = await deps.scanPage(offset, limits.pageSize)
    } catch (err) {
      deps.logger.warn('embedding orphan scan: index page failed — pass abandoned', {
        meta: { scope: deps.scope, offset, error: String(err) },
      })
      stoppedBy = 'page-stalled'
      break
    }

    const named = page.rows.filter((r) => r.ownerId !== null).map((r) => r.ownerId ?? '')
    let live: ReadonlySet<string>
    try {
      live = named.length > 0 ? await deps.liveOwnerIds(named) : new Set<string>()
    } catch (err) {
      // The one thing this must never do is read a failed answer as "dead".
      deps.logger.warn('embedding orphan scan: liveness probe failed — pass abandoned', {
        meta: { scope: deps.scope, offset, error: String(err) },
      })
      stoppedBy = 'probe-failed'
      break
    }

    const doomed: string[] = []
    let ceilingHit = false
    for (const row of page.rows) {
      tally.examined += 1
      if (row.ownerId === null) {
        tally.unresolvable += 1
        continue
      }
      if (live.has(row.ownerId)) {
        tally.kept += 1
        continue
      }
      // Owner gone. The grace window is the last thing between this row and
      // deletion, and it only ever saves. A row with NO timestamp is not aged
      // out by an assumption — it is treated as within grace.
      if (row.timestamp === null || row.timestamp > graceFloor) {
        tally.withinGrace += 1
        continue
      }
      tally.orphans += 1
      if (row.deviceId !== null) deviceIds.add(row.deviceId)
      if (limits.mode !== 'reclaim') continue
      if (tally.reclaimed + doomed.length >= limits.maxReclaim) {
        ceilingHit = true
        break
      }
      doomed.push(row.id)
    }

    let reclaimedInPage = 0
    if (doomed.length > 0) {
      const outcome = await deps.reclaim(doomed)
      reclaimedInPage = outcome.deleted.length
      tally.reclaimed += outcome.deleted.length
      tally.notReclaimed += outcome.stillPresent.length
    }

    if (deps.breathe) await deps.breathe()

    if (ceilingHit) {
      stoppedBy = 'reclaim-ceiling'
      // Resume behind what this page removed rather than rescanning what was
      // already judged.
      offset += page.rows.length - reclaimedInPage
      break
    }
    // A deleted row leaves the table, so the window shifts under an OFFSET
    // cursor: advance past only what stayed. Same arithmetic as the settings-
    // store engine, and the reason a reclaim pass does not skip a row it never
    // judged.
    offset += page.rows.length - reclaimedInPage
    if (page.nextCursor === null) {
      // Walked to the end. Restart from the top next run — that is what makes
      // this both idempotent and resumable.
      offset = 0
      break
    }
    if (page.rows.length === 0) {
      // A page that yielded nothing but is not the end would spin forever.
      stoppedBy = 'page-stalled'
      break
    }
  }

  return {
    scope: deps.scope,
    examined: tally.examined,
    orphans: tally.orphans,
    reclaimed: tally.reclaimed,
    kept: tally.kept,
    withinGrace: tally.withinGrace,
    unresolvable: tally.unresolvable,
    notReclaimed: tally.notReclaimed,
    deviceIds: [...deviceIds],
    stoppedBy,
    nextCursor: Math.max(0, offset),
  }
}
