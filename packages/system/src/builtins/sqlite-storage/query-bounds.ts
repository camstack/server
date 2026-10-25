/**
 * Defensive row bounds for `data-store-provider.query`.
 *
 * **Why this file exists.** On 2026-08-07 hub-main died with
 * `FATAL ERROR: Reached heap limit` under `Data::GetValueJS` /
 * `Statement::JS_all`, four seconds after reporting `heapUsed=644MB
 * heapLimit=4288MB`. The heap sampler cannot see an allocation that begins and
 * ends between two samples, so the `[mem]` line said everything was fine right
 * up to the kill. The same stack had already killed the hub twice on 01/08 and
 * twice on 02/08.
 *
 * **It was NOT one 3.4 GB statement, and that correction matters.** The whole
 * database measures 153 MiB (134 MB in a backup taken 14 h earlier, with
 * `auto_vacuum=NONE` and `freelist_count=6` proving it had never been larger)
 * — no single `.all()` on it can produce 3.4 GB. What happened was MANY reads
 * live at once: a viewer resumed from background and requested a 12-hour
 * window over 16 cameras, twice, 33 ms apart. The final Mark-Compact reclaimed
 * 4 MB of 4 090 MB, i.e. every byte was still reachable. `Statement::JS_all` is
 * where the wall was hit, not the size of that one call. The caller-side bound
 * for that specific fan-out lives in `track-store.ts`
 * (`RECENT_FANOUT_ROW_BUDGET`); this file is the backstop under everything
 * else.
 *
 * So: a bound on the query, NOT a bigger `--max-old-space-size`. hub-main's
 * routine p95 heap is already 2 108 MB against a 4 288 MB ceiling; a larger
 * ceiling only moves the number the next unbounded read has to beat.
 *
 * **Why a cap and not a required `limit`.** 64 call sites across the repo
 * query a collection with no `limit`, and most of them are correct — a filter
 * narrow enough that the result set is a handful of rows (`where: { trackId }`,
 * `where: { ownerId }`). Making `limit` mandatory would be 64 edits that each
 * have to guess a number, and the 65th call site added next month would be
 * unbounded again. A cap in the ENGINE holds for every caller, including the
 * ones not written yet.
 *
 * **Why the cap is never silent.** A truncated read that looks like a complete
 * one is worse than the OOM: it turns "the hub died" into "the retention sweep
 * quietly stopped deleting". Every cap hit is logged at WARN naming the
 * collection and the bound, and the caller is expected to page.
 */

/**
 * Rows returned when the caller supplied no `limit` at all.
 *
 * Sized against the MEASURED hub database (2026-08-08), because a row cap is
 * meaningless without knowing what a row weighs:
 *
 * | table                              | rows    | bytes  | avg row |
 * | ---------------------------------- | ------- | ------ | ------- |
 * | `pipeline-analytics:tracks`        |   4 668 |  54 MB | 11.5 KB |
 * | `pipeline-analytics:media`         | 101 953 |  23 MB |   230 B |
 * | `pipeline-analytics:motion-events` | 148 738 |  12 MB |    78 B |
 * | `pipeline-analytics:audio-events`  |  99 608 |   8 MB |    80 B |
 * | `pipeline-analytics:faces`         |     372 |   4 MB | 10.8 KB |
 *
 * `tracks` is the pacing table: its `positions` JSON alone is 47 MB of the 54,
 * averaging **10 KB per row**, and it is parsed into JS objects on read. 2 000
 * such rows is ~23 MB of text before parsing — an order of magnitude under
 * hub-main's routine p95 heap (2 108 MB) rather than a multiple of it. The
 * same 2 000 rows of `motion-events` is 160 KB, so narrow tables (auth,
 * alerts, integrations, schedules) never notice the cap at all.
 *
 * An earlier draft sized this at 5 000 on the belief that `faces` was the
 * widest table. It is 372 rows and 4 MB — `pruneCapOverflow` keeps it that
 * way. The number was defensible; the stated evidence for it was wrong, which
 * is worse, because the next person reasons from the evidence.
 *
 * It is deliberately NOT tuned to "the largest legitimate result set" — a
 * caller that genuinely wants more says so with an explicit `limit`, which is
 * honoured up to {@link SETTINGS_QUERY_HARD_ROW_CAP}.
 */
export const SETTINGS_QUERY_DEFAULT_ROW_CAP = 2_000

/**
 * Absolute ceiling, applied even to an explicit `limit`.
 *
 * The default cap can be opted out of; this one cannot, because the failure it
 * prevents is an OOM and there is no result set worth taking the process down
 * for. A caller needing more than 20 000 rows is describing a stream, not a
 * query, and must page (`limit` + `offset`) — every bulk consumer in the repo
 * already does. At the measured 11.5 KB/row of `tracks`, 20 000 rows is
 * ~230 MB: ruinous to serve, but survivable, which is the right place for a
 * ceiling whose only job is to stop the process dying.
 */
export const SETTINGS_QUERY_HARD_ROW_CAP = 20_000

/** Where the effective row bound came from. */
export type RowBoundSource =
  /** The caller's own `limit`, honoured verbatim. Not a truncation. */
  | 'caller'
  /** No usable `limit` was given — {@link SETTINGS_QUERY_DEFAULT_ROW_CAP}. */
  | 'default-cap'
  /** The caller asked for more than {@link SETTINGS_QUERY_HARD_ROW_CAP}. */
  | 'hard-cap'

export interface ResolvedRowBound {
  /** Rows the statement is allowed to return. */
  readonly limit: number
  readonly source: RowBoundSource
}

/**
 * Resolve the row bound a `query` will run under.
 *
 * Treats a non-finite, negative or non-integer `limit` as ABSENT rather than
 * as an error. That is not leniency for its own sake: SQLite reads a negative
 * `LIMIT` as "no limit at all", so `limit: -1` arriving over the wire — the
 * cap schema is `z.number().optional()`, which accepts it — would have been
 * the one input able to reproduce the OOM through a bound that looked applied.
 *
 * `limit: 0` is a real request for zero rows and is honoured.
 */
export function resolveRowBound(requested: number | undefined): ResolvedRowBound {
  if (requested === undefined || !Number.isFinite(requested) || requested < 0) {
    return { limit: SETTINGS_QUERY_DEFAULT_ROW_CAP, source: 'default-cap' }
  }
  const asked = Math.floor(requested)
  if (asked > SETTINGS_QUERY_HARD_ROW_CAP) {
    return { limit: SETTINGS_QUERY_HARD_ROW_CAP, source: 'hard-cap' }
  }
  return { limit: asked, source: 'caller' }
}

/**
 * Whether a bound being hit is something the CALLER did not ask for, and must
 * therefore be told about.
 *
 * A caller that asked for 500 rows and got 500 has not been truncated — it has
 * been served. Only a cap the engine imposed is news.
 */
export function isImposedBound(source: RowBoundSource): boolean {
  return source !== 'caller'
}
