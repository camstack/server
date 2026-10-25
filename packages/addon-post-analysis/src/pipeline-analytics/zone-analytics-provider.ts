/**
 * `zone-analytics-provider.ts` — implements `zoneAnalyticsCapability`
 * for the analytics addon.
 *
 * Hosts the live per-device occupancy snapshot + a 60-minute rolling
 * in-memory history ring. The analytics addon's frame handler calls
 * {@link ZoneAnalyticsProvider.recordFrame} once per inference result;
 * the provider derives the snapshot, mirrors it to the device-state
 * `zone-occupancy` slice, and appends a sample to the history ring.
 *
 * History methods bucket samples at the requested resolution
 * (`minute` / `5min` / `hour`) and return one count per bucket. The
 * count is the per-bucket average rounded to the nearest integer —
 * matches what an operator chart would show for "person count over
 * the last hour" without tripping on per-frame jitter.
 *
 * Out-of-window queries (i.e. `from < now - 60 min`) are clamped to
 * the available range and return whatever buckets are populated.
 * Step 4b will land a SQL-backed sample store for queries beyond the
 * in-memory window; this provider's interface stays unchanged.
 */

import type {
  CameraOccupancySnapshot,
  CameraOccupancySnapshotForDevice,
  DeviceProxy,
  HistoryPoint,
  HistoryResolution,
  IScopedLogger,
  IZoneAnalyticsProvider,
  StationaryObject,
  Zone,
} from '@camstack/types'
import type { OccupancyEvidence } from '../notification-center/occupancy-watcher.js'
import { computeStationaryEntryZones } from './pipeline/stationary/stationary-zones.js'
import { TRACKING_DEFAULTS } from './tracking-settings.js'
import { occupancyScope } from '@camstack/types'
import { SliceThrottler, snapshotEqualsIgnoringTs } from './runtime/slice-throttler.js'

interface RecordedSample {
  readonly ts: number
  readonly snapshot: CameraOccupancySnapshot
}

/** Payload of an occupancy-change announcement — see `emitOccupancyChanged`. */
export interface OccupancyChangedPayload {
  readonly deviceId: number
  readonly timestamp: number
  readonly totalObjects: number
  readonly byClass: Readonly<Record<string, number>>
  readonly zones: number
}

export interface ZoneAnalyticsProviderContext {
  readonly logger: IScopedLogger
  /**
   * Announce an occupancy CHANGE on the bus. Optional so an existing caller
   * (and every test fake) keeps working: absent = no announcement, and the
   * consumer's reconcile covers it. Wired from the addon's `ctx.eventBus`.
   */
  readonly emitOccupancyChanged?: (payload: OccupancyChangedPayload) => void
  /**
   * Long-term-statistics tap for OCCUPANCY, per zone and frame-wide.
   *
   * Fed from the same per-frame snapshot the provider already computed — no
   * new subscription, and no dependency on a notification rule existing: the
   * occupancy WATCHER only runs for zones a rule watches, and a baseline that
   * only exists where someone already wrote a rule is a baseline nobody can
   * use to decide whether to write one.
   */
  readonly onOccupancySample?: (
    deviceId: number,
    count: number,
    at: number,
    zoneId?: string,
  ) => void
  /**
   * Per-device facade — same shape as `AddonContext.fetchDevice`.
   * Used to push the `device-state.setCapSlice` write through the
   * codegen DeviceProxy.
   */
  readonly fetchDevice: (deviceId: number) => Promise<DeviceProxy>
  /**
   * Resolve the parked-object registry views for a device. Drives snapshot
   * HYDRATION when no live frame is flowing (fresh respawn, camera detached
   * between motion sessions): a device with persisted parked objects must not
   * report a `null` occupancy snapshot. Optional — absent = hydration disabled
   * (the snapshot stays `null` until a real frame arrives).
   */
  readonly listStationaryObjects?: (deviceId: number) => readonly StationaryObject[]
  /**
   * Resolve the current 0–1 zone catalogue for a device (independent of any
   * live frame) so hydrated snapshots + baseline history samples attribute
   * parked objects to the right zone. Optional — absent = hydrated snapshots
   * carry no per-zone breakdown (everything lands in `unzoned`).
   */
  readonly resolveZones?: (deviceId: number) => Promise<readonly Zone[]>
  /**
   * `TrackingSettings.zoneMembershipMinOverlap` for this camera. Same bar the
   * FrameProcessor uses for live stamps. Optional — absent = schema default
   * ({@link TRACKING_DEFAULTS.zoneMembershipMinOverlap}), never a parked-only
   * number.
   */
  readonly resolveZoneMembershipMinOverlap?: (deviceId: number) => Promise<number>
  /** Device ids that currently hold at least one parked object — drives the
   *  low-cadence baseline history sampler. Optional (baseline disabled). */
  readonly listStationaryDeviceIds?: () => readonly number[]
  /**
   * In-process occupancy tap — invoked with every computed snapshot (live
   * frames AND the parked-object baseline sampler) so the Notification Center's
   * occupancy watcher sees the same ≤1 Hz count series. Telemetry-loss-tolerant
   * (a dropped call just misses a sample; the durable edge-state recovers).
   * Optional — absent = no occupancy notifications.
   */
  readonly onSnapshot?: (
    deviceId: number,
    snapshot: CameraOccupancySnapshot,
    evidence: OccupancyEvidence,
  ) => void
}

const HISTORY_WINDOW_MS = 60 * 60 * 1000 // 60 min
/** Cap name for the runtime-state mirror — matches the cap's declared
 *  `name` so the codegen DeviceProxy auto-wires
 *  `device.state.zoneAnalytics.value`. The slice IS the snapshot
 *  itself (no wrapping object) since the cap declares
 *  `runtimeState: CameraOccupancySnapshotSchema`. */
const ZONE_ANALYTICS_CAP_NAME = 'zone-analytics'

const RESOLUTION_MS: Record<HistoryResolution, number> = {
  minute: 60_000,
  '5min': 5 * 60_000,
  hour: 60 * 60_000,
}

/**
 * Maximum slice-write rate per camera. The frame handler can call
 * `recordFrame` at the inference fps (5-30 Hz); without throttling
 * every frame would emit a `DeviceStateChanged` event and a kernel
 * mirror update. UI consumers don't need sub-second granularity for
 * occupancy counts — coalesce at 1 Hz with trailing flush so the
 * latest state is never lost.
 */
const SLICE_WRITE_INTERVAL_MS = 1_000

/**
 * Cadence of the synthetic occupancy baseline. When a camera is detached (no
 * inference frames) but has persisted parked objects, the history ring would
 * otherwise stay empty and the chart would read "No occupancy history yet". A
 * device WITH parked entries gets one hydrated sample per this interval — a
 * flat baseline of the parked count — so the graph shows the parking lot's
 * standing occupancy instead of a gap. No sample is emitted for a device
 * without entries, and a real `recordFrame` in the same window suppresses the
 * baseline (it already appended a richer sample).
 */
const BASELINE_SAMPLE_INTERVAL_MS = 60_000

interface TrackedDetectionLike {
  readonly trackId: string
  readonly className: string
  readonly zones: readonly string[]
  /** Is this the census holding a STANDING object, rather than the tracker
   *  holding one that is passing through? Stated by the caller, never inferred
   *  from the trackId's shape — a discriminator that has to be parsed out of a
   *  string is one rename away from being wrong. Absent = transient. */
  readonly standing?: boolean
}

export class ZoneAnalyticsProvider implements IZoneAnalyticsProvider {
  private readonly snapshots = new Map<number, CameraOccupancySnapshot>()
  /** Per-device rolling ring of frame samples. Capped by HISTORY_WINDOW_MS
   *  on append; older entries are evicted lazily on each record. */
  private readonly history = new Map<number, RecordedSample[]>()
  /**
   * Coalesces slice writes to the kernel-side runtime-state mirror.
   * Skips no-op snapshots (idle camera, zone counts unchanged) and
   * caps the rate at 1 Hz with a trailing flush so a transient
   * change isn't held back beyond `SLICE_WRITE_INTERVAL_MS`.
   */
  private readonly sliceThrottle: SliceThrottler<CameraOccupancySnapshot>
  /** Last logged frame-wide occupancy total per device — so the occupancy log
   *  fires only when the count actually changes, not every inference frame. */
  private readonly lastOccupancyTotal = new Map<number, number>()
  /** When a snapshot was last appended for a device, by ANY producer. The
   *  baseline sampler's gate — see `appendBaselineSamples`. */
  private readonly lastSampleAtByDevice = new Map<number, number>()
  /** Low-cadence baseline sampler — appends a hydrated occupancy sample for any
   *  device with parked objects but no live frames. `null` when disabled. */
  private readonly baselineTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly ctx: ZoneAnalyticsProviderContext) {
    if (ctx.listStationaryDeviceIds && ctx.listStationaryObjects) {
      this.baselineTimer = setInterval(() => {
        void this.appendBaselineSamples()
      }, BASELINE_SAMPLE_INTERVAL_MS)
      this.baselineTimer.unref?.()
    }
    this.sliceThrottle = new SliceThrottler<CameraOccupancySnapshot>({
      intervalMs: SLICE_WRITE_INTERVAL_MS,
      equalsIgnoringTs: snapshotEqualsIgnoringTs,
      write: async (deviceId, snapshot) => {
        try {
          const dev = await this.ctx.fetchDevice(deviceId)
          await dev.deviceState.setCapSlice({
            capName: ZONE_ANALYTICS_CAP_NAME,
            slice: snapshot as Record<string, unknown>,
          })
        } catch (err: unknown) {
          this.ctx.logger.debug('zone-analytics slice mirror failed', {
            tags: { deviceId },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      },
    })
  }

  /** Stop pending throttle timers — called from addon shutdown. */
  destroy(): void {
    this.sliceThrottle.destroy()
    if (this.baselineTimer) clearInterval(this.baselineTimer)
  }

  // ── Cap surface ───────────────────────────────────────────────────

  async getCurrentSnapshot({
    deviceId,
  }: {
    deviceId: number
  }): Promise<CameraOccupancySnapshot | null> {
    // A live snapshot (set by `recordFrame`) always wins. Otherwise — fresh
    // respawn or a camera detached between motion sessions — synthesise one
    // from the persisted parked-object registry so a lot full of parked cars
    // reads its standing occupancy instead of `null`.
    return this.snapshots.get(deviceId) ?? (await this.hydrateFromRegistry(deviceId))
  }

  /**
   * The same snapshot, for a SET of cameras, in one round trip.
   *
   * The Events page's Stationary section polls this every 15 s for every
   * selected camera. Fanned out client-side that is one browser → hub →
   * post-analysis round trip per camera to read a `Map.get`; the answer costs
   * nothing and the transport costs everything. The per-device work here is
   * unchanged — the same live snapshot, the same parked-registry hydration when
   * there is no live one — and it runs concurrently inside the owner.
   *
   * **Three outcomes stay three.** A camera with a reading, a camera with none
   * yet (`snapshot: null`, `read: 'read'`), and a camera the owner could not
   * answer for (`read: 'unreadable'`). The hydration reaches a durable store
   * and can throw; letting that throw become `snapshot: null` would render an
   * unread camera as a camera with nothing parked, which is a definite claim
   * nobody made.
   */
  async getCurrentSnapshotBatch({
    deviceIds,
  }: {
    deviceIds: readonly number[]
  }): Promise<readonly CameraOccupancySnapshotForDevice[]> {
    return Promise.all(
      deviceIds.map(async (deviceId): Promise<CameraOccupancySnapshotForDevice> => {
        const live = this.snapshots.get(deviceId)
        if (live !== undefined) return { deviceId, read: 'read', snapshot: live }
        try {
          return { deviceId, read: 'read', snapshot: await this.hydrateFromRegistry(deviceId) }
        } catch (err: unknown) {
          // A dropped read that reads as "nothing parked" is the failure this
          // whole row shape exists to prevent. Say so, per camera.
          this.ctx.logger.warn('occupancy snapshot could not be read', {
            tags: { deviceId },
            meta: { error: String(err) },
          })
          return { deviceId, read: 'unreadable', snapshot: null }
        }
      }),
    )
  }

  /**
   * The cameras a LIVE snapshot exists for.
   *
   * The Notification Center's occupancy dry-run ("as of now, would this rule
   * fire?") answers an un-scoped rule against every camera that has a reading —
   * and only those: a device with no frame yet has no occupancy truth, and
   * probing it would manufacture a row saying nothing. Live map only; a parked-
   * object hydration is per-device and stays on the `getCurrentSnapshot` path.
   */
  deviceIdsWithSnapshot(): readonly number[] {
    return [...this.snapshots.keys()]
  }

  async getZoneHistory(input: {
    deviceId: number
    zoneId: string
    className?: string
    from: number
    to: number
    resolution: HistoryResolution
  }): Promise<readonly HistoryPoint[]> {
    return this.bucketize(input.deviceId, input.from, input.to, input.resolution, (snap) => {
      const zone = snap.zones.find((z) => z.zoneId === input.zoneId)
      if (!zone) return 0
      if (input.className === undefined) return zone.totalObjects
      return zone.byClass[input.className] ?? 0
    })
  }

  async getCameraHistory(input: {
    deviceId: number
    className?: string
    from: number
    to: number
    resolution: HistoryResolution
  }): Promise<readonly HistoryPoint[]> {
    return this.bucketize(input.deviceId, input.from, input.to, input.resolution, (snap) => {
      if (input.className === undefined) return snap.frame.totalObjects
      return snap.frame.byClass[input.className] ?? 0
    })
  }

  async getUnzonedHistory(input: {
    deviceId: number
    className?: string
    from: number
    to: number
    resolution: HistoryResolution
  }): Promise<readonly HistoryPoint[]> {
    return this.bucketize(input.deviceId, input.from, input.to, input.resolution, (snap) => {
      if (input.className === undefined) return snap.unzoned.totalObjects
      return snap.unzoned.byClass[input.className] ?? 0
    })
  }

  // ── Recording surface (called by the analytics frame handler) ─────

  /**
   * Compute and record a snapshot from a tracked-detection list.
   * Called once per inference result by the analytics addon's
   * `handleInferenceResult`. Mirrors to the `zone-occupancy`
   * device-state slice for live UI subscribers.
   */
  async recordFrame(input: {
    deviceId: number
    timestamp: number
    frameWidth: number
    frameHeight: number
    tracked: readonly TrackedDetectionLike[]
    zones: readonly Zone[]
    /** Parked objects currently on the camera — surfaced on the snapshot and
     *  (via `tracked` containing them) counted in frame occupancy by the
     *  caller. */
    stationaryObjects?: readonly StationaryObject[]
  }): Promise<void> {
    const snapshot = computeSnapshot(input)
    // Occupancy check log (deviceId-tagged) — only on change, so a steady scene
    // is quiet but every gain/loss of a tracked object is recorded.
    const total = snapshot.frame.totalObjects
    if (this.lastOccupancyTotal.get(input.deviceId) !== total) {
      this.lastOccupancyTotal.set(input.deviceId, total)
      this.ctx.logger.info('occupancy changed', {
        tags: { deviceId: input.deviceId },
        meta: {
          totalObjects: total,
          byClass: snapshot.frame.byClass,
          zones: snapshot.zones.length,
          // The PER-ZONE counts, not just the frame total. A zone-scoped
          // occupancy rule is evaluated against exactly these numbers, and
          // without them the log answers "the camera saw 2 vehicles" while the
          // question is always "how many were in THAT zone?". Diagnosing why a
          // parking rule never fired cost a full track-database replay because
          // this line reported only the frame aggregate.
          zoneCounts: snapshot.zones.map((z) => ({
            zoneId: z.zoneId,
            zoneName: z.zoneName,
            totalObjects: z.totalObjects,
            byClass: z.byClass,
          })),
        },
      })
      // Announce it, so a client does not have to ask. This was the one live
      // badge with no push signal: the viewer polled `getCurrentSnapshot` every
      // four seconds per visible camera purely to notice a change the addon had
      // already detected here. Change-only, so a steady scene stays silent.
      this.ctx.emitOccupancyChanged?.({
        deviceId: input.deviceId,
        timestamp: input.timestamp,
        totalObjects: total,
        byClass: snapshot.frame.byClass,
        zones: snapshot.zones.length,
      })
    }
    // In-memory snapshot + history get every frame — these feed the
    // cap's `getCurrentSnapshot` method and history queries, both of
    // which the operator explicitly polls when they want detail.
    this.snapshots.set(input.deviceId, snapshot)
    this.noteLtsSamples(input.deviceId, snapshot, input.timestamp)
    this.appendHistory(input.deviceId, snapshot)
    // Occupancy tap — feed the NC watcher the same series (in-process, best-effort).
    // A real frame went through the detector: this may say anything.
    this.emitSnapshot(input.deviceId, snapshot, 'scene')
    // Slice mirror, in contrast, drives the live UI state stream and
    // every cross-process consumer of `device.state.zoneAnalytics` —
    // throttled to 1 Hz and de-duplicated so a quiet camera produces
    // zero events instead of one per frame.
    this.sliceThrottle.push(input.deviceId, snapshot)
  }

  /** Drop a device's snapshot + history. Called on device removal. */
  forgetDevice(deviceId: number): void {
    this.snapshots.delete(deviceId)
    this.history.delete(deviceId)
    this.lastSampleAtByDevice.delete(deviceId)
    this.lastOccupancyTotal.delete(deviceId)
    this.sliceThrottle.forgetDevice(deviceId)
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * Build an occupancy snapshot for a device purely from its parked-object
   * registry (no live frame). Returns `null` when hydration is unavailable or
   * the device has no parked objects — a device with neither frames nor entries
   * legitimately reports `null`. The snapshot's `ts` is the most recent
   * `lastConfirmedAt` across entries, falling back to the current tick.
   */
  private async hydrateFromRegistry(deviceId: number): Promise<CameraOccupancySnapshot | null> {
    const listStationary = this.ctx.listStationaryObjects
    if (!listStationary) return null
    const entries = listStationary(deviceId)
    if (entries.length === 0) return null
    let zones: readonly Zone[] = []
    try {
      zones = (await this.ctx.resolveZones?.(deviceId)) ?? []
    } catch (err: unknown) {
      this.ctx.logger.debug('zone-analytics hydrate zone resolve failed', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    const minOverlap = await this.resolveMinOverlap(deviceId)
    const ts = mostRecentStationaryConfirmedAt(entries) || Date.now()
    return buildStationarySnapshot({ deviceId, entries, zones, timestamp: ts, minOverlap })
  }

  /** Tracking membership bar — schema default when the host did not wire it. */
  private async resolveMinOverlap(deviceId: number): Promise<number> {
    if (this.ctx.resolveZoneMembershipMinOverlap === undefined) {
      return TRACKING_DEFAULTS.zoneMembershipMinOverlap
    }
    return this.ctx.resolveZoneMembershipMinOverlap(deviceId)
  }

  /**
   * Baseline sampler tick: for every device with parked objects, append a
   * hydrated sample to the history ring at the CURRENT time — but only when a
   * real frame hasn't already appended a sample within this interval (frames
   * flowing = richer samples, no synthetic baseline needed).
   */
  private async appendBaselineSamples(): Promise<void> {
    const deviceIds = this.ctx.listStationaryDeviceIds?.() ?? []
    const now = Date.now()
    for (const deviceId of deviceIds) {
      // The gate asks ONE question — "did a real frame already sample this
      // interval?" — and it used to answer it by reading the tail of a
      // 60-minute ring of whole snapshots. A timestamp per device says the same
      // thing and outlives the ring, which is deprecated and on its way out.
      const lastTs = this.lastSampleAtByDevice.get(deviceId) ?? 0
      if (now - lastTs < BASELINE_SAMPLE_INTERVAL_MS) continue
      const entries = this.ctx.listStationaryObjects?.(deviceId) ?? []
      if (entries.length === 0) continue
      let zones: readonly Zone[] = []
      try {
        zones = (await this.ctx.resolveZones?.(deviceId)) ?? []
      } catch {
        /* baseline is best-effort; fall back to unzoned counts */
      }
      // Stamp at `now` so the point plots on the current bucket — a continuous
      // baseline rather than a spike anchored to an old confirmation time.
      const minOverlap = await this.resolveMinOverlap(deviceId)
      const snapshot = buildStationarySnapshot({
        deviceId,
        entries,
        zones,
        timestamp: now,
        minOverlap,
      })
      if (snapshot) {
        this.appendHistory(deviceId, snapshot)
        // Same series the frame path writes. A detached-but-occupied camera is
        // precisely the case the long-term series must not skip.
        this.noteLtsSamples(deviceId, snapshot, now)
        // Feed the NC watcher too, so a detached-but-occupied camera keeps its
        // occupancy confirmed (no spurious became-free between motion sessions).
        // Built from the CENSUS ALONE — no detector looked. It may confirm a
        // presence and nothing else: a census answering zero means "nothing
        // here is censused", which is `null`, not empty (D393).
        this.emitSnapshot(deviceId, snapshot, 'census')
        // Mirror the hydrated baseline to the device-state slice too: the
        // Live-stats UI reads the slice, and without live frames the last
        // push (possibly pre-fix, zones at 0) would sit there forever. The
        // throttler dedupes, so an unchanged parked scene writes nothing.
        this.sliceThrottle.push(deviceId, snapshot)
      }
    }
  }

  /**
   * Append this snapshot to the long-term occupancy series — frame-wide first
   * (`scope: ''`), then one sample per zone.
   *
   * Shared by BOTH producers on purpose. It used to live inline in
   * `recordFrame`, so the baseline sampler — the only producer a camera with no
   * frames flowing has — wrote the RAM ring, the NC watcher and the state slice
   * but never LTS. The long-term series therefore had a hole exactly where the
   * scene was nothing but parked objects: the one span an occupancy history is
   * asked about. The RAM ring showed a flat line over the same minutes, which
   * is what made the gap invisible.
   */
  private noteLtsSamples(
    deviceId: number,
    snapshot: CameraOccupancySnapshot,
    timestamp: number,
  ): void {
    const note = this.ctx.onOccupancySample
    if (note === undefined) return
    note(deviceId, snapshot.frame.totalObjects, timestamp, occupancyScope())
    for (const [className, count] of Object.entries(snapshot.frame.byClass)) {
      note(deviceId, count, timestamp, occupancyScope(undefined, className))
    }
    for (const zone of snapshot.zones) {
      note(deviceId, zone.totalObjects, timestamp, occupancyScope(zone.zoneId))
      for (const [className, count] of Object.entries(zone.byClass)) {
        note(deviceId, count, timestamp, occupancyScope(zone.zoneId, className))
      }
    }
  }

  /** Push one snapshot to the occupancy tap, isolating any consumer throw from
   *  the frame path (occupancy notifications must never break analytics). */
  private emitSnapshot(
    deviceId: number,
    snapshot: CameraOccupancySnapshot,
    evidence: OccupancyEvidence,
  ): void {
    if (!this.ctx.onSnapshot) return
    try {
      this.ctx.onSnapshot(deviceId, snapshot, evidence)
    } catch (err: unknown) {
      this.ctx.logger.debug('zone-analytics occupancy tap failed', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private appendHistory(deviceId: number, snapshot: CameraOccupancySnapshot): void {
    this.lastSampleAtByDevice.set(deviceId, snapshot.ts)
    const ring = this.history.get(deviceId) ?? []
    const cutoff = snapshot.ts - HISTORY_WINDOW_MS
    // Trim everything older than the window. Linear scan from the front
    // is fine — samples arrive monotonically so the trim front is small.
    let trimIdx = 0
    while (trimIdx < ring.length && ring[trimIdx]!.ts < cutoff) trimIdx++
    const trimmed = trimIdx > 0 ? ring.slice(trimIdx) : ring
    trimmed.push({ ts: snapshot.ts, snapshot })
    this.history.set(deviceId, trimmed)
  }

  private bucketize(
    deviceId: number,
    from: number,
    to: number,
    resolution: HistoryResolution,
    extract: (snap: CameraOccupancySnapshot) => number,
  ): readonly HistoryPoint[] {
    const ring = this.history.get(deviceId)
    if (!ring || ring.length === 0) return []
    const bucketMs = RESOLUTION_MS[resolution]
    const buckets = new Map<number, { sum: number; count: number }>()
    for (const sample of ring) {
      if (sample.ts < from || sample.ts > to) continue
      const bucketStart = Math.floor(sample.ts / bucketMs) * bucketMs
      const bucket = buckets.get(bucketStart)
      const value = extract(sample.snapshot)
      if (bucket) {
        bucket.sum += value
        bucket.count += 1
      } else {
        buckets.set(bucketStart, { sum: value, count: 1 })
      }
    }
    const result: HistoryPoint[] = []
    for (const [bucketStart, agg] of [...buckets.entries()].toSorted(([a], [b]) => a - b)) {
      result.push({
        ts: bucketStart + bucketMs / 2,
        count: Math.round(agg.sum / agg.count),
      })
    }
    return result
  }
}

// ── Pure snapshot computation (exported for tests) ──────────────────

export function computeSnapshot(input: {
  deviceId: number
  timestamp: number
  frameWidth: number
  frameHeight: number
  tracked: readonly TrackedDetectionLike[]
  zones: readonly Zone[]
  stationaryObjects?: readonly StationaryObject[]
}): CameraOccupancySnapshot {
  // Frame-wide aggregate.
  const frameByClass: Record<string, number> = {}
  let frameTotal = 0
  let frameStanding = 0
  for (const td of input.tracked) {
    frameTotal += 1
    if (td.standing === true) frameStanding += 1
    frameByClass[td.className] = (frameByClass[td.className] ?? 0) + 1
  }

  // Per-zone aggregate. count-in-each: a track inside multiple zones
  // contributes to every zone's counters.
  const zoneAccumulators = new Map<
    string,
    {
      name: string
      total: number
      standing: number
      byClass: Record<string, number>
      trackIds: string[]
    }
  >()
  for (const z of input.zones) {
    zoneAccumulators.set(z.id, {
      name: z.name,
      total: 0,
      standing: 0,
      byClass: {},
      trackIds: [],
    })
  }
  let unzonedTotal = 0
  let unzonedStanding = 0
  const unzonedByClass: Record<string, number> = {}
  for (const td of input.tracked) {
    if (td.zones.length === 0) {
      unzonedTotal += 1
      if (td.standing === true) unzonedStanding += 1
      unzonedByClass[td.className] = (unzonedByClass[td.className] ?? 0) + 1
      continue
    }
    for (const zoneId of td.zones) {
      const acc = zoneAccumulators.get(zoneId)
      if (!acc) continue
      acc.total += 1
      if (td.standing === true) acc.standing += 1
      acc.byClass[td.className] = (acc.byClass[td.className] ?? 0) + 1
      acc.trackIds.push(td.trackId)
    }
  }

  return {
    ts: input.timestamp,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    zones: [...zoneAccumulators.entries()].map(([zoneId, acc]) => ({
      zoneId,
      zoneName: acc.name,
      totalObjects: acc.total,
      byClass: acc.byClass,
      standingObjects: acc.standing,
      transientObjects: acc.total - acc.standing,
      trackIds: acc.trackIds,
    })),
    frame: {
      totalObjects: frameTotal,
      byClass: frameByClass,
      standingObjects: frameStanding,
      transientObjects: frameTotal - frameStanding,
    },
    unzoned: {
      totalObjects: unzonedTotal,
      byClass: unzonedByClass,
      standingObjects: unzonedStanding,
      transientObjects: unzonedTotal - unzonedStanding,
    },
    ...(input.stationaryObjects !== undefined && input.stationaryObjects.length > 0
      ? { stationaryObjects: input.stationaryObjects }
      : {}),
  }
}

/** Most recent `lastConfirmedAt` across parked entries (0 when none). */
export function mostRecentStationaryConfirmedAt(entries: readonly StationaryObject[]): number {
  let max = 0
  for (const e of entries) if (e.lastConfirmedAt > max) max = e.lastConfirmedAt
  return max
}

/**
 * Build an occupancy snapshot from parked-object registry entries alone —
 * used when no live inference frame is available (fresh respawn, camera
 * detached). Each entry is folded into the frame aggregate AND attributed via
 * {@link computeStationaryEntryZones} (same `ZoneEngine` + `minOverlap` as
 * live stamps), so a zone drawn over a parked car reports a count of 1.
 * Returns `null` for an empty entry list. Reuses {@link computeSnapshot} —
 * the SAME aggregation the live frame path runs.
 */
export function buildStationarySnapshot(input: {
  deviceId: number
  entries: readonly StationaryObject[]
  zones: readonly Zone[]
  timestamp: number
  /** `TrackingSettings.zoneMembershipMinOverlap` — required, never inferred. */
  minOverlap: number
}): CameraOccupancySnapshot | null {
  if (input.entries.length === 0) return null
  const tracked: TrackedDetectionLike[] = input.entries.map((e) => ({
    trackId: `stationary:${e.id}`,
    className: e.className,
    zones: computeStationaryEntryZones(e, input.zones, input.minOverlap),
    // A hydrated snapshot is the census and nothing else: no frame was read, so
    // there is nobody passing through to count.
    standing: true,
  }))
  // Parked entries share the camera's detection-frame dims; use the first for
  // the snapshot-level frame size (each entry also carries its own dims for the
  // overlay). Fall back to 0 when absent — the UI normalises per-entry anyway.
  const first = input.entries[0]!
  return computeSnapshot({
    deviceId: input.deviceId,
    timestamp: input.timestamp,
    frameWidth: first.frameWidth,
    frameHeight: first.frameHeight,
    tracked,
    zones: input.zones,
    stationaryObjects: input.entries,
  })
}
