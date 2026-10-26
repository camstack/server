/**
 * The assembled device-history engine, with no knowledge of the addon shell:
 * everything it needs from the hub arrives as a dependency (the door, the
 * device directory source, the snapshot read), so a spec can run the whole
 * thing over a real `history.db` in a temp dir with a controlled clock.
 *
 * Boot is two steps so the shell can subscribe to the bus in between and lose
 * nothing:
 *   {@link HistoryRuntime.prepare}    declare, load, seed — nothing is written;
 *   {@link HistoryRuntime.finishBoot} rebuild the recent rollup window, first reconcile.
 * Then {@link HistoryRuntime.startTimers} arms flush (10 s), rollups (60 s),
 * reconcile (5 min), retention (10 min) and the row counts (30 min).
 */
import type {
  DeviceHistoryOrphanDeleteEntry,
  DeviceHistoryOrphanList,
  DeviceHistoryStatus,
  IScopedLogger,
  ReadingQuantity,
} from '@camstack/types'
import {
  CaptureEngine,
  type HistoryCatalog,
  type HistoryItemCatalog,
  type SnapshotMap,
  catalogMetrics,
} from '../capture/capture-engine.js'
import { DeviceDirectory, type DeviceTypeSource } from '../capture/device-directory.js'
import { FLUSH_INTERVAL_MS, PointWriter } from '../capture/point-writer.js'
import { ProducerIngest } from '../ingest/producer-ingest.js'
import { HistoryQuery } from '../query/history-query.js'
import { DepartureTracker } from '../retention/departure-tracker.js'
import { OrphanSeries } from '../retention/orphans.js'
import { RetentionJob, type RetentionPolicy } from '../retention/retention.js'
import { RollupEngine } from '../rollup/rollup-engine.js'
import { HistoryCounters } from '../status/counters.js'
import type { HistoryDoor } from '../store/history-door.js'
import { HistoryStore, type StoredTier } from '../store/history-store.js'
import {
  DAY_TO_SECONDS,
  DESICCANT_LEGACY_MAX_DAYS,
  DESICCANT_SCALE_ID,
  DESICCANT_SERIES_KEY,
  type LegacyScale,
} from '../store/series-scale.js'
import { SeriesRegistry, subjectIdOf } from '../store/series-registry.js'
import { DAY_MS } from '../time/bucket-time.js'

export const ROLLUP_INTERVAL_MS: number = 60_000
export const RECONCILE_INTERVAL_MS: number = 5 * 60_000
export const RETENTION_INTERVAL_MS: number = 10 * 60_000
/**
 * ONE exact row count per boot (a `COUNT(*)` is a full scan on the history thread), taken late so
 * boot is not spent scanning the raw table. After it the figures move with the writes and deletes
 * the addon itself makes — an estimate, labelled so in the docs.
 */
export const FIRST_COUNT_DELAY_MS: number = 90_000

/** Per-row size estimates behind `approxBytes` (WITHOUT ROWID rows incl. page overhead). */
const APPROX_BYTES_PER_ROW: Readonly<Record<StoredTier, number>> = {
  raw: 24,
  '5m': 72,
  '1h': 72,
  '1d': 72,
}

export interface HistoryRuntimeDeps {
  readonly door: HistoryDoor
  readonly catalog: HistoryCatalog
  /** Keyed-array series (D917): the generated `HISTORY_ITEM_CATALOG`. */
  readonly itemCatalog: HistoryItemCatalog
  readonly deviceSource: DeviceTypeSource
  readonly readSnapshots: () => Promise<SnapshotMap>
  readonly readCapSlice: (
    deviceId: number,
    capName: string,
  ) => Promise<Readonly<Record<string, unknown>> | null>
  /** Polymorphic series (`numeric-sensor.value`): the quantity chosen at adopt. */
  readonly readDeviceQuantity?: (deviceId: number) => Promise<ReadingQuantity | null>
  /**
   * Series whose stored points are still in a retired unit (Unraid GiB).
   * A failed read scales nothing (D49).
   */
  readonly listLegacyScales?: () => Promise<readonly LegacyScale[]>
  readonly retention: () => RetentionPolicy
  readonly logger: IScopedLogger
  readonly clock: () => number
}

interface TierCount {
  readonly rows: number
  readonly countedAt: number
  /** The running write-minus-delete delta when the count was taken. */
  readonly deltaAtCount: number
}

export class HistoryRuntime {
  readonly counters: HistoryCounters = new HistoryCounters()
  readonly store: HistoryStore
  readonly registry: SeriesRegistry
  readonly directory: DeviceDirectory
  readonly rollup: RollupEngine
  readonly writer: PointWriter
  readonly capture: CaptureEngine
  readonly ingest: ProducerIngest
  readonly query: HistoryQuery
  readonly retentionJob: RetentionJob
  readonly departures: DepartureTracker
  readonly orphans: OrphanSeries

  private optedOutDevices: ReadonlySet<number> = new Set()
  private readonly tierCounts = new Map<StoredTier, TierCount>()
  private readonly startedAt: number
  private timers: ReturnType<typeof setInterval>[] = []
  private countTimeout: ReturnType<typeof setTimeout> | null = null
  private ready = false

  constructor(private readonly deps: HistoryRuntimeDeps) {
    const { logger, clock, catalog, itemCatalog } = deps
    this.startedAt = clock()
    this.store = new HistoryStore(deps.door)
    this.registry = new SeriesRegistry(this.store)
    this.directory = new DeviceDirectory(deps.deviceSource, this.counters, logger, clock)
    this.rollup = new RollupEngine({
      store: this.store,
      registry: this.registry,
      counters: this.counters,
      logger,
      clock,
    })
    this.writer = new PointWriter({
      registry: this.registry,
      store: this.store,
      counters: this.counters,
      logger,
      clock,
      onWritten: (written) => this.rollup.markPoints(written),
      onDropped: (dropped) => this.capture.forget(dropped),
    })
    const optedOut = (): ReadonlySet<number> => this.optedOutDevices
    this.capture = new CaptureEngine({
      catalog,
      itemCatalog,
      registry: this.registry,
      store: this.store,
      directory: this.directory,
      writer: this.writer,
      optedOut,
      counters: this.counters,
      logger,
      clock,
    })
    this.ingest = new ProducerIngest({
      registry: this.registry,
      store: this.store,
      directory: this.directory,
      writer: this.writer,
      counters: this.counters,
      logger,
      clock,
      optedOut,
      retention: () => {
        const policy = deps.retention()
        return { rawMs: policy.rawDays * DAY_MS, fiveMinuteMs: policy.fiveMinuteDays * DAY_MS }
      },
      onBucketWritten: (seriesId, bucketStart) =>
        this.rollup.markFiveMinuteRow(seriesId, bucketStart),
    })
    this.query = new HistoryQuery({
      registry: this.registry,
      store: this.store,
      clock,
      retention: deps.retention,
      catalog,
      itemCatalog,
      readCapSlice: deps.readCapSlice,
      readDeviceQuantity: deps.readDeviceQuantity,
    })
    this.departures = new DepartureTracker(this.store, this.registry, logger)
    this.registry.onRemove((series) => {
      this.capture.forgetSeries(series)
      this.ingest.forgetSeries(series)
      this.rollup.forgetSeries(series.id)
      this.retentionJob.forgetSeries(series.id)
    })
    this.retentionJob = new RetentionJob({
      store: this.store,
      registry: this.registry,
      departures: this.departures,
      counters: this.counters,
      logger,
    })
    this.orphans = new OrphanSeries({
      store: this.store,
      registry: this.registry,
      departures: this.departures,
      retention: this.retentionJob,
      declaredCapKeys: new Set(catalogMetrics(catalog, itemCatalog, 0).map((m) => m.key)),
      logger,
      clock,
    })
  }

  // ── boot ───────────────────────────────────────────────────────────

  async prepare(): Promise<void> {
    await this.store.declare()
    await this.registry.load()
    for (const metric of catalogMetrics(
      this.deps.catalog,
      this.deps.itemCatalog,
      this.deps.clock(),
    )) {
      await this.registry.declareMetric(metric)
    }
    this.optedOutDevices = await this.store.loadOptOuts()
    await this.departures.load()
    await this.directory.refresh()
    await this.capture.seed()
  }

  async finishBoot(): Promise<void> {
    await this.applyLegacyScales()
    const series = await this.rollup.bootRecompute(this.deps.clock())
    this.deps.logger.info('device-history: recent rollup window rebuilt', { meta: { series } })
    await this.reconcile()
  }

  /**
   * PetKit desiccant was stored in days; the quantity base is seconds.
   * Unraid array counters were stored in GiB; the base is bytes. Both
   * factors are honest because the unit never varied inside the series.
   * Weather and numeric-sensor are not rescaled: the unit at sample time
   * was not stored, so a factor would invent a number (D393).
   */
  private async applyLegacyScales(): Promise<void> {
    await this.scaleMatching(
      DESICCANT_SERIES_KEY,
      undefined,
      DAY_TO_SECONDS,
      DESICCANT_LEGACY_MAX_DAYS,
      DESICCANT_SCALE_ID,
    )
    const list = this.deps.listLegacyScales
    if (list === undefined) return
    let subjects: readonly LegacyScale[]
    try {
      subjects = await list()
    } catch (err) {
      this.deps.logger.warn(
        'device-history: legacy scale listing failed — stored points unchanged',
        {
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
      return
    }
    for (const subject of subjects) {
      await this.scaleMatching(
        subject.seriesKey,
        subject.deviceId,
        subject.factor,
        subject.legacyMax,
        subject.migrationId,
      )
    }
  }

  private async scaleMatching(
    key: string,
    deviceId: number | undefined,
    factor: number,
    legacyMax: number,
    migrationId: string,
  ): Promise<void> {
    if (await this.store.scaleApplied(migrationId)) return
    const subject = deviceId === undefined ? undefined : subjectIdOf({ kind: 'device', deviceId })
    const series = this.registry.all().filter((row) => {
      if (row.key !== key) return false
      return subject === undefined || row.subject === subject
    })
    let changed = 0
    for (const row of series) {
      changed += await this.store.scaleSeries(row.id, factor, legacyMax)
    }
    await this.store.markScale(migrationId, this.deps.clock())
    if (changed > 0) {
      this.deps.logger.info('device-history: rescaled a series into its base unit', {
        ...(deviceId === undefined ? {} : { tags: { deviceId } }),
        meta: { migrationId, key, changed },
      })
    }
  }

  startTimers(): void {
    const every = (ms: number, run: () => Promise<void>): void => {
      const timer = setInterval(() => {
        void run().catch((err: unknown) => {
          this.deps.logger.warn('device-history: scheduled pass threw', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
      }, ms)
      timer.unref()
      this.timers.push(timer)
    }
    every(FLUSH_INTERVAL_MS, () => this.flushNow())
    every(ROLLUP_INTERVAL_MS, async () => {
      await this.rollup.tick()
      this.reportWindow()
    })
    every(RECONCILE_INTERVAL_MS, async () => {
      await this.reconcile()
      this.reportWindow()
    })
    every(RETENTION_INTERVAL_MS, async () => {
      await this.retentionJob.run(this.deps.retention(), this.deps.clock())
      this.reportWindow()
    })
    this.countTimeout = setTimeout(() => {
      void this.refreshCounts().catch(() => undefined)
    }, FIRST_COUNT_DELAY_MS)
    this.countTimeout.unref()
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.countTimeout !== null) clearTimeout(this.countTimeout)
    this.countTimeout = null
    await this.writer.flush()
  }

  // ── passes ─────────────────────────────────────────────────────────

  /** Emit pending trailing points, then write the buffer. */
  async flushNow(): Promise<void> {
    this.capture.tickPending(this.deps.clock())
    await this.writer.flush()
  }

  /**
   * Restore changes a dropped event missed. A FAILED read changes nothing (D49):
   * it is counted and logged, and the next pass tries again.
   */
  async reconcile(): Promise<void> {
    const { logger, clock } = this.deps
    // Only a listing that answered may move the departure clocks; a failed one moves nothing (D49).
    if (await this.directory.refresh()) {
      await this.departures.observe(this.directory.listedIds(), clock())
    }
    let snapshots: SnapshotMap
    try {
      snapshots = await this.deps.readSnapshots()
    } catch (err) {
      this.counters.reconcileFailures += 1
      logger.warn('device-history: reconcile read failed — nothing changed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    const now = clock()
    this.capture.reconcile(snapshots, now)
    this.counters.reconcileRuns += 1
    this.counters.lastReconcileAt = now
    this.ready = true
  }

  async refreshCounts(): Promise<void> {
    for (const tier of ['raw', '5m', '1h', '1d'] as const) {
      const deltaAtCount = this.counters.rowDeltaOf(tier)
      const rows = await this.store.countRows(tier)
      this.tierCounts.set(tier, { rows, countedAt: this.deps.clock(), deltaAtCount })
    }
  }

  /**
   * ONE aggregated INFO naming what was skipped, refused, deleted or failed since the
   * previous report (D391) — the counts a per-event line would drown. Silent when
   * nothing happened.
   */
  reportWindow(): void {
    const summary = this.counters.summarySinceLast()
    if (summary === null) return
    this.deps.logger.info('device-history: since the last report', { meta: { ...summary } })
  }

  // ── opt-out ────────────────────────────────────────────────────────

  isEnabled(deviceId: number): boolean {
    return !this.optedOutDevices.has(deviceId)
  }

  async setEnabled(deviceId: number, enabled: boolean): Promise<boolean> {
    if (enabled) {
      await this.store.clearOptOut(deviceId)
      this.optedOutDevices = new Set([...this.optedOutDevices].filter((id) => id !== deviceId))
    } else {
      await this.store.setOptOut(deviceId, this.deps.clock())
      this.optedOutDevices = new Set([...this.optedOutDevices, deviceId])
    }
    return enabled
  }

  // ── device removal (D865) ──────────────────────────────────────────

  /** Delete the history of a deleted device: its series, opt-out and absence clock. */
  async removeDevice(deviceId: number): Promise<{ series: number }> {
    const series = await this.retentionJob.purgeDevice(deviceId, this.deps.clock())
    await this.store.clearOptOut(deviceId)
    await this.departures.forget(deviceId)
    this.optedOutDevices = new Set([...this.optedOutDevices].filter((id) => id !== deviceId))
    return { series }
  }

  // ── orphan series (D917) ───────────────────────────────────────────

  /** Device series no longer linked to a device — reported, never purged here. */
  listOrphans(): Promise<DeviceHistoryOrphanList> {
    return this.orphans.list()
  }

  /** Delete orphan series by id; a series that is not orphan NOW is refused. */
  deleteOrphans(seriesIds: readonly number[]): Promise<readonly DeviceHistoryOrphanDeleteEntry[]> {
    return this.orphans.delete(seriesIds)
  }

  /** Series held per device, for the admin clean-up listing. */
  seriesByDevice(): ReadonlyMap<number, number> {
    const out = new Map<number, number>()
    for (const s of this.registry.all()) {
      if (s.deviceId === null) continue
      out.set(s.deviceId, (out.get(s.deviceId) ?? 0) + 1)
    }
    return out
  }

  // ── status ─────────────────────────────────────────────────────────

  status(): DeviceHistoryStatus {
    const c = this.counters
    const dirty = this.rollup.dirtyCounts()
    return {
      startedAt: this.startedAt,
      ready: this.ready,
      series: this.registry.all().length,
      metrics: this.registry.allMetrics().length,
      optedOutDevices: this.optedOutDevices.size,
      tiers: (['raw', '5m', '1h', '1d'] as const).map((tier) => {
        const count = this.tierCounts.get(tier)
        const rows =
          count === undefined
            ? null
            : Math.max(0, count.rows + this.counters.rowDeltaOf(tier) - count.deltaAtCount)
        return {
          tier,
          rows,
          approxBytes: rows === null ? null : rows * APPROX_BYTES_PER_ROW[tier],
          countedAt: count?.countedAt ?? null,
        }
      }),
      capture: {
        eventsSeen: c.eventsSeen,
        pointsEmitted: c.pointsEmitted,
        pointsWritten: c.pointsWritten,
        pointsDropped: c.pointsDropped,
        bufferDepth: this.writer.depth(),
        trailingEmitted: c.trailingEmitted,
        reconciledPoints: c.reconciledPoints,
        reconcileRuns: c.reconcileRuns,
        reconcileFailures: c.reconcileFailures,
        lastReconcileAt: c.lastReconcileAt,
        lastFlushAt: c.lastFlushAt,
        flushFailures: c.flushFailures,
        skipped: c.skippedRecord(),
      },
      ingest: { accepted: c.ingestAccepted, refused: c.refusedRecord() },
      rollup: {
        last5mAt: c.last5mAt,
        last1hAt: c.last1hAt,
        last1dAt: c.last1dAt,
        errors: c.rollupErrors,
        dirty5m: dirty.m5,
        dirty1h: dirty.h1,
        dirty1d: dirty.d1,
      },
      retention: {
        lastRunAt: c.retentionLastRunAt,
        deleted: c.deletedRecord(),
        purgedSeries: c.purgedSeries,
      },
      directory: { devices: this.directory.size(), lastRefreshAt: this.directory.lastRefreshAt() },
    }
  }
}
