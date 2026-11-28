/**
 * Delete a time range of one series' points (admin, operator-judged): the raw
 * points in `[from, to]` go, and every rollup row that covered them is removed
 * and REBUILT from what remains — the same recompute the rollup engine runs
 * for a late write, so a gap never leaves a stale max, sum or held value.
 *
 * What a rollup row depends on beyond its own bucket is the value HELD into it:
 * the first bucket with points after the range carried the deleted value in,
 * so the covered 5-minute span runs up to and including that bucket. The 1h
 * and 1d spans follow from it. A dry run counts exactly those ranges with
 * primary-key range counts (D447) and changes nothing.
 *
 * The whole delete-and-rebuild runs EXCLUSIVELY with the rollup tick (a tick
 * that read rows before the delete would otherwise write them back). It is not
 * one transaction: a crash between tiers leaves rollups stale, and running the
 * SAME call again repairs it (every step is a range delete or a recompute from
 * what remains, so a repeat is idempotent). A point captured inside the range
 * AFTER the initial flush survives: only what was stored then is judged.
 */
import type {
  DeviceHistoryRangeDeleteResult,
  DeviceHistoryTierRows,
  IScopedLogger,
} from '@dominevo/types'
import type { RollupEngine } from '../rollup/rollup-engine.js'
import type { HistoryStore, SeriesRecord } from '../store/history-store.js'
import type { SeriesRegistry } from '../store/series-registry.js'
import {
  FIVE_MINUTES_MS,
  HOUR_MS,
  bucketEndOf,
  bucketStartOf,
  floorTo,
} from '../time/bucket-time.js'

/** The widest range one call takes: 31 days. A longer one is deleted in several calls. */
export const RANGE_DELETE_MAX_MS: number = 31 * 24 * HOUR_MS

export interface RangeDeleteInput {
  readonly deviceId: number
  readonly key: string
  readonly scope: string
  readonly fromMs: number
  readonly toMs: number
  readonly dryRun: boolean
}

export interface RangeDeleteDeps {
  readonly store: HistoryStore
  readonly registry: SeriesRegistry
  readonly rollup: RollupEngine
  readonly logger: IScopedLogger
  readonly clock: () => number
  /** Write what the capture buffer still holds, so a pending point is not written after the delete. */
  readonly flush: () => Promise<void>
}

/** The rollup rows a delete of `[from, to]` covers, as inclusive bucket-start ranges. */
interface CoveredSpan {
  readonly m5: readonly [number, number]
  readonly h1: readonly [number, number]
  readonly d1: readonly [number, number]
}

export class RangeDelete {
  constructor(private readonly deps: RangeDeleteDeps) {}

  async run(input: RangeDeleteInput): Promise<DeviceHistoryRangeDeleteResult> {
    const { registry } = this.deps
    if (!(input.fromMs < input.toMs)) return { ok: false, reason: 'invalid-range' }
    if (input.toMs - input.fromMs > RANGE_DELETE_MAX_MS) {
      return { ok: false, reason: 'range-too-large' }
    }
    const series = registry.find(input.key, `d:${input.deviceId}`, input.scope)
    if (series === undefined) return { ok: false, reason: 'series-not-found' }
    if (registry.metric(series.key)?.ingest !== 'points') {
      return { ok: false, reason: 'not-a-point-series' }
    }
    return this.deps.rollup.exclusive(() => this.apply(series, input))
  }

  private async apply(
    series: SeriesRecord,
    input: RangeDeleteInput,
  ): Promise<DeviceHistoryRangeDeleteResult> {
    const { store, logger } = this.deps
    await this.deps.flush()
    const span = await this.coveredSpan(series, input)
    if (input.dryRun) {
      const rows = await this.countRows(series.id, input, span)
      logger.debug('device-history: dry run of a range delete', {
        tags: { deviceId: input.deviceId },
        meta: { key: series.key, fromMs: input.fromMs, toMs: input.toMs, rows },
      })
      return { ok: true, dryRun: true, seriesId: series.id, rows, rewritten: null }
    }
    const rows: DeviceHistoryTierRows = {
      raw: await store.deleteRange('raw', series.id, input.fromMs, input.toMs),
      '5m': await store.deleteRange('5m', series.id, span.m5[0], span.m5[1]),
      '1h': await store.deleteRange('1h', series.id, span.h1[0], span.h1[1]),
      '1d': await store.deleteRange('1d', series.id, span.d1[0], span.d1[1]),
    }
    const rewritten = await this.rebuild(series.id, span)
    logger.info('device-history: deleted a range of points', {
      tags: { deviceId: input.deviceId },
      meta: {
        key: series.key,
        scope: series.scope,
        fromMs: input.fromMs,
        toMs: input.toMs,
        rows,
        rewritten,
      },
    })
    return { ok: true, dryRun: false, seriesId: series.id, rows, rewritten }
  }

  private async coveredSpan(series: SeriesRecord, input: RangeDeleteInput): Promise<CoveredSpan> {
    const [next] = await this.deps.store.readRaw(
      series.id,
      input.toMs + 1,
      Number.MAX_SAFE_INTEGER,
      1,
    )
    const lastBucket = floorTo(next?.ts ?? input.toMs, FIVE_MINUTES_MS)
    const m5: readonly [number, number] = [floorTo(input.fromMs, FIVE_MINUTES_MS), lastBucket]
    const h1: readonly [number, number] = [floorTo(m5[0], HOUR_MS), floorTo(m5[1], HOUR_MS)]
    const d1: readonly [number, number] = [bucketStartOf('1d', h1[0]), bucketStartOf('1d', h1[1])]
    return { m5, h1, d1 }
  }

  private async countRows(
    seriesId: number,
    input: RangeDeleteInput,
    span: CoveredSpan,
  ): Promise<DeviceHistoryTierRows> {
    const { store } = this.deps
    return {
      raw: await store.countRange('raw', seriesId, input.fromMs, input.toMs),
      '5m': await store.countRange('5m', seriesId, span.m5[0], span.m5[1]),
      '1h': await store.countRange('1h', seriesId, span.h1[0], span.h1[1]),
      '1d': await store.countRange('1d', seriesId, span.d1[0], span.d1[1]),
    }
  }

  /** Rebuild the removed rows from what remains, tier by tier; returns the rows written. */
  private async rebuild(
    seriesId: number,
    span: CoveredSpan,
  ): Promise<{ readonly '5m': number; readonly '1h': number; readonly '1d': number }> {
    const { rollup, store, clock } = this.deps
    const now = clock()
    const m5 = await rollup.recomputeFiveMinute(
      seriesId,
      span.m5[0],
      span.m5[1] + FIVE_MINUTES_MS,
      now,
    )
    for (let hour = span.h1[0]; hour <= span.h1[1]; hour += HOUR_MS) {
      await rollup.recomputeBucket('1h', seriesId, hour, now)
    }
    const h1 = await store.countRange('1h', seriesId, span.h1[0], span.h1[1])
    for (let day = span.d1[0]; day <= span.d1[1]; day = bucketEndOf('1d', day)) {
      await rollup.recomputeBucket('1d', seriesId, day, now)
    }
    const d1 = await store.countRange('1d', seriesId, span.d1[0], span.d1[1])
    return { '5m': m5, '1h': h1, '1d': d1 }
  }
}
