import { z } from 'zod'

/**
 * Per-device media-crop settings. Cascade: a per-device override on top of the
 * global default, resolved per field (an invalid/missing value falls back to
 * its default — parse never throws). Mirrors `face-settings` /
 * `audio-detection-settings`.
 */
export const MediaSettingsSchema = z.object({
  /** Fractional padding added around a detection bbox before cropping.
   *  0 = tight crop, 0.15 = expand each side by 15% of the box dimension,
   *  max 2 (200%). */
  cropPadding: z.number().min(0).max(2).default(0.15),
  /**
   * Per-camera DEBUG media. Default **false**, and it absorbs the retired
   * `saveThumbnails` rather than sitting beside it (D62: a second switch that
   * disagrees with the first is worse than no switch).
   *
   * What it gates, and only this:
   *  - the periodic per-track `snapshot` filmstrip (`periodic-media-plan.ts`);
   *  - the per-EDGE motion still — the debug surplus that
   *    {@link decideMotionStill} otherwise reduces to one marker per
   *    {@link MediaSettings.motionMarkerQuietMs} drought window.
   *
   * What it never gates, at any value: `firstFrame`, the rolling `lastFrame`,
   * `thumbnail`/`thumbnailSmall`, `keyFrame`/`keyFrameSmall`, the face/plate
   * buffers, gallery media, the CLIP search `crop` — and the quiet-period
   * motion marker itself, which is the operator's fallback and must survive
   * the default (a blank timeline on a quiet camera reads as broken).
   *
   * The rolling `lastFrame` deliberately moved OUT from under the old
   * `saveThumbnails`: it is in the keep-set, and a debug switch may not take
   * it away.
   */
  debugMediaEnabled: z.boolean().default(false),
  /**
   * The detection-drought window N for the motion marker: with debug media
   * off, a motion off→on edge produces a still only when NO detection has run
   * on this camera for this long AND no marker was produced in the last such
   * window. Chosen from the observed fleet distribution of detection-free
   * stretches (median 42 s, p75 201 s, p90 770 s) — 900 s sits just past p90,
   * so nine stretches in ten produce nothing. See
   * `services/motion-marker-policy.ts`.
   */
  motionMarkerQuietMs: z
    .number()
    .int()
    .min(60_000)
    .max(6 * 60 * 60_000)
    .default(900_000),
  /** Cadence (ms) for the periodic per-track `snapshot` + rolling `lastFrame`.
   *  A snapshot is captured for an active track only after this much wall-clock
   *  has elapsed since its previous one. */
  snapshotIntervalMs: z.number().int().min(500).max(60_000).default(5_000),
  /** Movement gate for the periodic `snapshot`: once `snapshotIntervalMs` has
   *  elapsed, a fresh snapshot is only captured when the track's centroid moved
   *  at least this fraction of the frame DIAGONAL since the last captured
   *  snapshot. Suppresses near-identical frames from a long-lived / stationary
   *  track. 0 disables the gate (pure-time behaviour). Default 0.03 ≈ 3% of the
   *  frame diagonal (~66px on 1080p). */
  snapshotMovementThreshold: z.number().min(0).max(1).default(0.03),
  /** Loiterer fallback (ms): force a periodic `snapshot` for a stationary but
   *  still-present track after this much wall-clock without one, so its
   *  filmstrip is never empty. Effectively clamped to ≥ `snapshotIntervalMs`. */
  snapshotMaxIdleMs: z.number().int().min(1_000).max(600_000).default(30_000),
})

export type MediaSettings = z.infer<typeof MediaSettingsSchema>

export const MEDIA_DEFAULTS: MediaSettings = MediaSettingsSchema.parse({})

/**
 * Resolve a per-device store blob into typed media settings. Unknown/invalid
 * fields fall back to the default for that field (never throws on a bad blob).
 */
export function resolveMediaSettings(raw: Record<string, unknown>): MediaSettings {
  const pick = <K extends keyof MediaSettings>(key: K): MediaSettings[K] => {
    const field = MediaSettingsSchema.shape[key]
    const parsed = field.safeParse(raw[key])
    return parsed.success ? (parsed.data as MediaSettings[K]) : MEDIA_DEFAULTS[key]
  }
  return {
    cropPadding: pick('cropPadding'),
    debugMediaEnabled: pick('debugMediaEnabled'),
    motionMarkerQuietMs: pick('motionMarkerQuietMs'),
    snapshotIntervalMs: pick('snapshotIntervalMs'),
    snapshotMovementThreshold: pick('snapshotMovementThreshold'),
    snapshotMaxIdleMs: pick('snapshotMaxIdleMs'),
  }
}
