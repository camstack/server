import type { IScopedLogger, LogTags } from '@camstack/types'
import { sqlShape } from './statement-shape.js'

/**
 * Per-operation timing for the synchronous SQLite engine.
 *
 * ## Why this exists
 *
 * `hub/sqlite-settings` is a forked runner with ONE JS thread and a
 * **synchronous** SQLite binding: every statement it executes stops the event
 * loop for the whole of its duration, and every configuration read in the
 * cluster queues behind it. On 2026-08-25 that runner reported
 * `loopMax=68283ms` while the container had zero memory pressure
 * (`memory.events max` 0/min, cgroup 16-20 GB of 24) and the NVMe was idle
 * (`%util` 1.5-8%, `r_await` 0.14 ms) — so neither of the two previously known
 * causes applied, and there was **not one line in the log saying what the
 * runner was doing**. Diagnosis fell back to sampling `/proc/<pid>/syscall`
 * from the host, which is not a thing an operator can be asked to do.
 *
 * A 120 s census of the runner's main thread (2 216 samples at 54 ms) read
 * `D=41% R=50% S=9%` against 13.9 s of CPU: the thread was blocked in
 * `pread64 → filemap_read → folio_wait_bit_common` — synchronous 4 KiB page-ins
 * on `camstack.db` — for two fifths of wall-clock, at a sustained 418 read
 * syscalls per second. What it could NOT say is which query issued them.
 *
 * ## Why an aggregate, and not only a slow-query log
 *
 * The 68 s stall was **not** one 68 s statement. At 418 page reads per second
 * the cost is spread across many statements that are each individually
 * unremarkable, so a threshold-only log would have reported nothing at all
 * while the loop sat still. {@link SqliteOpProfiler.report} therefore prints
 * the window's busiest `(op, collection)` pairs and the share of wall-clock
 * the engine spent inside SQLite — the number that says "this runner is
 * saturated" even when no single call is.
 *
 * The slow-call WARN is kept for the other shape of the same failure: one
 * statement that really does take seconds. Both are needed; neither is
 * sufficient.
 *
 * ## Why the SQL shape, and why the plan
 *
 * `(op, collection)` names a TABLE, not a call site. On 2026-08-25 the busiest
 * line of a 90 s operator stall was `query pipeline-analytics:tracks — 1005
 * calls, max 1615 ms` and eleven different reads in one addon are spelled
 * exactly that way; the aggregate accused all of them and cleared none. So the
 * shape of the prepared statement (`statement-shape.ts`) is part of the
 * aggregate KEY, and the report prints it.
 *
 * A shape says WHICH query. It does not say why it is slow — "1.6 s for 501
 * rows" is a full scan and "1.6 s for 501 rows" is also a cold disk, and those
 * are the same line. `EXPLAIN QUERY PLAN` is the only thing that separates
 * them, and it is attached to the slow-call WARN because that is where the
 * question is asked. It is asked ONCE PER SHAPE PER WINDOW: a scan that fires
 * the WARN fires it repeatedly, and a plan re-printed forty times is how the
 * one line that mattered stops being read.
 *
 * ## Cost
 *
 * Two `Date.now()` calls and one `Map` lookup per statement. At the measured
 * live rate (a few hundred statements/s) that is far below the noise floor of
 * the work being measured — and unlike a sampling profiler it is always on,
 * which is the point: the stall that matters is the one nobody was watching.
 */

/**
 * A single statement whose duration is being recorded.
 *
 * `rows` is "rows touched" — returned by a read, affected by a write. It is
 * what separates "this query is slow because it is scanning" from "this query
 * is slow because the disk is".
 */
export interface SqliteOpSample {
  /** Backend method that ran the statement: `query`, `count`, `set`, … */
  readonly op: string
  /** Scoped table name (`<namespace>:<collection>`), never a device name. */
  readonly collection: string
  readonly durationMs: number
  readonly rows: number
  /**
   * Numeric device id when the statement was issued on behalf of one. Every
   * log line about a device carries `tags: { deviceId }` — a stall is always
   * asked per-camera, and a line without the tag cannot answer it.
   */
  readonly deviceId?: number
  /** See {@link SqliteOpLabel.owner}. */
  readonly owner?: string
  /** See {@link SqliteOpLabel.sql}. */
  readonly sql?: string
  /** See {@link SqliteOpLabel.params}. */
  readonly params?: readonly unknown[]
}

/** One `(op, collection, owner, shape)` tuple's totals over a report window. */
export interface SqliteOpStat {
  readonly op: string
  readonly collection: string
  readonly owner?: string
  /** `statement-shape.ts` fingerprint; absent for a fixed-shape statement the
   *  engine did not hand to the profiler. */
  readonly shape?: string
  readonly calls: number
  readonly totalMs: number
  readonly maxMs: number
  readonly rows: number
}

/**
 * Runs `EXPLAIN QUERY PLAN` for a statement on the connection that executed it.
 *
 * Injected rather than reached for: the profiler must not own a database
 * handle, and the plan is only trustworthy from the SAME connection — a second
 * handle can differ in `sqlite_stat1` visibility and in temp-schema state, and
 * a plan taken from a connection that is not the one that stalled describes a
 * query nobody ran.
 *
 * Returns one string per plan row (SQLite's `detail` column). Must not throw —
 * an unexplainable statement yields `[]`.
 */
export type SqlExplainer = (sql: string, params: readonly unknown[]) => readonly string[]

/**
 * Duration at which one statement is worth a WARN on its own, in ms.
 *
 * 1 000 ms is a full second of every cluster-wide configuration read queued
 * behind one statement. Below that the aggregate report is the right place to
 * see it; above it, the statement is the story and deserves its own line.
 */
export const SQLITE_SLOW_CALL_MS = 1_000

/** How often the aggregate report is emitted, in ms. Matched to the runner's
 *  own `[mem]` heartbeat so the two lines can be read side by side. */
export const SQLITE_PROFILE_REPORT_INTERVAL_MS = 60_000

/**
 * Engine-busy time below which a window is not worth a line, in ms.
 *
 * 250 ms in a 60 s window is 0.4% — an engine doing its job. Reporting below
 * this would be a line a minute forever describing a runner that is fine,
 * which is how a log stops being read.
 */
export const SQLITE_PROFILE_REPORT_FLOOR_MS = 250

/** Pairs named in one report line. Enough to see the shape, short enough to read. */
export const SQLITE_PROFILE_TOP_N = 5

/**
 * Share of window wall-clock at which ONE shape is a storm, not a busy engine.
 *
 * Measured 2026-08-31: the OFFSET census on `pipeline-analytics:media` was
 * 88.7 % of wall for six hours. A healthy bounded census (20 s budget in a
 * 60 s window) is 33 % and must not warn. Half the loop is the line between
 * "the engine is working" and "the cluster is queuing behind one query".
 *
 * Cap-usage rate cannot name this class — see `sqliteEngineStorm`.
 */
export const SQLITE_ENGINE_STORM_WALL_SHARE = 0.5

/**
 * The dominating shape if it held {@link SQLITE_ENGINE_STORM_WALL_SHARE} of
 * the window, otherwise `null`.
 *
 * Share is of WINDOW wall, not of busy time: an engine that is 90 % busy with
 * ten equal shapes is healthy; one shape at 50 % of wall is the 2026-08-31
 * store saturation regardless of what else ran. `stats` must already be
 * busiest-first (as {@link SqliteOpProfiler.drain} returns them).
 */
export function sqliteEngineStorm(
  stats: readonly SqliteOpStat[],
  windowMs: number,
): SqliteOpStat | null {
  if (windowMs <= 0) return null
  const top = stats[0]
  if (top === undefined) return null
  if (top.totalMs / windowMs < SQLITE_ENGINE_STORM_WALL_SHARE) return null
  return top
}

export interface SqliteOpProfilerOptions {
  readonly logger: IScopedLogger
  /** Injected for tests; production reads the wall clock. */
  readonly now?: () => number
  readonly slowCallMs?: number
  readonly reportIntervalMs?: number
  readonly reportFloorMs?: number
  readonly topN?: number
  /** Absent ⇒ slow-call WARNs carry no plan. See {@link SqlExplainer}. */
  readonly explain?: SqlExplainer
}

/** Identity of a measured call, without the numbers `measure` supplies itself. */
export interface SqliteOpLabel {
  readonly op: string
  readonly collection: string
  readonly deviceId?: number
  /**
   * The addon a scoped row belongs to, when the filter named one (see
   * `scopeOwnerOf`). Part of the aggregate KEY, not decoration: without it the
   * report can say a collection is being hammered and never by whom, which is
   * exactly where the 67 660-call storm of 2026-08-25 stopped.
   */
  readonly owner?: string
  /**
   * The statement the engine prepared, verbatim.
   *
   * Supplied only by the ops that BUILD their SQL from a filter — those are the
   * ones whose cost varies by call site. A fixed-shape statement (`get`, `set`)
   * is already fully described by `(op, collection)`.
   *
   * Used for two things and nothing else: the shape that becomes part of the
   * aggregate key, and the `EXPLAIN QUERY PLAN` on a slow call. Never logged
   * raw — see `statement-shape.ts` for what is dropped.
   */
  readonly sql?: string
  /**
   * The values bound to {@link sql}.
   *
   * Needed because `EXPLAIN QUERY PLAN` on a statement with unbound parameters
   * is not the plan that ran: SQLite's planner reads bound values for `LIKE`
   * prefixes and for index-selection on `IN`. Never logged, in whole or in
   * part — they carry device ids, keys and user data.
   */
  readonly params?: readonly unknown[]
}

interface MutableStat {
  // The identity is CARRIED, not re-parsed out of the map key. The key gained
  // a third part and a `split on the first space` would have folded the owner
  // into the collection name — silently, and only on the rows that have one.
  // It then gained a fourth (the shape) and the re-parse in `drain` was still
  // there, still splitting on the first space and still dropping the owner it
  // was written to keep: a comment that describes the right design is worse
  // than nothing, because it reads as verification. Fixed 2026-08-25.
  readonly op: string
  readonly collection: string
  readonly owner: string | undefined
  readonly shape: string | undefined
  calls: number
  totalMs: number
  maxMs: number
  rows: number
}

function rowsOf(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (value === undefined || value === null) return 0
  if (typeof value === 'object' && 'changes' in value) {
    const changes = Reflect.get(value, 'changes')
    return typeof changes === 'number' ? changes : 1
  }
  return 1
}

export class SqliteOpProfiler {
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly slowCallMs: number
  private readonly reportIntervalMs: number
  private readonly reportFloorMs: number
  private readonly topN: number
  private readonly explain: SqlExplainer | undefined

  private readonly stats = new Map<string, MutableStat>()
  /** Shapes already explained in this window — see the class doc on why the
   *  plan is printed once and not on every WARN. Cleared by `drain`. */
  private readonly explainedShapes = new Set<string>()
  private windowStartedAt: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: SqliteOpProfilerOptions) {
    this.logger = options.logger
    this.now = options.now ?? Date.now
    this.slowCallMs = options.slowCallMs ?? SQLITE_SLOW_CALL_MS
    this.reportIntervalMs = options.reportIntervalMs ?? SQLITE_PROFILE_REPORT_INTERVAL_MS
    this.reportFloorMs = options.reportFloorMs ?? SQLITE_PROFILE_REPORT_FLOOR_MS
    this.topN = options.topN ?? SQLITE_PROFILE_TOP_N
    this.explain = options.explain
    this.windowStartedAt = this.now()
  }

  /**
   * Time a synchronous SQLite call.
   *
   * The elapsed time is recorded on the way out of BOTH exits. A statement
   * that threw still held the event loop for as long as it ran, and a
   * profiler that only counts successes reports an idle engine during exactly
   * the incident worth explaining.
   */
  measure<T>(label: SqliteOpLabel, run: () => T): T {
    const started = this.now()
    try {
      const result = run()
      this.record({ ...label, durationMs: this.now() - started, rows: rowsOf(result) })
      return result
    } catch (err) {
      this.record({ ...label, durationMs: this.now() - started, rows: 0 })
      throw err
    }
  }

  record(sample: SqliteOpSample): void {
    const shape = sample.sql === undefined ? undefined : sqlShape(sample.sql, sample.collection)
    const key = `${sample.op} ${sample.collection} ${sample.owner ?? ''} ${shape ?? ''}`
    const existing = this.stats.get(key)
    if (existing === undefined) {
      this.stats.set(key, {
        op: sample.op,
        collection: sample.collection,
        owner: sample.owner,
        shape,
        calls: 1,
        totalMs: sample.durationMs,
        maxMs: sample.durationMs,
        rows: sample.rows,
      })
    } else {
      existing.calls += 1
      existing.totalMs += sample.durationMs
      existing.rows += sample.rows
      if (sample.durationMs > existing.maxMs) existing.maxMs = sample.durationMs
    }

    if (sample.durationMs >= this.slowCallMs) {
      this.logger.warn('sqlite statement held the event loop', {
        ...tagsFor(sample.deviceId),
        meta: {
          op: sample.op,
          collection: sample.collection,
          ...(sample.owner === undefined ? {} : { owner: sample.owner }),
          ...(shape === undefined ? {} : { shape }),
          durationMs: Math.round(sample.durationMs),
          rows: sample.rows,
          ...this.planFor(sample, shape),
        },
      })
    }
  }

  /**
   * `EXPLAIN QUERY PLAN` for a statement that just held the loop, or nothing.
   *
   * Nothing when: no explainer was injected, the op carries no SQL, or this
   * shape has already been explained in this window. The explainer is
   * contracted not to throw and is guarded anyway — a profiler that can turn a
   * slow query into a crash is worse than one that cannot explain it.
   */
  private planFor(
    sample: SqliteOpSample,
    shape: string | undefined,
  ): { readonly plan?: readonly string[] } {
    const explain = this.explain
    if (explain === undefined || sample.sql === undefined || shape === undefined) return {}
    if (this.explainedShapes.has(shape)) return {}
    this.explainedShapes.add(shape)
    const plan = explain(sample.sql, sample.params ?? [])
    return plan.length === 0 ? {} : { plan }
  }

  /** Totals for the window, busiest first, and reset. */
  drain(): readonly SqliteOpStat[] {
    const out: SqliteOpStat[] = []
    // Identity comes off the STAT, not off the key. `drain` re-parsed the key
    // with a single split while the key already had three parts and the stat
    // already carried all of them — so `owner`, the field the key gained the
    // part FOR, never reached a single report line. It has a fourth part now.
    for (const stat of this.stats.values()) {
      out.push({
        op: stat.op,
        collection: stat.collection,
        ...(stat.owner === undefined ? {} : { owner: stat.owner }),
        ...(stat.shape === undefined ? {} : { shape: stat.shape }),
        calls: stat.calls,
        totalMs: stat.totalMs,
        maxMs: stat.maxMs,
        rows: stat.rows,
      })
    }
    this.stats.clear()
    this.explainedShapes.clear()
    this.windowStartedAt = this.now()
    return out.sort((a, b) => b.totalMs - a.totalMs)
  }

  /** Emit one aggregate line for the window, unless the engine was idle. */
  report(): void {
    const windowEndedAt = this.now()
    const windowMs = Math.max(1, windowEndedAt - this.windowStartedAt)
    const stats = this.drain()
    const busyMs = stats.reduce((acc, s) => acc + s.totalMs, 0)
    if (busyMs < this.reportFloorMs) return

    const busyPct = Math.round((busyMs / windowMs) * 100)
    const calls = stats.reduce((acc, s) => acc + s.calls, 0)
    const top = stats.slice(0, this.topN).map((s) => ({
      op: s.op,
      collection: s.collection,
      ...(s.owner === undefined ? {} : { owner: s.owner }),
      ...(s.shape === undefined ? {} : { shape: s.shape }),
      calls: s.calls,
      totalMs: Math.round(s.totalMs),
      maxMs: Math.round(s.maxMs),
      rows: s.rows,
    }))

    this.logger.info('sqlite engine busy', {
      meta: {
        busyMs: Math.round(busyMs),
        windowMs: Math.round(windowMs),
        busyPct,
        calls,
        top,
      },
    })

    const storm = sqliteEngineStorm(stats, windowMs)
    if (storm !== null) {
      // A second line, WARN, so Loki can alert. The INFO above is still the
      // structured top-N; collapsing them would hide the rest of the window
      // the moment the storm starts, which is when you most need it.
      this.logger.warn('sqlite engine storm', {
        meta: {
          busyMs: Math.round(busyMs),
          windowMs: Math.round(windowMs),
          busyPct,
          wallPct: Math.round((storm.totalMs / windowMs) * 100),
          op: storm.op,
          collection: storm.collection,
          ...(storm.owner === undefined ? {} : { owner: storm.owner }),
          ...(storm.shape === undefined ? {} : { shape: storm.shape }),
          calls: storm.calls,
          totalMs: Math.round(storm.totalMs),
          maxMs: Math.round(storm.maxMs),
          rows: storm.rows,
        },
      })
    }
  }

  start(): void {
    if (this.timer !== null) return
    this.windowStartedAt = this.now()
    const timer = setInterval(() => {
      this.report()
    }, this.reportIntervalMs)
    timer.unref?.()
    this.timer = timer
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }
}

function tagsFor(deviceId: number | undefined): { readonly tags?: LogTags } {
  return deviceId === undefined ? {} : { tags: { deviceId } }
}
