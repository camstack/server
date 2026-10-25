/**
 * The write buffer for raw points — cap-field captures and producer `record`
 * calls alike (plan §5.3): points are buffered and written with ONE batched
 * `upsertMany` every flush (10 s), because the capture rate is bursty and the
 * history thread should see a handful of transactions, not hundreds.
 *
 * A failed write KEEPS the batch (it goes back to the front of the queue and is
 * retried at the next flush). Both bounds drop work OUT LOUD (D391):
 *  - a point older than {@link MAX_BUFFER_AGE_MS} after a failed write;
 *  - the OLDEST points when the queue passes {@link MAX_QUEUE_POINTS}, which a
 *    flush that hangs would otherwise let grow without limit.
 * A drop logs one ERROR with the count, one tagged line per device (rate-capped),
 * and tells the owner through `onDropped` so the capture engine forgets that it
 * ever "recorded" those values — otherwise the next change-only comparison runs
 * against a value that was never stored and the hole lasts until the value moves.
 */
import type { DeviceHistorySubject, IScopedLogger } from '@camstack/types'
import type { SeriesRegistry } from '../store/series-registry.js'
import type { HistoryStore } from '../store/history-store.js'
import type { HistoryCounters } from '../status/counters.js'

export const FLUSH_INTERVAL_MS = 10_000
export const MAX_BUFFER_AGE_MS = 60_000
/** Beyond this many queued points the oldest are dropped. */
export const MAX_QUEUE_POINTS = 100_000
/** The share of the queue dropped at once when it is full. */
const QUEUE_DROP_FRACTION = 0.1
/** Device ids named in a drop line, so a line stays short. */
const MAX_DEVICES_IN_DROP_LINE = 20
/** Tagged per-device drop lines per event, and the quiet time between events that print them. */
const MAX_DEVICE_LINES_PER_DROP = 10
const DEVICE_LINES_MIN_GAP_MS = 10_000

export interface BufferedPoint {
  readonly key: string
  readonly subject: DeviceHistorySubject
  readonly scope: string
  readonly ts: number
  readonly value: number
  readonly bufferedAt: number
}

export interface WrittenPoints {
  readonly seriesId: number
  readonly timestamps: readonly number[]
}

export interface PointWriterDeps {
  readonly registry: SeriesRegistry
  readonly store: HistoryStore
  readonly counters: HistoryCounters
  readonly logger: IScopedLogger
  readonly clock: () => number
  /** Called after a batch landed, so the rollup engine can mark the buckets dirty. */
  readonly onWritten: (written: readonly WrittenPoints[]) => void
  /** Called with points that were buffered and then dropped. */
  readonly onDropped: (dropped: readonly BufferedPoint[]) => void
}

export class PointWriter {
  private queue: BufferedPoint[] = []
  private flushing: Promise<void> | null = null
  private lastDeviceLinesAt = Number.NEGATIVE_INFINITY

  constructor(private readonly deps: PointWriterDeps) {}

  enqueue(point: Omit<BufferedPoint, 'bufferedAt'>): void {
    this.queue.push({ ...point, bufferedAt: this.deps.clock() })
    if (this.queue.length > MAX_QUEUE_POINTS) {
      const count = Math.ceil(MAX_QUEUE_POINTS * QUEUE_DROP_FRACTION)
      this.drop(this.queue.splice(0, count), 'queue full')
    }
  }

  depth(): number {
    return this.queue.length
  }

  /** One flush at a time; a call while one runs waits for it and returns. */
  flush(): Promise<void> {
    if (this.flushing !== null) return this.flushing
    const run = this.doFlush().finally(() => {
      this.flushing = null
    })
    this.flushing = run
    return run
  }

  private async doFlush(): Promise<void> {
    const batch = this.queue
    if (batch.length === 0) return
    this.queue = []
    const { registry, store, counters, logger, clock } = this.deps
    try {
      // A learned enum value is stored before the first point that names its ordinal.
      await registry.persistDirtyMetrics()
      const bySeries = new Map<number, { ts: number; value: number }[]>()
      for (const point of batch) {
        const series = await registry.ensure(point.key, point.subject, point.scope, point.ts)
        const list = bySeries.get(series.id) ?? []
        list.push({ ts: point.ts, value: point.value })
        bySeries.set(series.id, list)
      }
      const rows = [...bySeries].flatMap(([seriesId, points]) =>
        points.map((p) => ({ seriesId, ts: p.ts, value: p.value })),
      )
      await store.upsertRaw(rows)
      await this.recordSpans(bySeries)
      counters.pointsWritten += rows.length
      counters.addRawRows(rows.length)
      counters.lastFlushAt = clock()
      this.deps.onWritten(
        [...bySeries].map(([seriesId, points]) => ({
          seriesId,
          timestamps: points.map((p) => p.ts),
        })),
      )
    } catch (err) {
      counters.flushFailures += 1
      logger.warn('device-history: raw flush failed — keeping the batch', {
        meta: { points: batch.length, error: err instanceof Error ? err.message : String(err) },
      })
      this.requeue(batch)
    }
  }

  private async recordSpans(
    bySeries: ReadonlyMap<number, readonly { ts: number; value: number }[]>,
  ): Promise<void> {
    const { registry, store } = this.deps
    const touch: { id: number; lastTs: number }[] = []
    for (const [seriesId, points] of bySeries) {
      const current = registry.byIdOf(seriesId)
      if (current === undefined) continue
      let minTs = Number.POSITIVE_INFINITY
      let maxTs = Number.NEGATIVE_INFINITY
      for (const p of points) {
        if (p.ts < minTs) minTs = p.ts
        if (p.ts > maxTs) maxTs = p.ts
      }
      if (minTs < current.firstTs) await store.widenSeriesStart(seriesId, minTs)
      if (maxTs > current.lastTs) touch.push({ id: seriesId, lastTs: maxTs })
      registry.noteSpan(seriesId, minTs, maxTs)
    }
    await store.touchSeries(touch)
  }

  private requeue(batch: readonly BufferedPoint[]): void {
    const now = this.deps.clock()
    const keep: BufferedPoint[] = []
    const dropped: BufferedPoint[] = []
    for (const point of batch) {
      if (now - point.bufferedAt > MAX_BUFFER_AGE_MS) dropped.push(point)
      else keep.push(point)
    }
    this.queue = [...keep, ...this.queue]
    if (dropped.length > 0) this.drop(dropped, `older than ${MAX_BUFFER_AGE_MS} ms`)
  }

  /** Account for, say, and report to the owner a set of points that will never be written. */
  private drop(dropped: readonly BufferedPoint[], reason: string): void {
    if (dropped.length === 0) return
    const { counters, logger, clock } = this.deps
    counters.pointsDropped += dropped.length
    const perDevice = new Map<number, number>()
    for (const p of dropped) {
      if (p.subject.kind === 'device') {
        perDevice.set(p.subject.deviceId, (perDevice.get(p.subject.deviceId) ?? 0) + 1)
      }
    }
    logger.error('device-history: dropped points the store would not take', {
      meta: {
        dropped: dropped.length,
        reason,
        maxAgeMs: MAX_BUFFER_AGE_MS,
        deviceIds: [...perDevice.keys()].slice(0, MAX_DEVICES_IN_DROP_LINE),
      },
    })
    const now = clock()
    if (now - this.lastDeviceLinesAt >= DEVICE_LINES_MIN_GAP_MS) {
      this.lastDeviceLinesAt = now
      for (const [deviceId, count] of [...perDevice].slice(0, MAX_DEVICE_LINES_PER_DROP)) {
        logger.warn('device-history: points dropped for this device', {
          tags: { deviceId },
          meta: { dropped: count, reason },
        })
      }
    }
    this.deps.onDropped(dropped)
  }
}
