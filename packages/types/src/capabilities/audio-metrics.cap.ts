import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Per-class audio metrics aggregated over a sliding window.
 */
const AudioClassSummarySchema = z.object({
  className: z.string(),
  /** Number of windows (chunks) where this class was the top hit. */
  hits: z.number().int().nonnegative(),
  /** Mean score across those hits, clamped to [0,1]. */
  avgScore: z.number().min(0).max(1),
  /** Peak score in the window. */
  peakScore: z.number().min(0).max(1),
})

/**
 * Per-camera audio metrics snapshot — emitted by the analytics frame
 * handler on every `pipeline.audio-inference-result` event and
 * mirrored into the `audio-metrics` device-state slice. Symmetric
 * with `zone-analytics` snapshots for video — every consumer
 * (admin UI panel, automations, alert rules) reads via the
 * canonical `device.state.audioMetrics.value` reactive handle.
 *
 * Aggregates are computed over a rolling `windowSec` window
 * (default 60s). Past that window, classes drop out of `byClass`
 * and the level history shifts forward.
 */
const AudioMetricsSnapshotSchema = z.object({
  /** Wall-clock timestamp (ms) of the most recent audio window. */
  ts: z.number().int(),
  /** Sliding-window length (seconds) used for aggregation. */
  windowSec: z.number().int().positive(),
  /** Latest level reading from the most recent window. */
  level: z.object({
    rms: z.number(),
    dbfs: z.number(),
  }),
  /** Peak dBFS observed across the rolling window. */
  peakDbfs: z.number(),
  /** Mean dBFS across the rolling window. */
  avgDbfs: z.number(),
  /** Most recent above-threshold classification, or null on silence. */
  current: z
    .object({
      className: z.string(),
      score: z.number().min(0).max(1),
      timestamp: z.number().int(),
    })
    .nullable(),
  /** Per-class summary across the rolling window — keys are
   *  `macroClass` strings (e.g. `dog_bark`, `speech`, `glass_break`). */
  byClass: z.array(AudioClassSummarySchema).readonly(),
})
export type AudioMetricsSnapshot = z.infer<typeof AudioMetricsSnapshotSchema>
export type AudioClassSummary = z.infer<typeof AudioClassSummarySchema>

/**
 * One sample on the audio-metrics history time-series. Captures the
 * subset of the live snapshot useful for charting: dB level, peak/avg
 * over the rolling window, and the dominant above-threshold class
 * (when any). Per-class hit breakdown lives on the snapshot but is
 * elided from the history sample to keep the buffer compact —
 * consumers needing class drill-down should pull `getCurrentSnapshot`.
 */
const AudioMetricsHistoryPointSchema = z.object({
  /** Wall-clock ms when this sample was recorded. */
  ts: z.number().int(),
  /** Instantaneous dBFS level at sample time. `null` for windows where
   *  the source had no level reading (rare; happens at decode startup). */
  dbfs: z.number().nullable(),
  /** Rolling-window peak dBFS at sample time. Same window the live
   *  snapshot reports. */
  peakDbfs: z.number(),
  /** Rolling-window mean dBFS at sample time. */
  avgDbfs: z.number(),
  /** Dominant above-threshold class at sample time, or null on silence. */
  topClass: z.string().nullable(),
  /** Score of the dominant class (`null` whenever `topClass` is null). */
  topScore: z.number().min(0).max(1).nullable(),
})
export type AudioMetricsHistoryPoint = z.infer<typeof AudioMetricsHistoryPointSchema>

/**
 * Audio-metrics history payload — a series of `AudioMetricsHistoryPoint`
 * samples capped at `maxPoints` (default 1024). When the requested
 * `windowSec / sampleEveryMs` would exceed the cap, the provider
 * subsamples by bucketed averaging and reports the effective sample
 * spacing on `effectiveSampleEveryMs` so the UI can label the x-axis.
 */
const AudioMetricsHistorySchema = z.object({
  points: z.array(AudioMetricsHistoryPointSchema).readonly(),
  /** Actual ms between adjacent samples after any subsampling. */
  effectiveSampleEveryMs: z.number().int().positive(),
  /** Wall-clock window covered by `points` (`points[N-1].ts - points[0].ts`),
   *  or `0` when there's fewer than 2 samples. */
  windowMsActual: z.number().int().nonnegative(),
})
export type AudioMetricsHistory = z.infer<typeof AudioMetricsHistorySchema>

/**
 * Audio Metrics capability — sliding-window aggregates over the
 * pipeline audio inference results. Hosted by `addon-pipeline-analytics`
 * (same addon that owns `zone-analytics`); the runtime-state slice
 * gives operators a live read on dB level + dominant classes without
 * a custom event subscription.
 */
export const audioMetricsCapability = {
  name: 'audio-metrics',
  scope: 'device',
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  methods: {
    /** Latest snapshot for this device. Null until the analytics
     *  pipeline has processed at least one audio window. */
    getCurrentSnapshot: method(
      z.object({ deviceId: z.number() }),
      AudioMetricsSnapshotSchema.nullable(),
    ),
    /**
     * Time-series view of recent audio-metrics samples. The provider
     * keeps an in-memory ring of ~1Hz samples (matching the slice-
     * write rate) capped at `MAX_HISTORY_POINTS_KEPT` (provider-side).
     * `windowSec` selects how far back to read; `sampleEveryMs`
     * downsamples by bucketed averaging when finer than the kept
     * granularity. Empty `points` array on freshly-booted providers
     * with no audio yet — same convention as `getCurrentSnapshot`.
     */
    getHistory: method(
      z.object({
        deviceId: z.number(),
        /** History window in seconds. Default 300 (5 minutes).
         *  Provider clamps to its retention cap if larger. */
        windowSec: z.number().int().positive().optional(),
        /** Target sample interval in ms. Default 1000 (1 sample/second).
         *  Provider clamps to natural sample rate if smaller, and
         *  bucket-averages when bigger than the requested window
         *  would produce more than `maxPoints` samples. */
        sampleEveryMs: z.number().int().positive().optional(),
      }),
      AudioMetricsHistorySchema,
    ),
  },
  /** Reactive runtime-state mirror — live `device.state.audioMetrics.value`. */
  runtimeState: AudioMetricsSnapshotSchema,

  /**
   * Runtime-state durability: **session** — 1 Hz per camera at the mirror and ~63 % of the fleet's whole runtime-state write rate. `avgDbfs` is a rolling 60 s mean that genuinely moves every second, so no equality fix reclaims it — and a two-hour-old dB reading rendered as current is worse than no reading.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — the level is the addon series `pipeline-analytics/audio-level` (producer `record`); the other numbers move every inference window and duplicate it.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IAudioMetricsProvider = InferProvider<typeof audioMetricsCapability>

export {
  AudioMetricsSnapshotSchema,
  AudioClassSummarySchema,
  AudioMetricsHistoryPointSchema,
  AudioMetricsHistorySchema,
}
