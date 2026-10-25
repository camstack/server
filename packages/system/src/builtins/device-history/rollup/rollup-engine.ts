/**
 * Rollups 5m / 1h / 1d, computed by this addon and nowhere else (plan §5.5).
 *
 * Every rollup is a RECOMPUTE from the tier below — never an increment — so
 * running one twice, after a restart, or after a late write gives the same row:
 *
 *  - 5m (point series only): from the raw rows of the bucket, once it has
 *    closed (+30 s grace). Raw is the source of truth, which is why a restart
 *    loses nothing: {@link RollupEngine.bootRecompute} rebuilds the recent
 *    window, the still-open bucket included, from raw.
 *  - 1h: from the 5m rows when the hour closes (+5 min grace).
 *  - 1d: from the 1h rows at hub-local midnight (+15 min grace).
 *
 * A write marks the bucket above it DIRTY; a late `recordBuckets` into an hour
 * that was already rolled just marks it again, and the next tick recomputes it.
 * The dirty sets are memory: a crash forgets them, and the boot window
 * ({@link BOOT_WINDOW_MS}) is what makes that harmless.
 */
import type { IScopedLogger } from '@camstack/types'
import type { HistoryCounters } from '../status/counters.js'
import type { HistoryStore } from '../store/history-store.js'
import { READ_PAGE } from '../store/history-store.js'
import type { SeriesRegistry } from '../store/series-registry.js'
import {
  FIVE_MINUTES_MS,
  HOUR_MS,
  ROLLUP_GRACE_MS,
  bucketEndOf,
  bucketStartOf,
  floorTo,
} from '../time/bucket-time.js'
import type { WrittenPoints } from '../capture/point-writer.js'
import { type RawPoint, combineRows, rawToFiveMinuteRows } from './rollup-math.js'

/** Series handled per tier per tick: bounds one tick on a catch-up. */
export const MAX_SERIES_PER_TICK: number = 400
/** How far back a boot rebuilds from raw and re-marks the upper tiers. */
export const BOOT_WINDOW_MS: number = 3 * HOUR_MS

/** series -> bucket -> the version of its LAST mark. */
type DirtySet = Map<number, Map<number, number>>

let markVersion: number = 0

function mark(sets: DirtySet, seriesId: number, bucketStart: number): void {
  const map = sets.get(seriesId) ?? new Map<number, number>()
  markVersion += 1
  map.set(bucketStart, markVersion)
  sets.set(seriesId, map)
}

interface ClosedMark {
  readonly bucket: number
  readonly version: number
}

/**
 * Clear what a recompute handled — but only a mark that was not RENEWED while the
 * recompute awaited: a late write that re-marked the bucket mid-flight carries a newer
 * version and must be computed again, not erased with the old mark.
 */
function settle(sets: DirtySet, seriesId: number, handled: readonly ClosedMark[]): void {
  const map = sets.get(seriesId)
  if (map === undefined) return
  for (const { bucket, version } of handled) {
    if (map.get(bucket) === version) map.delete(bucket)
  }
  if (map.size === 0) sets.delete(seriesId)
}

/** Buckets further apart than this are recomputed as separate ranges, not one long read. */
const MAX_RANGE_GAP_MS: number = HOUR_MS

/** `[from, toExclusive)` ranges covering sorted 5-minute bucket starts, split at long gaps. */
function clusterRanges(sorted: readonly number[]): readonly (readonly [number, number])[] {
  const ranges: [number, number][] = []
  for (const start of sorted) {
    const current = ranges[ranges.length - 1]
    if (current !== undefined && start - current[1] <= MAX_RANGE_GAP_MS) {
      current[1] = start + FIVE_MINUTES_MS
    } else {
      ranges.push([start, start + FIVE_MINUTES_MS])
    }
  }
  return ranges
}

export interface RollupEngineDeps {
  readonly store: HistoryStore
  readonly registry: SeriesRegistry
  readonly counters: HistoryCounters
  readonly logger: IScopedLogger
  readonly clock: () => number
}

export class RollupEngine {
  private readonly dirty5m: DirtySet = new Map()
  private readonly dirty1h: DirtySet = new Map()
  private readonly dirty1d: DirtySet = new Map()
  private ticking: Promise<void> | null = null

  constructor(private readonly deps: RollupEngineDeps) {}

  dirtyCounts(): { readonly m5: number; readonly h1: number; readonly d1: number } {
    const count = (sets: DirtySet): number => [...sets.values()].reduce((n, set) => n + set.size, 0)
    return { m5: count(this.dirty5m), h1: count(this.dirty1h), d1: count(this.dirty1d) }
  }

  // ── marks ──────────────────────────────────────────────────────────

  /** Raw points landed: their 5-minute buckets (and a late bucket's successor) are dirty. */
  markPoints(written: readonly WrittenPoints[]): void {
    const now = this.deps.clock()
    for (const { seriesId, timestamps } of written) {
      for (const ts of timestamps) {
        const bucket = floorTo(ts, FIVE_MINUTES_MS)
        mark(this.dirty5m, seriesId, bucket)
        // A late point can change the value HELD into the next bucket.
        if (bucket + FIVE_MINUTES_MS + ROLLUP_GRACE_MS['5m'] <= now) {
          mark(this.dirty5m, seriesId, bucket + FIVE_MINUTES_MS)
        }
      }
    }
  }

  /** A 5m row landed (computed, or a producer bucket): its hour is dirty. */
  markFiveMinuteRow(seriesId: number, bucketStart: number): void {
    mark(this.dirty1h, seriesId, bucketStartOf('1h', bucketStart))
  }

  // ── tick ───────────────────────────────────────────────────────────

  /** One pass over the three tiers. Single-flight; errors are counted and the work stays dirty. */
  tick(): Promise<void> {
    if (this.ticking !== null) return this.ticking
    const run = this.doTick().finally(() => {
      this.ticking = null
    })
    this.ticking = run
    return run
  }

  private async doTick(): Promise<void> {
    const now = this.deps.clock()
    await this.guarded('5m', () => this.tickFiveMinute(now))
    await this.guarded('1h', () => this.tickHour(now))
    await this.guarded('1d', () => this.tickDay(now))
  }

  private async guarded(tier: string, run: () => Promise<void>): Promise<void> {
    try {
      await run()
    } catch (err) {
      this.deps.counters.rollupErrors += 1
      this.deps.logger.warn(`device-history: ${tier} rollup pass failed — work stays dirty`, {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private closedBuckets(
    map: ReadonlyMap<number, number>,
    tier: '5m' | '1h' | '1d',
    now: number,
  ): readonly ClosedMark[] {
    return [...map]
      .filter(([start]) => bucketEndOf(tier, start) + ROLLUP_GRACE_MS[tier] <= now)
      .map(([bucket, version]) => ({ bucket, version }))
      .toSorted((a, b) => a.bucket - b.bucket)
  }

  /** Forget everything held for a series that was purged. */
  forgetSeries(seriesId: number): void {
    this.dirty5m.delete(seriesId)
    this.dirty1h.delete(seriesId)
    this.dirty1d.delete(seriesId)
    this.deps.counters.forgetSeries(seriesId)
  }

  private async tickFiveMinute(now: number): Promise<void> {
    let handled = 0
    for (const [seriesId, set] of this.dirty5m) {
      if (handled >= MAX_SERIES_PER_TICK) break
      const closed = this.closedBuckets(set, '5m', now)
      if (closed.length === 0) continue
      handled += 1
      for (const [from, to] of clusterRanges(closed.map((c) => c.bucket))) {
        await this.recomputeFiveMinute(seriesId, from, to, now)
      }
      settle(this.dirty5m, seriesId, closed)
    }
    if (handled > 0) this.deps.counters.last5mAt = now
  }

  private async tickHour(now: number): Promise<void> {
    let handled = 0
    for (const [seriesId, set] of this.dirty1h) {
      if (handled >= MAX_SERIES_PER_TICK) break
      const closed = this.closedBuckets(set, '1h', now)
      if (closed.length === 0) continue
      handled += 1
      for (const hour of closed) {
        await this.recomputeHour(seriesId, hour.bucket, now)
        settle(this.dirty1h, seriesId, [hour])
      }
    }
    if (handled > 0) this.deps.counters.last1hAt = now
  }

  private async tickDay(now: number): Promise<void> {
    let handled = 0
    for (const [seriesId, set] of this.dirty1d) {
      if (handled >= MAX_SERIES_PER_TICK) break
      const closed = this.closedBuckets(set, '1d', now)
      if (closed.length === 0) continue
      handled += 1
      for (const day of closed) {
        await this.recomputeDay(seriesId, day.bucket, now)
        settle(this.dirty1d, seriesId, [day])
      }
    }
    if (handled > 0) this.deps.counters.last1dAt = now
  }

  // ── recomputes ─────────────────────────────────────────────────────

  /** An `enum` series keeps the time spent in each state in its rollups. */
  private isEnum(seriesId: number): boolean {
    const series = this.deps.registry.byIdOf(seriesId)
    return series !== undefined && this.deps.registry.metric(series.key)?.kind === 'enum'
  }

  /** Raw → 5m rows for buckets in `[from, toExclusive)`; writes them and marks their hours. */
  async recomputeFiveMinute(
    seriesId: number,
    from: number,
    toExclusive: number,
    horizon: number,
  ): Promise<number> {
    const { store } = this.deps
    const points: RawPoint[] = []
    let cursor = from
    for (;;) {
      const page = await store.readRaw(seriesId, cursor, toExclusive - 1, READ_PAGE)
      points.push(...page)
      const last = page[page.length - 1]
      if (last === undefined || page.length < READ_PAGE) break
      cursor = last.ts + 1
    }
    const rows = rawToFiveMinuteRows({
      seriesId,
      points,
      carryIn: await store.rawBefore(seriesId, from),
      horizon,
      trackStates: this.isEnum(seriesId),
    })
    if (rows.length === 0) return 0
    await store.upsertRollups('5m', rows)
    this.deps.counters.noteRollupRows(
      '5m',
      seriesId,
      rows.map((r) => r.bucketStart),
    )
    for (const row of rows) this.markFiveMinuteRow(seriesId, row.bucketStart)
    return rows.length
  }

  private async recomputeHour(seriesId: number, hour: number, now: number): Promise<void> {
    await this.recomputeFrom('5m', '1h', FIVE_MINUTES_MS, seriesId, hour, now)
  }

  private async recomputeDay(seriesId: number, day: number, now: number): Promise<void> {
    await this.recomputeFrom('1h', '1d', HOUR_MS, seriesId, day, now)
  }

  private async recomputeFrom(
    child: '5m' | '1h',
    parent: '1h' | '1d',
    childWidthMs: number,
    seriesId: number,
    windowStart: number,
    now: number,
  ): Promise<void> {
    const { store } = this.deps
    const windowEnd = bucketEndOf(parent, windowStart)
    const rows = await store.readRollups(child, seriesId, windowStart, windowEnd - 1, READ_PAGE)
    const before = await store.rollupBefore(child, seriesId, windowStart)
    const combined = combineRows({
      seriesId,
      windowStart,
      windowEnd,
      childWidthMs,
      rows,
      carryIn: before?.last ?? null,
      horizon: now,
      trackStates: this.isEnum(seriesId),
    })
    if (combined === null) return
    await store.upsertRollups(parent, [combined])
    this.deps.counters.noteRollupRows(parent, seriesId, [combined.bucketStart])
    if (parent === '1h') mark(this.dirty1d, seriesId, bucketStartOf('1d', windowStart))
  }

  // ── boot ───────────────────────────────────────────────────────────

  /**
   * After a restart the dirty sets are gone. Rebuild the recent window from raw
   * (the still-open bucket included, time-weighted up to `now`), then mark the
   * 1h / 1d buckets of that window dirty so the next ticks recompute them.
   */
  async bootRecompute(now: number): Promise<number> {
    const windowStart = floorTo(now - BOOT_WINDOW_MS, FIVE_MINUTES_MS)
    const openBucket = floorTo(now, FIVE_MINUTES_MS)
    let series = 0
    for (const s of this.deps.registry.all()) {
      if (s.lastTs < windowStart) continue
      const metric = this.deps.registry.metric(s.key)
      series += 1
      if (metric?.ingest === 'points') {
        await this.recomputeFiveMinute(s.id, windowStart, openBucket + FIVE_MINUTES_MS, now)
        mark(this.dirty5m, s.id, openBucket)
        mark(this.dirty5m, s.id, openBucket - FIVE_MINUTES_MS)
      }
      for (let hour = floorTo(windowStart, HOUR_MS); hour <= now; hour += HOUR_MS) {
        mark(this.dirty1h, s.id, hour)
      }
      mark(this.dirty1d, s.id, bucketStartOf('1d', windowStart))
      mark(this.dirty1d, s.id, bucketStartOf('1d', now))
    }
    return series
  }
}
