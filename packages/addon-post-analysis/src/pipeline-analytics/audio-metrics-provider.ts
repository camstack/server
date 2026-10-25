/**
 * `audio-metrics-provider.ts` — implements `audioMetricsCapability`.
 *
 * Hosts a sliding-window aggregator that consumes the audio
 * inference results the analytics addon already subscribes to and
 * produces a runtime-state snapshot mirrored into
 * `device.state.audioMetrics`. Operators read it via the canonical
 * reactive surface (no custom subscription needed).
 *
 * Aggregation is per-device and stays in-memory — same scope as the
 * 60-min ring on zone-analytics. Persisted history would be a
 * follow-up if needed (e.g. dBFS peaks beyond the rolling window).
 */
import type {
  IAudioMetricsProvider,
  AudioMetricsSnapshot,
  AudioMetricsHistory,
  AudioMetricsHistoryPoint,
  AudioClassSummary,
  IScopedLogger,
  DeviceProxy,
} from '@camstack/types'
import { SliceThrottler, snapshotEqualsIgnoringTs } from './runtime/slice-throttler.js'

const AUDIO_METRICS_CAP_NAME = 'audio-metrics'

/**
 * Per-device retention cap on the in-memory history ring. At ~1 sample
 * per second this covers ~1 hour with ~30 bytes/sample. Total memory
 * footprint stays under ~110 KB per device — fine for the hot ring,
 * matches what zone-analytics retains in its own ring buffer.
 */
const MAX_HISTORY_POINTS_KEPT = 3600

/** Hard cap on samples returned by `getHistory` per call. The provider
 *  bucket-averages when more would otherwise be returned. Keeps the
 *  payload bounded for slow links + browser charts. */
const MAX_HISTORY_POINTS_RETURNED = 1024

/** Default window when the caller doesn't override `windowSec`. */
const DEFAULT_HISTORY_WINDOW_SEC = 300

/** Default sample spacing when the caller doesn't override
 *  `sampleEveryMs`. Matches the slice-write tick rate so a freshly-
 *  populated ring lines up with what the operator sees on the live
 *  panel. */
const DEFAULT_HISTORY_SAMPLE_EVERY_MS = 1_000

/**
 * Slice-write rate cap. Audio chunks land at 10-20 Hz; pushing the
 * runtime-state slice on every chunk would saturate the
 * `DeviceStateChanged` channel and the kernel mirror without
 * actually telling the operator anything new — dB readings flicker
 * by ±1 dB at idle. 1 Hz with a trailing flush is the sweet spot:
 * UI feels live, bus stays quiet.
 */
const SLICE_WRITE_INTERVAL_MS = 1_000

/** Cache TTL for per-camera report settings. The audio fast path
 *  resolves on the first frame after expiry; settings changes apply
 *  within this window. */
const REPORT_SETTINGS_TTL_MS = 30_000

const DEFAULT_REPORT_SETTINGS: AudioMetricsReportSettings = {
  enabled: true,
  thresholdDb: 2,
}

/**
 * Audio-metrics-aware equality. Returns true (skip emit) when:
 *   - `current.className` is unchanged (class transitions always emit)
 *   - `byClass` shape is unchanged (top class set / hit counts identical)
 *   - level / peak / avg dBFS deltas are all under `thresholdDb`
 *
 * Coarsens the default `snapshotEqualsIgnoringTs` (which serialised
 * the whole snapshot to JSON and never matched because dBFS varies
 * by ±1dB every second). With `thresholdDb=2` an idle camera emits
 * only on real audio events; with `thresholdDb=0` we fall back to
 * exact equality (legacy behavior).
 */
function audioMetricsSnapshotEquals(
  prev: AudioMetricsSnapshot | undefined,
  next: AudioMetricsSnapshot,
  thresholdDb: number,
): boolean {
  if (!prev) return false
  if (thresholdDb <= 0) return snapshotEqualsIgnoringTs(prev, next)
  const prevClass = prev.current?.className ?? null
  const nextClass = next.current?.className ?? null
  if (prevClass !== nextClass) return false
  // Different number of classes / different top hits → not equal.
  if (prev.byClass.length !== next.byClass.length) return false
  for (let i = 0; i < prev.byClass.length; i++) {
    const a = prev.byClass[i]!
    const b = next.byClass[i]!
    if (a.className !== b.className || a.hits !== b.hits) return false
  }
  if (Math.abs(prev.level.dbfs - next.level.dbfs) >= thresholdDb) return false
  if (Math.abs(prev.peakDbfs - next.peakDbfs) >= thresholdDb) return false
  if (Math.abs(prev.avgDbfs - next.avgDbfs) >= thresholdDb) return false
  return true
}

/**
 * Per-camera report tunables — sourced from the analytics addon's
 * device-settings cascade (audioMetricsReportEnabled +
 * audioMetricsReportThresholdDb fields). Operators tune per-camera
 * to suppress per-second dBFS jitter on idle scenes without losing
 * class-change events. Returning `null` (or a fetch error) falls
 * back to the defaults.
 */
export interface AudioMetricsReportSettings {
  readonly enabled: boolean
  readonly thresholdDb: number
}

export interface AudioMetricsProviderContext {
  readonly logger: IScopedLogger
  /**
   * Per-device facade — same shape as `AddonContext.fetchDevice`.
   * Used to push the `device-state.setCapSlice` write through the
   * codegen DeviceProxy.
   */
  readonly fetchDevice: (deviceId: number) => Promise<DeviceProxy>
  /** Sliding-window length in seconds. Default 60s. */
  readonly windowSec?: number
  /** Score threshold below which a classification doesn't count
   *  toward `current` or `byClass`. Default 0.4. */
  readonly scoreThreshold?: number
  /**
   * Resolves the per-camera report settings (enabled + dB threshold).
   * Called lazily and cached for `REPORT_SETTINGS_TTL_MS` so the
   * audio fast path stays sync. Falls back to `{enabled: true,
   * thresholdDb: 2}` on missing/invalid settings.
   */
  readonly resolveReportSettings?: (deviceId: number) => Promise<AudioMetricsReportSettings>
  /**
   * Long-term-statistics tap for the per-camera NOISE BASELINE.
   *
   * `avgDbfs` is the field the runtime-state census singled out from both
   * ends: it is the single most expensive thing to persist as a SNAPSHOT (it
   * genuinely moves every second and a two-hour-old reading rendered as
   * "current" is worthless), and the single most valuable thing to keep as an
   * AGGREGATE — a per-camera baseline is what makes "unusual sound" a
   * threshold rather than a guess. Same value, opposite verdicts, which is the
   * LTS argument in one field.
   *
   * Fed from the snapshot the provider was computing anyway; synchronous and
   * infallible.
   */
  readonly onDbfsSample?: (deviceId: number, avgDbfs: number, at: number) => void
}

interface RecordedHit {
  readonly ts: number
  readonly className: string
  readonly score: number
}

interface RecordedLevel {
  readonly ts: number
  readonly dbfs: number
}

interface DeviceAudioState {
  readonly hits: RecordedHit[] // mutable rolling buffer
  readonly levels: RecordedLevel[]
  /** Latest level reading regardless of silence — used for
   *  `level.rms` / `level.dbfs` on the snapshot. */
  lastLevel: { rms: number; dbfs: number; ts: number } | null
}

export class AudioMetricsProvider implements IAudioMetricsProvider {
  private readonly snapshots = new Map<number, AudioMetricsSnapshot>()
  private readonly state = new Map<number, DeviceAudioState>()
  /**
   * Per-device history ring buffer. Each push appends a compact
   * `AudioMetricsHistoryPoint` derived from the just-computed
   * snapshot; the oldest entry is dropped once
   * `MAX_HISTORY_POINTS_KEPT` is reached. We use a plain array
   * (not a circular buffer) for readability — the trim cost is
   * O(1) on `.shift()` for arrays Node/V8 keeps short, and
   * `getHistory` doesn't have a hot-loop requirement.
   *
   * The ring is populated at the same cadence as the
   * `recordAudioFrame()` calls (1 push per call), but most builds
   * receive ~10–20 audio chunks per second. That rate is faster
   * than what `getHistory` reports (default 1Hz spacing); the
   * downstream subsampling step in `getHistory` averages adjacent
   * samples back to the requested spacing, so retention covers
   * roughly `MAX_HISTORY_POINTS_KEPT × pushIntervalMs / 1000`s of
   * wall-clock time. At 10Hz that's ~6 minutes; at 1Hz ~1 hour.
   */
  private readonly history = new Map<number, AudioMetricsHistoryPoint[]>()
  private readonly windowMs: number
  private readonly scoreThreshold: number
  /**
   * Coalesces slice writes to the kernel-side runtime-state mirror.
   * Equality check is audio-metrics-aware: dB jitter under the
   * per-device threshold is suppressed; class changes always pass.
   * Trailing-flushes at most once per SLICE_WRITE_INTERVAL_MS.
   */
  private readonly sliceThrottle: SliceThrottler<AudioMetricsSnapshot>
  /** Per-device settings cache. Refreshed lazily inside the audio
   *  fast path (REPORT_SETTINGS_TTL_MS). */
  private readonly reportSettings = new Map<
    number,
    { value: AudioMetricsReportSettings; resolvedAt: number }
  >()
  /** In-flight settings-fetch dedupe per device. */
  private readonly settingsFetches = new Map<number, Promise<void>>()
  /** Working snapshot of the equality threshold while the throttler
   *  is running its diff. Set before push(), reset to default after.
   *  Allows the closure passed to SliceThrottler to look up the
   *  per-device threshold without a deeper API change. */
  private currentThresholdDb: number = DEFAULT_REPORT_SETTINGS.thresholdDb

  constructor(private readonly ctx: AudioMetricsProviderContext) {
    this.windowMs = (ctx.windowSec ?? 60) * 1000
    this.scoreThreshold = ctx.scoreThreshold ?? 0.4
    this.sliceThrottle = new SliceThrottler<AudioMetricsSnapshot>({
      intervalMs: SLICE_WRITE_INTERVAL_MS,
      equalsIgnoringTs: (prev, next) =>
        audioMetricsSnapshotEquals(prev, next, this.currentThresholdDb),
      write: async (deviceId, snapshot) => {
        try {
          const dev = await this.ctx.fetchDevice(deviceId)
          await dev.deviceState.setCapSlice({
            capName: AUDIO_METRICS_CAP_NAME,
            slice: snapshot as Record<string, unknown>,
          })
        } catch (err: unknown) {
          this.ctx.logger.debug('audio-metrics slice mirror failed', {
            tags: { deviceId },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      },
    })
  }

  /**
   * Resolve per-device report settings with TTL caching. Returns
   * the cached value synchronously when fresh; on stale or first
   * access, kicks off an async refresh and returns the previous
   * value (falling back to defaults). Keeps the audio fast path
   * non-blocking — the worst case is one slightly-stale tick per
   * camera per TTL window.
   */
  private getReportSettings(deviceId: number): AudioMetricsReportSettings {
    const cached = this.reportSettings.get(deviceId)
    const now = Date.now()
    if (cached && now - cached.resolvedAt < REPORT_SETTINGS_TTL_MS) {
      return cached.value
    }
    if (this.ctx.resolveReportSettings && !this.settingsFetches.has(deviceId)) {
      const fetch = this.ctx
        .resolveReportSettings(deviceId)
        .then((value) => {
          this.reportSettings.set(deviceId, { value, resolvedAt: Date.now() })
        })
        .catch((err: unknown) => {
          this.ctx.logger.debug('audio-metrics: report settings resolve failed', {
            tags: { deviceId },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
          // Cache defaults so we don't hammer the resolver on persistent failure.
          this.reportSettings.set(deviceId, {
            value: DEFAULT_REPORT_SETTINGS,
            resolvedAt: Date.now(),
          })
        })
        .finally(() => {
          this.settingsFetches.delete(deviceId)
        })
      this.settingsFetches.set(deviceId, fetch)
    }
    return cached?.value ?? DEFAULT_REPORT_SETTINGS
  }

  /** Stop pending throttle timers — called from addon shutdown. */
  destroy(): void {
    this.sliceThrottle.destroy()
  }

  // ── Cap surface ───────────────────────────────────────────────────

  async getCurrentSnapshot({
    deviceId,
  }: {
    deviceId: number
  }): Promise<AudioMetricsSnapshot | null> {
    return this.snapshots.get(deviceId) ?? null
  }

  async getHistory({
    deviceId,
    windowSec,
    sampleEveryMs,
  }: {
    deviceId: number
    windowSec?: number
    sampleEveryMs?: number
  }): Promise<AudioMetricsHistory> {
    const ring = this.history.get(deviceId)
    if (!ring || ring.length === 0) {
      return {
        points: [],
        effectiveSampleEveryMs: sampleEveryMs ?? DEFAULT_HISTORY_SAMPLE_EVERY_MS,
        windowMsActual: 0,
      }
    }
    const effectiveWindowSec = windowSec ?? DEFAULT_HISTORY_WINDOW_SEC
    const requestedSampleEveryMs = sampleEveryMs ?? DEFAULT_HISTORY_SAMPLE_EVERY_MS
    const cutoffTs = Date.now() - effectiveWindowSec * 1000
    // Slice the trailing window. Ring is monotonic-ish (push order =
    // wall-clock order); a short linear scan is cheap up to
    // MAX_HISTORY_POINTS_KEPT.
    const inWindow: AudioMetricsHistoryPoint[] = []
    for (const p of ring) {
      if (p.ts >= cutoffTs) inWindow.push(p)
    }
    if (inWindow.length === 0) {
      return { points: [], effectiveSampleEveryMs: requestedSampleEveryMs, windowMsActual: 0 }
    }

    // Subsample to satisfy `sampleEveryMs` AND the per-call cap.
    // - Compute target bucket count from windowSec + sampleEveryMs.
    // - Cap at MAX_HISTORY_POINTS_RETURNED.
    // - When the source has more points per target bucket, average
    //   each bucket; otherwise emit the source verbatim.
    const naiveBucketCount = Math.max(
      1,
      Math.ceil((effectiveWindowSec * 1000) / requestedSampleEveryMs),
    )
    const targetBucketCount = Math.min(naiveBucketCount, MAX_HISTORY_POINTS_RETURNED)
    const downsampled = downsampleHistory(inWindow, targetBucketCount)
    const first = downsampled[0]
    const last = downsampled[downsampled.length - 1]
    const windowMsActual = first && last ? last.ts - first.ts : 0
    const effectiveSampleEveryMs =
      downsampled.length >= 2
        ? Math.max(1, Math.round(windowMsActual / Math.max(1, downsampled.length - 1)))
        : requestedSampleEveryMs
    return {
      points: downsampled,
      effectiveSampleEveryMs,
      windowMsActual,
    }
  }

  // ── Recording (called by the analytics addon's audio handler) ────

  /**
   * Record one audio window into the rolling aggregator and emit a
   * fresh snapshot. Called once per `pipeline.audio-inference-result`
   * event by the analytics addon. `topClassification` may be omitted
   * for silent windows — the level still updates.
   */
  async recordAudioFrame(input: {
    readonly deviceId: number
    readonly timestamp: number
    readonly level?: { readonly rms: number; readonly dbfs: number }
    readonly topClassification?: { readonly className: string; readonly score: number }
  }): Promise<void> {
    let s = this.state.get(input.deviceId)
    if (!s) {
      s = { hits: [], levels: [], lastLevel: null }
      this.state.set(input.deviceId, s)
    }
    const cutoff = input.timestamp - this.windowMs
    // Trim trailing-stale samples (front-of-buffer-first since
    // timestamps are monotonic in practice).
    while (s.hits.length > 0 && s.hits[0]!.ts < cutoff) s.hits.shift()
    while (s.levels.length > 0 && s.levels[0]!.ts < cutoff) s.levels.shift()

    if (input.level) {
      s.lastLevel = { ...input.level, ts: input.timestamp }
      s.levels.push({ ts: input.timestamp, dbfs: input.level.dbfs })
    }
    if (input.topClassification && input.topClassification.score >= this.scoreThreshold) {
      s.hits.push({
        ts: input.timestamp,
        className: input.topClassification.className,
        score: input.topClassification.score,
      })
    }

    const snapshot = computeAudioSnapshot(
      input.timestamp,
      s,
      this.windowMs / 1000,
      this.scoreThreshold,
    )
    // In-memory snapshot is always fresh — the cap's `getCurrentSnapshot`
    // returns the latest regardless of throttle/disable. Live UI panels
    // that subscribe directly to the cap stay live.
    this.snapshots.set(input.deviceId, snapshot)
    // LTS sample — the same snapshot, summarised into a 5-minute row.
    this.ctx.onDbfsSample?.(input.deviceId, snapshot.avgDbfs, snapshot.ts)

    // History ring — grow lazily, trim oldest. The ring is always
    // populated regardless of `enabled` / threshold settings: the
    // cap's `getHistory` is for live charts, separate from the
    // throttled slice-mirror channel. Operators who turn the live
    // mirror off still get charts on the device-detail panel.
    const point = snapshotToHistoryPoint(snapshot)
    let ring = this.history.get(input.deviceId)
    if (!ring) {
      ring = []
      this.history.set(input.deviceId, ring)
    }
    ring.push(point)
    if (ring.length > MAX_HISTORY_POINTS_KEPT) {
      ring.shift()
    }

    // Slice-mirror is the only path that fires `device.state-changed`
    // events. Operators can disable it per-camera when audio is
    // informational only (still classified — just not surfaced via the
    // reactive state slice / events tab).
    const settings = this.getReportSettings(input.deviceId)
    if (!settings.enabled) return

    // Stage the threshold for this push; the SliceThrottler closure
    // reads it during its equality check. Reset afterward so a
    // per-camera read doesn't leak the previous device's threshold
    // into another concurrent push (recordAudioFrame is async-but-
    // non-yielding from here through push, so the assignment is safe).
    this.currentThresholdDb = settings.thresholdDb
    this.sliceThrottle.push(input.deviceId, snapshot)
    this.currentThresholdDb = DEFAULT_REPORT_SETTINGS.thresholdDb
  }

  /** Drop a device's audio state. Called on device removal. */
  forgetDevice(deviceId: number): void {
    this.snapshots.delete(deviceId)
    this.state.delete(deviceId)
    this.history.delete(deviceId)
    this.sliceThrottle.forgetDevice(deviceId)
    this.reportSettings.delete(deviceId)
  }
}

/** Project a snapshot down to the compact history-point shape. */
function snapshotToHistoryPoint(snapshot: AudioMetricsSnapshot): AudioMetricsHistoryPoint {
  return {
    ts: snapshot.ts,
    dbfs: Number.isFinite(snapshot.level.dbfs) ? snapshot.level.dbfs : null,
    peakDbfs: snapshot.peakDbfs,
    avgDbfs: snapshot.avgDbfs,
    topClass: snapshot.current?.className ?? null,
    topScore: snapshot.current?.score ?? null,
  }
}

/**
 * Equal-width bucketed downsampling. Splits the source array into
 * `targetCount` equal-time buckets (by index since samples are
 * monotonic in practice) and averages numeric fields. The `topClass`
 * within each bucket is the most common label, breaking ties by
 * highest score; `topScore` is the per-bucket peak score.
 *
 * When `targetCount >= source.length` the source is returned
 * verbatim (no degenerate single-element buckets).
 */
function downsampleHistory(
  source: readonly AudioMetricsHistoryPoint[],
  targetCount: number,
): AudioMetricsHistoryPoint[] {
  if (source.length === 0) return []
  if (targetCount >= source.length) return [...source]
  const out: AudioMetricsHistoryPoint[] = []
  // Bucket size in source-array indices. `Math.max(1, …)` guards
  // against the targetCount==source.length edge case (already handled
  // above, but keeps the ceil safe).
  const bucketSize = Math.max(1, Math.floor(source.length / targetCount))
  for (let bucketStart = 0; bucketStart < source.length; bucketStart += bucketSize) {
    const bucketEnd = Math.min(source.length, bucketStart + bucketSize)
    let dbfsSum = 0
    let dbfsCount = 0
    let peakDbfs = -Infinity
    let avgDbfsSum = 0
    let peakBucketScore = -Infinity
    let peakBucketClass: string | null = null
    const classCounts = new Map<string, number>()
    let lastTs = source[bucketStart]!.ts
    for (let i = bucketStart; i < bucketEnd; i++) {
      const p = source[i]!
      if (p.dbfs !== null) {
        dbfsSum += p.dbfs
        dbfsCount += 1
      }
      if (p.peakDbfs > peakDbfs) peakDbfs = p.peakDbfs
      avgDbfsSum += p.avgDbfs
      if (p.topClass !== null) {
        classCounts.set(p.topClass, (classCounts.get(p.topClass) ?? 0) + 1)
        if (p.topScore !== null && p.topScore > peakBucketScore) {
          peakBucketScore = p.topScore
          peakBucketClass = p.topClass
        }
      }
      lastTs = p.ts
    }
    // Pick the most-frequent class in the bucket. Ties resolved by the
    // peak-score winner already tracked above.
    let dominantClass: string | null = null
    let dominantCount = 0
    for (const [cls, count] of classCounts) {
      if (count > dominantCount) {
        dominantClass = cls
        dominantCount = count
      }
    }
    const topClass = dominantClass ?? peakBucketClass
    const topScore = topClass !== null && peakBucketScore !== -Infinity ? peakBucketScore : null
    out.push({
      ts: lastTs,
      dbfs: dbfsCount > 0 ? dbfsSum / dbfsCount : null,
      peakDbfs: Number.isFinite(peakDbfs) ? peakDbfs : 0,
      avgDbfs: avgDbfsSum / Math.max(1, bucketEnd - bucketStart),
      topClass,
      topScore,
    })
  }
  return out
}

// ── Pure aggregation (exported for tests) ──────────────────────────

function computeAudioSnapshot(
  ts: number,
  s: DeviceAudioState,
  windowSec: number,
  scoreThreshold: number,
): AudioMetricsSnapshot {
  const byClassMap = new Map<string, { hits: number; sum: number; peak: number }>()
  for (const h of s.hits) {
    const acc = byClassMap.get(h.className) ?? { hits: 0, sum: 0, peak: 0 }
    acc.hits += 1
    acc.sum += h.score
    if (h.score > acc.peak) acc.peak = h.score
    byClassMap.set(h.className, acc)
  }
  const byClass: AudioClassSummary[] = [...byClassMap.entries()]
    .map(([className, agg]) => ({
      className,
      hits: agg.hits,
      avgScore: agg.hits > 0 ? agg.sum / agg.hits : 0,
      peakScore: agg.peak,
    }))
    .toSorted((a, b) => b.hits - a.hits || b.peakScore - a.peakScore)

  let peakDbfs = -Infinity
  let sumDbfs = 0
  for (const l of s.levels) {
    if (l.dbfs > peakDbfs) peakDbfs = l.dbfs
    sumDbfs += l.dbfs
  }
  const avgDbfs = s.levels.length > 0 ? sumDbfs / s.levels.length : 0

  // Latest above-threshold hit becomes the `current` field. Since
  // we only push hits that pass the threshold, the last entry is
  // already the canonical "current".
  const lastHit = s.hits.length > 0 ? s.hits[s.hits.length - 1]! : null
  const current = lastHit
    ? { className: lastHit.className, score: lastHit.score, timestamp: lastHit.ts }
    : null

  // `scoreThreshold` is consumed at hit-recording time
  // (recordAudioFrame). The aggregator just consumes the already-
  // filtered hits, so no further filtering needed here. Kept on the
  // signature for future per-window thresholding.
  void scoreThreshold

  return {
    ts,
    windowSec,
    level: s.lastLevel
      ? { rms: s.lastLevel.rms, dbfs: s.lastLevel.dbfs }
      : { rms: 0, dbfs: -Infinity },
    peakDbfs: Number.isFinite(peakDbfs) ? peakDbfs : 0,
    avgDbfs,
    current,
    byClass,
  }
}
