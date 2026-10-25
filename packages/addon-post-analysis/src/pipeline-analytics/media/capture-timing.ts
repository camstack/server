/**
 * Capture timing shared by the addon and the `media/` capture paths — moved
 * out of `pipeline-analytics/index.ts` with the code that reads it (Plan B,
 * extraction 2).
 */

/** Staleness bound for QUEUED enrichment captures (face/plate gallery crops,
 *  object-embedding best crops, embedding full-frame fetches — S4). These are
 *  frame-handle-bound: once the runner's retained surface for the handle has
 *  recycled (a few seconds), executing the fetch is pure wasted transport that
 *  returns a miss anyway — drop it VISIBLY (`droppedStale` in the scheduler
 *  window line) instead. Only applies while queued over-budget; under
 *  no-contention the exec starts synchronously and this never fires. The
 *  confirmation-gate crop deliberately does NOT set this (it gates a birth —
 *  a late confirmation is still worth running; see `DEFAULT_CAPTURE_PRIORITY`). */
export const ENRICHMENT_CAPTURE_STALE_MS = 3_000
