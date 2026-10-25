/**
 * Counters since boot, read by `getStatus`. Everything the addon DROPS or
 * REFUSES is counted here (D391): a silent branch reads as "never happened".
 * `summarySinceLast` turns the same counters into the aggregated INFO line the
 * runtime logs once per pass.
 */
export type CountedTier = 'raw' | '5m' | '1h' | '1d'

export interface WindowSummary {
  readonly skipped: Record<string, number>
  readonly refused: Record<string, number>
  readonly deleted: Record<string, number>
  readonly flushFailures: number
}

function deltas(
  now: ReadonlyMap<string, number>,
  before: ReadonlyMap<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of now) {
    const d = v - (before.get(k) ?? 0)
    if (d > 0) out[k] = d
  }
  return out
}

export class HistoryCounters {
  eventsSeen = 0
  pointsEmitted = 0
  pointsWritten = 0
  pointsDropped = 0
  trailingEmitted = 0
  reconciledPoints = 0
  reconcileRuns = 0
  reconcileFailures = 0
  lastReconcileAt: number | null = null
  lastFlushAt: number | null = null
  flushFailures = 0
  ingestAccepted = 0
  rollupErrors = 0
  last5mAt: number | null = null
  last1hAt: number | null = null
  last1dAt: number | null = null
  retentionLastRunAt: number | null = null
  purgedSeries = 0
  directoryRefreshAt: number | null = null

  private readonly skipped = new Map<string, number>()
  private readonly refused = new Map<string, number>()
  private readonly deleted = new Map<string, number>()
  private reported: {
    skipped: ReadonlyMap<string, number>
    refused: ReadonlyMap<string, number>
    deleted: ReadonlyMap<string, number>
    flushFailures: number
  } = { skipped: new Map(), refused: new Map(), deleted: new Map(), flushFailures: 0 }

  /** Net rows written minus deleted per tier since boot — the estimate behind `getStatus` row counts. */
  private readonly rowDelta = new Map<CountedTier, number>()
  /** Newest bucket seen per (tier, series): a row beyond it is NEW, a rewrite of an older one is not. */
  private readonly newestBucket = new Map<string, number>()

  skip(reason: string, count = 1): void {
    this.skipped.set(reason, (this.skipped.get(reason) ?? 0) + count)
  }

  refuse(reason: string, count = 1): void {
    this.refused.set(reason, (this.refused.get(reason) ?? 0) + count)
  }

  addDeleted(tier: string, count: number): void {
    if (count <= 0) return
    this.deleted.set(tier, (this.deleted.get(tier) ?? 0) + count)
    if (tier === 'raw' || tier === '5m' || tier === '1h' || tier === '1d') {
      this.rowDelta.set(tier, (this.rowDelta.get(tier) ?? 0) - count)
    }
  }

  addRawRows(count: number): void {
    this.rowDelta.set('raw', (this.rowDelta.get('raw') ?? 0) + count)
  }

  /** Rollup rows written: only a bucket newer than the series' newest known is counted as a new row. */
  noteRollupRows(
    tier: '5m' | '1h' | '1d',
    seriesId: number,
    bucketStarts: readonly number[],
  ): void {
    const marker = `${tier}:${seriesId}`
    let newest = this.newestBucket.get(marker) ?? Number.NEGATIVE_INFINITY
    let added = 0
    for (const b of bucketStarts) {
      if (b > newest) {
        added += 1
        newest = b
      }
    }
    this.newestBucket.set(marker, newest)
    if (added > 0) this.rowDelta.set(tier, (this.rowDelta.get(tier) ?? 0) + added)
  }

  rowDeltaOf(tier: CountedTier): number {
    return this.rowDelta.get(tier) ?? 0
  }

  forgetSeries(seriesId: number): void {
    for (const tier of ['5m', '1h', '1d']) this.newestBucket.delete(`${tier}:${seriesId}`)
  }

  skippedRecord(): Record<string, number> {
    return Object.fromEntries(this.skipped)
  }

  refusedRecord(): Record<string, number> {
    return Object.fromEntries(this.refused)
  }

  deletedRecord(): Record<string, number> {
    return Object.fromEntries(this.deleted)
  }

  /** What was skipped, refused, deleted or failed since the last call; `null` when nothing. */
  summarySinceLast(): WindowSummary | null {
    const summary: WindowSummary = {
      skipped: deltas(this.skipped, this.reported.skipped),
      refused: deltas(this.refused, this.reported.refused),
      deleted: deltas(this.deleted, this.reported.deleted),
      flushFailures: this.flushFailures - this.reported.flushFailures,
    }
    this.reported = {
      skipped: new Map(this.skipped),
      refused: new Map(this.refused),
      deleted: new Map(this.deleted),
      flushFailures: this.flushFailures,
    }
    const quiet =
      Object.keys(summary.skipped).length === 0 &&
      Object.keys(summary.refused).length === 0 &&
      Object.keys(summary.deleted).length === 0 &&
      summary.flushFailures === 0
    return quiet ? null : summary
  }
}
