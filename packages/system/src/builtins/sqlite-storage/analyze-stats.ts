/**
 * `sqlite_stat1` — the index statistics the planner needs to choose between
 * two indexes that both fit.
 *
 * ## The failure this exists for
 *
 * The live hub's 900 MB database had NEVER been `ANALYZE`d — `sqlite_stat1` did
 * not exist. Without it SQLite falls back to fixed guesses, and on
 * `pipeline-analytics:media` (860 065 rows, two candidate indexes) the guess
 * was wrong in the most expensive possible direction:
 *
 * ```
 * SELECT … FROM media WHERE ownerKind=? AND ownerId=? AND deviceId=?
 *                     ORDER BY timestamp ASC
 * ```
 *
 * `idx_media_owner (ownerKind, ownerId)` finds the answer in ~2 rows but leaves
 * a sort. `idx_media_device_ts (deviceId, timestamp)` returns rows already in
 * `timestamp` order — so with no statistics the planner took the one that
 * avoided the sort, and walked all 150 133 media rows of one camera to return
 * SIX. Measured on a copy of the live database, warm cache, same four rows:
 *
 * | plan                        | time    |
 * | --------------------------- | ------- |
 * | `idx_media_device_ts` (chosen)  | 727 ms  |
 * | `idx_media_owner` (correct)     | 0.3 ms  |
 *
 * `ANALYZE` records `860065 143345 2` for `idx_media_owner` — two rows per
 * `(ownerKind, ownerId)` pair — against `860065 31855 1` for the device index,
 * and the planner flips. Same query, same rows, **727 ms → 3.2 ms**.
 *
 * ## Why it is one-shot, and scheduled
 *
 * A full `ANALYZE` of that database took **14.0 s**, and this engine is a
 * forked runner with a synchronous binding: those 14 s are 14 s in which every
 * configuration read in the cluster queues. That is affordable exactly once,
 * off the boot path, and never on a schedule — which is what the marker below
 * enforces. `sqlite_stat1` is a real table in the database, so the check
 * survives a restart with no state of its own to keep.
 *
 * Statistics go stale as a table grows, but stale statistics are not the
 * failure here: the failure is having NONE. Re-analysis is deliberately left as
 * a separate decision rather than smuggled in behind a timer.
 */

import type { Database } from 'better-sqlite3'

/**
 * Delay before the one-shot `ANALYZE`, in ms.
 *
 * Boot is itself the busiest window this runner has (`ensureTable` ×9, the
 * retired-key purge, the vector registry), and adding a 14 s statement to it
 * would turn a slow boot into one an operator reads as a hang. Long enough that
 * the cluster is serving before the engine goes quiet.
 */
export const ANALYZE_DELAY_MS = 120_000

/** What {@link runAnalyzeIfMissing} did, for the caller to log. */
export type AnalyzeOutcome =
  | { readonly kind: 'already-present' }
  | { readonly kind: 'analyzed'; readonly tookMs: number; readonly indexesAnalyzed: number }
  | { readonly kind: 'failed'; readonly tookMs: number; readonly error: string }

/**
 * True when the database has no `sqlite_stat1` at all.
 *
 * Deliberately "none", not "old": a stale row still tells the planner the
 * relative selectivity of two indexes, which is the entire question being
 * asked. Re-analysis on a staleness heuristic would put a 14 s statement on a
 * timer, and this runner cannot afford one.
 */
export function hasIndexStatistics(db: Database): boolean {
  const row = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'`,
    )
    .get()
  return (row?.n ?? 0) > 0
}

/**
 * `ANALYZE` the database, but only if it has never been analysed.
 *
 * Synchronous and long — see the module doc. Never throws: a database that
 * refuses to be analysed is a missing optimisation, not a reason to take the
 * settings engine down, and the outcome says so rather than going quiet.
 */
export function runAnalyzeIfMissing(db: Database, now: () => number = Date.now): AnalyzeOutcome {
  const startedAt = now()
  try {
    // The PROBE is inside the guard too. A handle closed under us (shutdown
    // races this timer by construction) throws on the first `prepare`, and a
    // guard that starts after it turns an orderly shutdown into a crash.
    if (hasIndexStatistics(db)) return { kind: 'already-present' }
    db.exec('ANALYZE')
    const row = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM sqlite_stat1`).get()
    return { kind: 'analyzed', tookMs: now() - startedAt, indexesAnalyzed: row?.n ?? 0 }
  } catch (error) {
    return {
      kind: 'failed',
      tookMs: now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
