/**
 * The producer door (plan §5.1): `declareSeries`, `record`, `recordBuckets`.
 *
 * Ownership is the transport-stamped caller (`callerAddonId`), never anything
 * the caller claims; a key is `addon:<callerAddonId>/<name>`, so one addon can
 * only ever declare keys inside its own prefix and a write to another addon's
 * key is `not-owner`. Every refusal is COUNTED per (key, reason) and returned
 * (D391): a producer that is silently dropped looks exactly like one that never
 * produced.
 *
 * `record` is for low-rate points (at most one per 10 s per series, sustained);
 * `recordBuckets` takes CLOSED five-minute buckets and is an idempotent upsert
 * keyed (series, bucketStart), written before the call returns so a failure
 * reaches the producer, which re-queues (D58).
 */
import {
  type DeviceHistoryIngestResult,
  type DeviceHistoryRefusalReason,
  type DeviceHistorySubject,
  type IScopedLogger,
} from '@camstack/types'
import type { DeviceDirectory } from '../capture/device-directory.js'
import { isRealDeviceType } from '../capture/device-directory.js'
import type { PointWriter } from '../capture/point-writer.js'
import type { RollupRow } from '../rollup/rollup-math.js'
import type { HistoryCounters } from '../status/counters.js'
import type { HistoryStore, MetricRecord } from '../store/history-store.js'
import { identityOf, type SeriesRegistry, subjectIdOf } from '../store/series-registry.js'
import { FIVE_MINUTES_MS } from '../time/bucket-time.js'

/** One point per series per this many ms, sustained. */
export const RECORD_MIN_INTERVAL_MS: number = 10_000
/**
 * How early a point may land against its series' next slot. A producer on a
 * `setInterval` at exactly {@link RECORD_MIN_INTERVAL_MS} stamps `Date.now()`
 * on each tick, and a tick lands a few ms EARLY as often as late; a bare
 * `ts - last < interval` refused every early tick's whole batch (`.50`:
 * `accepted: 0, refused: { rate: 141 }`). The slack is borrowed from the slot
 * grid, never added to the rate: the next slot advances from the slot this
 * point consumed, so a faster producer is still held to one point per interval.
 */
export const RECORD_RATE_SLACK_MS: number = 1_000
/** A point or bucket may be at most this far in the future (clock skew). */
export const FUTURE_TOLERANCE_MS: number = 5 * 60_000

export interface DeclareSeriesInput {
  readonly name: string
  readonly subjectKind: 'device' | 'node'
  readonly kind: 'gauge' | 'counter' | 'boolean'
  readonly unit?: string
  readonly displayName: string
  readonly ingest: 'points' | 'buckets'
}

export interface RecordPointInput {
  readonly key: string
  readonly subject: DeviceHistorySubject
  readonly scope: string
  readonly ts: number
  readonly value: number
}

export interface RecordBucketInput {
  readonly key: string
  readonly subject: DeviceHistorySubject
  readonly scope: string
  readonly bucketStart: number
  readonly samples: number
  readonly sum: number
  readonly min: number
  readonly max: number
  readonly last: number | null
  readonly lastTs: number | null
}

export interface IngestDeps {
  readonly registry: SeriesRegistry
  readonly store: HistoryStore
  readonly directory: DeviceDirectory
  readonly writer: PointWriter
  readonly counters: HistoryCounters
  readonly logger: IScopedLogger
  readonly clock: () => number
  readonly optedOut: () => ReadonlySet<number>
  readonly retention: () => { readonly rawMs: number; readonly fiveMinuteMs: number }
  /** A 5m row landed; the hour containing it is dirty. */
  readonly onBucketWritten: (seriesId: number, bucketStart: number) => void
}

/** The rate state of one (series, subject, scope). */
interface RateSlot {
  /** The newest point time accepted. */
  readonly lastTs: number
  /** When the next point is due; it may land {@link RECORD_RATE_SLACK_MS} early. */
  readonly nextDue: number
}

/**
 * The slot after accepting a point at `ts`. A point older than the newest
 * accepted one (a late arrival) moves nothing. Otherwise the consumed slot is
 * the later of the one that was due and `ts` itself: an early point uses the
 * due slot (the grid holds, so slack never compounds into a higher rate), a
 * late one restarts the grid at `ts` (no credit is banked for a gap).
 */
function nextSlot(slot: RateSlot | undefined, ts: number): RateSlot {
  if (slot === undefined) return { lastTs: ts, nextDue: ts + RECORD_MIN_INTERVAL_MS }
  if (ts < slot.lastTs) return slot
  return { lastTs: ts, nextDue: Math.max(slot.nextDue, ts) + RECORD_MIN_INTERVAL_MS }
}

type Refusals = Map<string, Map<DeviceHistoryRefusalReason, number>>

function addRefusal(refusals: Refusals, key: string, reason: DeviceHistoryRefusalReason): void {
  const byReason = refusals.get(key) ?? new Map<DeviceHistoryRefusalReason, number>()
  byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  refusals.set(key, byReason)
}

function toResult(accepted: number, refusals: Refusals): DeviceHistoryIngestResult {
  return {
    accepted,
    refused: [...refusals].flatMap(([key, byReason]) =>
      [...byReason].map(([reason, count]) => ({ key, reason, count })),
    ),
  }
}

export class ProducerIngest {
  /** Rate state per series identity, for the sustained-rate bound. */
  private readonly lastAccepted = new Map<string, RateSlot>()

  constructor(private readonly deps: IngestDeps) {}

  /** A purged series leaves no rate-limit state behind. */
  forgetSeries(series: { key: string; subject: string; scope: string }): void {
    this.lastAccepted.delete(identityOf(series.key, series.subject, series.scope))
  }

  async declareSeries(
    callerAddonId: string | null,
    input: DeclareSeriesInput,
  ): Promise<{ key: string }> {
    if (callerAddonId === null) {
      throw new Error('declareSeries: the caller addon could not be identified')
    }
    const key = `addon:${callerAddonId}/${input.name}`
    const metric: MetricRecord = {
      key,
      source: 'addon',
      ownerAddon: callerAddonId,
      subjectKind: input.subjectKind,
      kind: input.kind,
      unit: input.unit ?? null,
      displayName: input.displayName,
      ingest: input.ingest,
      declaredAt: this.deps.clock(),
      values: null,
    }
    await this.deps.registry.declareMetric(metric)
    return { key }
  }

  /** Why a write to `metric` by `caller` for this subject must be refused, or null. */
  private async refusalFor(
    callerAddonId: string | null,
    metric: MetricRecord | undefined,
    ingest: 'points' | 'buckets',
    subject: DeviceHistorySubject,
  ): Promise<DeviceHistoryRefusalReason | null> {
    if (metric === undefined) return 'undeclared'
    if (callerAddonId === null || metric.ownerAddon !== callerAddonId) return 'not-owner'
    if (metric.ingest !== ingest) return 'ingest-mismatch'
    if (metric.subjectKind !== subject.kind) return 'undeclared'
    if (subject.kind === 'device') {
      if (this.deps.optedOut().has(subject.deviceId)) return 'opted-out'
      const type = await this.deps.directory.ensure(subject.deviceId)
      if (type === undefined || !isRealDeviceType(type)) return 'not-a-real-device'
    }
    return null
  }

  async record(
    callerAddonId: string | null,
    points: readonly RecordPointInput[],
  ): Promise<DeviceHistoryIngestResult> {
    const { clock, counters } = this.deps
    const now = clock()
    const { rawMs } = this.deps.retention()
    const refusals: Refusals = new Map()
    let accepted = 0
    for (const point of points) {
      const reason = await this.refusalFor(
        callerAddonId,
        this.deps.registry.metric(point.key),
        'points',
        point.subject,
      )
      if (reason !== null) {
        addRefusal(refusals, point.key, reason)
        counters.refuse(reason)
        continue
      }
      if (
        !Number.isFinite(point.value) ||
        !Number.isFinite(point.ts) ||
        point.ts > now + FUTURE_TOLERANCE_MS ||
        point.ts < now - rawMs
      ) {
        addRefusal(refusals, point.key, 'out-of-range')
        counters.refuse('out-of-range')
        continue
      }
      const identity = identityOf(point.key, subjectIdOf(point.subject), point.scope)
      const slot = this.lastAccepted.get(identity)
      if (
        slot !== undefined &&
        point.ts >= slot.lastTs &&
        point.ts < slot.nextDue - RECORD_RATE_SLACK_MS
      ) {
        addRefusal(refusals, point.key, 'rate')
        counters.refuse('rate')
        continue
      }
      this.lastAccepted.set(identity, nextSlot(slot, point.ts))
      this.deps.writer.enqueue({
        key: point.key,
        subject: point.subject,
        scope: point.scope,
        ts: point.ts,
        value: point.value,
      })
      accepted += 1
    }
    counters.ingestAccepted += accepted
    return toResult(accepted, refusals)
  }

  async recordBuckets(
    callerAddonId: string | null,
    buckets: readonly RecordBucketInput[],
  ): Promise<DeviceHistoryIngestResult> {
    const { clock, counters, registry, store } = this.deps
    const now = clock()
    const { fiveMinuteMs } = this.deps.retention()
    const refusals: Refusals = new Map()
    const rows: RollupRow[] = []
    for (const bucket of buckets) {
      const reason = await this.refusalFor(
        callerAddonId,
        registry.metric(bucket.key),
        'buckets',
        bucket.subject,
      )
      if (reason !== null) {
        addRefusal(refusals, bucket.key, reason)
        counters.refuse(reason)
        continue
      }
      const aligned = bucket.bucketStart % FIVE_MINUTES_MS === 0
      const consistent =
        Number.isFinite(bucket.sum) &&
        Number.isFinite(bucket.min) &&
        Number.isFinite(bucket.max) &&
        bucket.min <= bucket.max
      if (
        !aligned ||
        !consistent ||
        bucket.bucketStart > now + FUTURE_TOLERANCE_MS ||
        bucket.bucketStart < now - fiveMinuteMs
      ) {
        addRefusal(refusals, bucket.key, 'out-of-range')
        counters.refuse('out-of-range')
        continue
      }
      const series = await registry.ensure(
        bucket.key,
        bucket.subject,
        bucket.scope,
        bucket.bucketStart,
      )
      rows.push({
        seriesId: series.id,
        bucketStart: bucket.bucketStart,
        samples: bucket.samples,
        sum: bucket.sum,
        min: bucket.min,
        max: bucket.max,
        last: bucket.last,
        lastTs: bucket.lastTs,
        twSum: null,
        twMs: null,
        states: null,
      })
    }
    // Written before returning: a store failure must reach the producer so it re-queues.
    await store.upsertRollups('5m', rows)
    const bySeries = new Map<number, number[]>()
    for (const row of rows)
      bySeries.set(row.seriesId, [...(bySeries.get(row.seriesId) ?? []), row.bucketStart])
    for (const [seriesId, starts] of bySeries)
      counters.noteRollupRows(
        '5m',
        seriesId,
        starts.toSorted((a, b) => a - b),
      )
    await this.recordSpans(rows)
    for (const row of rows) this.deps.onBucketWritten(row.seriesId, row.bucketStart)
    counters.ingestAccepted += rows.length
    return toResult(rows.length, refusals)
  }

  /** Persist the widened span of every series a bucket batch touched, then remember it. */
  private async recordSpans(rows: readonly RollupRow[]): Promise<void> {
    const { registry, store } = this.deps
    const spans = new Map<number, { first: number; last: number }>()
    for (const row of rows) {
      const end = row.lastTs ?? row.bucketStart
      const span = spans.get(row.seriesId)
      spans.set(row.seriesId, {
        first: span === undefined ? row.bucketStart : Math.min(span.first, row.bucketStart),
        last: span === undefined ? end : Math.max(span.last, end),
      })
    }
    const touch: { id: number; lastTs: number }[] = []
    for (const [id, span] of spans) {
      const current = registry.byIdOf(id)
      if (current === undefined) continue
      if (span.first < current.firstTs) await store.widenSeriesStart(id, span.first)
      if (span.last > current.lastTs) touch.push({ id, lastTs: span.last })
      registry.noteSpan(id, span.first, span.last)
    }
    await store.touchSeries(touch)
  }
}
