/**
 * Pipeline-analytics numeric history — device-history producer (D850, LTS P4).
 *
 * Five-minute series (`motion`, `audio-dbfs`, `occupancy`) use
 * {@link BucketAccumulator} + `recordBuckets`. Audio level peaks use `record`
 * on `addon:pipeline-analytics/audio-level`. Battery is captured generically
 * from the `battery` cap — not produced here.
 */

import type { DeviceHistoryIngestResult, IScopedLogger } from '@camstack/types'
import type { AnalyticsLtsSeries } from './analytics-history-keys.js'
import { BucketAccumulator, type ClosedHistoryBucket } from '@camstack/types'
import {
  ANALYTICS_AUDIO_LEVEL_KEY,
  ANALYTICS_HISTORY_BUCKET_SERIES,
  historyKeyForLtsSeries,
  type AnalyticsHistoryBucketSeriesName,
} from './analytics-history-keys.js'

export { ANALYTICS_AUDIO_LEVEL_KEY, ANALYTICS_HISTORY_BUCKET_SERIES, historyKeyForLtsSeries }
export { occupancyScope, parseOccupancyScope } from '@camstack/types'

export interface DeviceHistoryWriteClient {
  declareSeries(input: {
    name: string
    subjectKind: 'device' | 'node'
    kind: 'gauge' | 'counter' | 'boolean'
    unit?: string
    displayName: string
    ingest: 'points' | 'buckets'
  }): Promise<{ key: string }>
  record(input: {
    points: ReadonlyArray<{
      key: string
      subject: { kind: 'device'; deviceId: number }
      scope: string
      ts: number
      value: number
    }>
  }): Promise<DeviceHistoryIngestResult>
  recordBuckets(input: {
    buckets: readonly ClosedHistoryBucket[]
  }): Promise<DeviceHistoryIngestResult>
  query(input: {
    deviceId: number
    key: string
    scope?: string
    from: number
    to: number
    resolution: '5m'
    maxPoints?: number
  }): Promise<{
    series: ReadonlyArray<{
      scope: string
      points: ReadonlyArray<{
        t: number
        samples: number
        mean: number | null
        min: number
        max: number
      }>
    }>
  }>
}

export interface AnalyticsHistoryProducerDeps {
  readonly deviceHistory: DeviceHistoryWriteClient
  readonly logger: IScopedLogger
  readonly now?: () => number
}

const BUCKET_SERIES_META: ReadonlyArray<{
  readonly name: AnalyticsHistoryBucketSeriesName
  readonly displayName: string
  readonly unit?: string
}> = [
  { name: 'motion', displayName: 'Motion events (region count)' },
  { name: 'audio-dbfs', displayName: 'Audio noise baseline (dBFS)', unit: 'dBFS' },
  { name: 'occupancy', displayName: 'Occupancy count' },
]

const AUDIO_LEVEL_SERIES = {
  name: 'audio-level',
  displayName: 'Audio level (dBFS)',
  unit: 'dBFS',
} as const

/** One audio level point per window; equals device-history's 1 point / 10 s record bound. */
const AUDIO_LEVEL_WINDOW_MS = 10_000
/**
 * Stored for a measured-silent window (−∞ dBFS cannot be a history value).
 * A sentinel below the 16-bit floor, not a calibration of any meter.
 *
 * @dbfs-era scale-bound
 */
const AUDIO_LEVEL_SILENT_DBFS = -120

function refusalCounts(result: DeviceHistoryIngestResult): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of result.refused) counts[r.reason] = (counts[r.reason] ?? 0) + r.count
  return counts
}

export class AnalyticsHistoryProducer {
  private readonly accum = new BucketAccumulator()
  private readonly deviceHistory: DeviceHistoryWriteClient
  private readonly logger: IScopedLogger
  private readonly nowFn: () => number
  private declared = false
  private readonly levelWindows = new Map<number, { start: number; peak: number }>()

  constructor(deps: AnalyticsHistoryProducerDeps) {
    this.deviceHistory = deps.deviceHistory
    this.logger = deps.logger
    this.nowFn = deps.now ?? ((): number => Date.now())
  }

  async declare(): Promise<void> {
    if (this.declared) return
    for (const meta of BUCKET_SERIES_META) {
      await this.deviceHistory.declareSeries({
        name: meta.name,
        subjectKind: 'device',
        kind: 'gauge',
        displayName: meta.displayName,
        ingest: 'buckets',
        ...(meta.unit !== undefined ? { unit: meta.unit } : {}),
      })
    }
    await this.deviceHistory.declareSeries({
      name: AUDIO_LEVEL_SERIES.name,
      subjectKind: 'device',
      kind: 'gauge',
      displayName: AUDIO_LEVEL_SERIES.displayName,
      unit: AUDIO_LEVEL_SERIES.unit,
      ingest: 'points',
    })
    this.declared = true
  }

  note(
    series: AnalyticsHistoryBucketSeriesName,
    deviceId: number,
    value: number,
    at?: number,
    scope?: string,
  ): void {
    const key = ANALYTICS_HISTORY_BUCKET_SERIES[series]
    this.accum.note(key, { kind: 'device', deviceId }, scope ?? '', value, at ?? this.nowFn())
  }

  /**
   * Feed EVERY analysed audio sample. One point per window of
   * {@link AUDIO_LEVEL_WINDOW_MS} is written, stamped at the window's first
   * sample, carrying the window's PEAK dBFS: a 2 s spike inside a stable window
   * is not averaged away, and stable audio still yields a point each window
   * (continuity over dedup — the level bar draws a continuous line).
   *
   * Measured silence (−∞) is stored at {@link AUDIO_LEVEL_SILENT_DBFS}: it is a
   * measurement, not an absence (D431); NaN carries no claim and is dropped.
   * A window closes on the first sample past its end, so no timer is needed and
   * points are always at least a window apart (the history's 1 point / 10 s
   * bound).
   */
  observeAudioLevel(deviceId: number, dbfs: number, at: number): void {
    if (Number.isNaN(dbfs)) return
    const value = Number.isFinite(dbfs) ? dbfs : AUDIO_LEVEL_SILENT_DBFS
    const win = this.levelWindows.get(deviceId)
    if (win === undefined) {
      this.levelWindows.set(deviceId, { start: at, peak: value })
      return
    }
    if (at - win.start < AUDIO_LEVEL_WINDOW_MS) {
      if (value > win.peak) this.levelWindows.set(deviceId, { start: win.start, peak: value })
      return
    }
    this.levelWindows.set(deviceId, { start: at, peak: value })
    this.recordAudioLevel(deviceId, win.peak, win.start)
  }

  recordAudioLevel(deviceId: number, dbfs: number, at: number): void {
    const record = this.deviceHistory.record
    if (record === undefined) return
    void this.declare()
      .then(() =>
        record.call(this.deviceHistory, {
          points: [
            {
              key: ANALYTICS_AUDIO_LEVEL_KEY,
              subject: { kind: 'device', deviceId },
              scope: '',
              ts: at,
              value: dbfs,
            },
          ],
        }),
      )
      .then((result) => {
        if (result.refused.length === 0) return
        if (result.refused.some((r) => r.reason === 'undeclared')) this.declared = false
        this.logger.warn('audio level history point refused', {
          tags: { deviceId },
          meta: { refused: refusalCounts(result) },
        })
      })
      .catch((err: unknown) => {
        this.logger.warn('audio level history point not stored', {
          tags: { deviceId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
  }

  async flushDue(now?: number): Promise<number> {
    const at = now ?? this.nowFn()
    const closed = this.accum.takeClosed(at)
    if (closed.length === 0) return 0
    try {
      await this.declare()
      const result = await this.deviceHistory.recordBuckets({ buckets: closed })
      if (result.refused.length > 0) {
        if (result.refused.some((r) => r.reason === 'undeclared')) {
          this.declared = false
          this.accum.requeue(closed)
        }
        this.logger.warn('analytics history buckets refused', {
          meta: {
            buckets: closed.length,
            accepted: result.accepted,
            refused: refusalCounts(result),
          },
        })
      }
      return result.accepted
    } catch (err: unknown) {
      const dropped = this.accum.requeue(closed)
      this.logger.warn('analytics history bucket flush failed — requeued', {
        meta: {
          buckets: closed.length,
          dropped: dropped.length,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return 0
    }
  }

  pendingBucketCount(): number {
    return this.accum.pendingBucketCount()
  }

  async readLongTermBuckets(input: {
    deviceId: number
    series: AnalyticsLtsSeries
    scope?: string
    from: number
    to: number
    limit?: number
  }): Promise<
    ReadonlyArray<{
      scope: string
      bucketStart: number
      samples: number
      sum: number
      min: number
      max: number
    }>
  > {
    const key = historyKeyForLtsSeries(input.series)
    const result = await this.deviceHistory.query({
      deviceId: input.deviceId,
      key,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      from: input.from,
      to: input.to,
      resolution: '5m',
      ...(input.limit !== undefined ? { maxPoints: input.limit } : {}),
    })
    const out: Array<{
      scope: string
      bucketStart: number
      samples: number
      sum: number
      min: number
      max: number
    }> = []
    for (const s of result.series) {
      for (const p of s.points) {
        // mean null is UNKNOWN (D393) — never invent sum=0 from samples>0.
        if (p.mean === null) continue
        out.push({
          scope: s.scope,
          bucketStart: p.t,
          samples: p.samples,
          sum: p.mean * p.samples,
          min: p.min,
          max: p.max,
        })
      }
    }
    return out.toSorted((a, b) => a.bucketStart - b.bucketStart)
  }

  /** Admin debug read — maps device-history 5m buckets to legacy LTS row shape. */
  async readDebug(input: {
    subject?: string
    series?: string
    scope?: string
    from?: number
    to?: number
    limit?: number
  }): Promise<
    ReadonlyArray<{
      subject: string
      deviceId?: number
      series: string
      scope: string
      bucketStart: number
      samples: number
      sum: number
      min: number
      max: number
    }>
  > {
    const deviceId = input.subject !== undefined ? Number(input.subject) : Number.NaN
    if (!Number.isFinite(deviceId) || input.series === undefined) return []
    const key = historyKeyForLtsSeries(input.series as AnalyticsLtsSeries)
    const result = await this.deviceHistory.query({
      deviceId,
      key,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      from: input.from ?? 0,
      to: input.to ?? this.nowFn(),
      resolution: '5m',
      ...(input.limit !== undefined ? { maxPoints: input.limit } : {}),
    })
    const rows: Array<{
      subject: string
      deviceId?: number
      series: string
      scope: string
      bucketStart: number
      samples: number
      sum: number
      min: number
      max: number
    }> = []
    for (const s of result.series) {
      for (const p of s.points) {
        if (p.mean === null) continue
        rows.push({
          subject: String(deviceId),
          deviceId,
          series: input.series,
          scope: s.scope,
          bucketStart: p.t,
          samples: p.samples,
          sum: p.mean * p.samples,
          min: p.min,
          max: p.max,
        })
      }
    }
    return rows
  }

  openBucketsForDebug(): readonly [] {
    return []
  }
}
