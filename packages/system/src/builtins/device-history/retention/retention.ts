/**
 * Retention (plan §5.5, operator answer §13): raw 7 days, 5m 30 days, 1h 1 year,
 * 1d forever — global addon settings.
 *
 * Per series and per tier the delete is a PRIMARY KEY range
 * (`series_id = ? AND ts BETWEEN 0 AND cutoff-1`), so no `ts` index exists to
 * maintain. A row whose time equals the cutoff is KEPT. Each series is visited
 * at most once per {@link RETENTION_STEP_MS} of cutoff advance (an hour for the
 * short tiers, a day for the long ones): without that, every active series
 * would pay an empty-range delete on every ten-minute run.
 *
 * Every delete is SLICED by time (a day for the short tiers, 30 days for the long
 * ones) with a yield between slices, so one statement never holds the history
 * thread for a whole backlog.
 *
 * A series is purged only after its device has been absent from EVERY successful
 * device listing for a week ({@link DepartureTracker}); it is never judged from the
 * series' own last write, which for a stable change-only series is days old while
 * the device is perfectly alive. An OPTED-OUT device keeps its history until
 * retention ages it out: stopping capture is the switch; deleting history is not.
 */
import type { IScopedLogger } from '@camstack/types'
import type { DepartureTracker } from './departure-tracker.js'
import { DEPARTED_ABSENCE_MS } from './departure-tracker.js'
import type { HistoryCounters } from '../status/counters.js'
import type { HistoryStore, StoredTier } from '../store/history-store.js'
import type { SeriesRegistry } from '../store/series-registry.js'
import { DAY_MS, HOUR_MS } from '../time/bucket-time.js'

export interface RetentionPolicy {
  readonly rawDays: number
  readonly fiveMinuteDays: number
  readonly hourDays: number
  /** `null` (or 0) keeps the daily tier forever. */
  readonly dayDays: number | null
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  rawDays: 7,
  fiveMinuteDays: 30,
  hourDays: 365,
  dayDays: null,
}

/** Cutoff per tier: rows strictly older are deleted. `null` = keep forever. */
export function retentionCutoffs(
  policy: RetentionPolicy,
  now: number,
): Readonly<Record<StoredTier, number | null>> {
  return {
    raw: now - policy.rawDays * DAY_MS,
    '5m': now - policy.fiveMinuteDays * DAY_MS,
    '1h': now - policy.hourDays * DAY_MS,
    '1d': policy.dayDays === null || policy.dayDays <= 0 ? null : now - policy.dayDays * DAY_MS,
  }
}

const TIERS: readonly StoredTier[] = ['raw', '5m', '1h', '1d']
const RETENTION_STEP_MS: Readonly<Record<StoredTier, number>> = {
  raw: HOUR_MS,
  '5m': HOUR_MS,
  '1h': DAY_MS,
  '1d': DAY_MS,
}
const MAX_PURGES_PER_RUN = 20
/** Width of one delete statement's time range, per tier. */
const SLICE_MS: Readonly<Record<StoredTier, number>> = {
  raw: DAY_MS,
  '5m': DAY_MS,
  '1h': 30 * DAY_MS,
  '1d': 30 * DAY_MS,
}
/** A bucket's start may precede the series' first point by up to a day. */
const BUCKET_LEAD_MS = 2 * DAY_MS
/** The short tiers hold nothing older than this unless the operator configured more. */
const SHORT_TIER_LOOKBACK_MS = 400 * DAY_MS

export interface RetentionDeps {
  readonly store: HistoryStore
  readonly registry: SeriesRegistry
  readonly departures: DepartureTracker
  readonly counters: HistoryCounters
  readonly logger: IScopedLogger
  /** Gives the thread back between slices; a spec counts it. */
  readonly yieldNow?: () => Promise<void>
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export class RetentionJob {
  private readonly appliedUpTo = new Map<string, number>()
  private running: Promise<void> | null = null

  constructor(private readonly deps: RetentionDeps) {}

  run(policy: RetentionPolicy, now: number): Promise<void> {
    if (this.running !== null) return this.running
    const run = this.doRun(policy, now).finally(() => {
      this.running = null
    })
    this.running = run
    return run
  }

  private async doRun(policy: RetentionPolicy, now: number): Promise<void> {
    const { registry, counters, logger } = this.deps
    const cutoffs = retentionCutoffs(policy, now)
    try {
      for (const tier of TIERS) {
        const cutoff = cutoffs[tier]
        if (cutoff === null) continue
        for (const series of registry.all()) {
          if (series.firstTs - DAY_MS >= cutoff) continue
          if (tier === 'raw' && registry.metric(series.key)?.ingest === 'buckets') continue
          const marker = `${tier}:${series.id}`
          const applied = this.appliedUpTo.get(marker)
          if (applied !== undefined && cutoff - applied < RETENTION_STEP_MS[tier]) continue
          // From just below the previous cutoff (stragglers) — or the series' start the first time.
          const lo = Math.max(
            0,
            applied === undefined
              ? series.firstTs - BUCKET_LEAD_MS
              : applied - RETENTION_STEP_MS[tier],
          )
          counters.addDeleted(tier, await this.deleteSliced(tier, series.id, lo, cutoff - 1))
          this.appliedUpTo.set(marker, cutoff)
        }
      }
      await this.purgeDeparted(now)
      counters.retentionLastRunAt = now
    } catch (err) {
      logger.warn('device-history: retention pass failed — retried at the next run', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /** Delete `[lo, hiInclusive]` of one tier in time slices, yielding between them. */
  /** Drop the visit markers of a purged series. */
  forgetSeries(seriesId: number): void {
    for (const tier of TIERS) this.appliedUpTo.delete(`${tier}:${seriesId}`)
  }

  private async deleteSliced(
    tier: StoredTier,
    seriesId: number,
    lo: number,
    hiInclusive: number,
  ): Promise<number> {
    const yieldNow = this.deps.yieldNow ?? yieldToEventLoop
    let deleted = 0
    for (let from = lo; from <= hiInclusive; from += SLICE_MS[tier]) {
      const to = Math.min(from + SLICE_MS[tier] - 1, hiInclusive)
      deleted += await this.deps.store.deleteRange(tier, seriesId, from, to)
      await yieldNow()
    }
    return deleted
  }

  /**
   * Tier by tier in slices, then the series row (and whatever the slices missed).
   * Answers the rows the slices deleted per tier. The caller removes the series
   * from the registry, which releases its per-series state.
   */
  async purgeSeries(
    series: { readonly id: number; readonly firstTs: number },
    now: number,
  ): Promise<Readonly<Record<StoredTier, number>>> {
    const deleted: Record<StoredTier, number> = { raw: 0, '5m': 0, '1h': 0, '1d': 0 }
    for (const tier of TIERS) {
      const lo =
        tier === 'raw' || tier === '5m'
          ? Math.max(series.firstTs - BUCKET_LEAD_MS, now - SHORT_TIER_LOOKBACK_MS)
          : series.firstTs - BUCKET_LEAD_MS
      deleted[tier] = await this.deleteSliced(tier, series.id, Math.max(0, lo), now + DAY_MS)
      this.deps.counters.addDeleted(tier, deleted[tier])
    }
    await this.deps.store.deleteSeries(series.id)
    return deleted
  }

  /**
   * Delete every series of a DELETED device now (D865). Driven by a tombstone
   * through the `device-removal-hook`, never by a listing: the week-long
   * absence clock above remains the backstop for a device removed before
   * tombstones existed.
   */
  async purgeDevice(deviceId: number, now: number): Promise<number> {
    const { registry, counters } = this.deps
    let purged = 0
    for (const series of registry.all()) {
      if (series.deviceId !== deviceId) continue
      await this.purgeSeries(series, now)
      registry.remove(series.id)
      counters.purgedSeries += 1
      purged += 1
    }
    return purged
  }

  private async purgeDeparted(now: number): Promise<void> {
    const { registry, departures, counters, logger } = this.deps
    let purged = 0
    for (const series of registry.all()) {
      if (purged >= MAX_PURGES_PER_RUN) break
      if (series.deviceId === null) continue
      // Absent from every successful listing for a week; never judged from the series' own last write.
      const since = departures.missingSince(series.deviceId)
      if (since === undefined || now - since < DEPARTED_ABSENCE_MS) continue
      await this.purgeSeries(series, now)
      registry.remove(series.id)
      counters.purgedSeries += 1
      purged += 1
      logger.info('device-history: purged the series of an unregistered device', {
        tags: { deviceId: series.deviceId },
        meta: { key: series.key },
      })
    }
  }
}
