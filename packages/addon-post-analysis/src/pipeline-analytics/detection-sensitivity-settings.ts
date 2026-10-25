import { z } from 'zod'

export const DetectionSensitivitySettingsSchema = z.object({
  // Softened 2026-06-17: the previous very-low defaults (1/2/2/5) flooded quiet
  // scenes with near-duplicate events because flimsy, short-lived tracks were
  // confirmed and re-emitted constantly. These calmer defaults require a track
  // to persist and be hit more before it produces events, and space out
  // re-emissions. Per-device overrides still available in the admin UI.
  minTrackAge: z.number().int().min(0).default(3),
  cooldownSec: z.number().positive().default(8),
  minHits: z.number().int().min(1).default(3),
  stationaryThresholdSec: z.number().positive().default(10),
})
export type DetectionSensitivitySettings = z.infer<typeof DetectionSensitivitySettingsSchema>

export const DETECTION_SENSITIVITY_DEFAULTS: DetectionSensitivitySettings =
  DetectionSensitivitySettingsSchema.parse({})

/**
 * Resolve a per-device store blob into typed sensitivity settings.
 * Unknown/invalid fields fall back to the default for that field
 * (never throws on a bad blob). Mirrors resolveAudioDetectionSettings.
 */
export function resolveDetectionSensitivitySettings(
  raw: Record<string, unknown>,
): DetectionSensitivitySettings {
  const pick = <K extends keyof DetectionSensitivitySettings>(
    key: K,
  ): DetectionSensitivitySettings[K] => {
    const field = DetectionSensitivitySettingsSchema.shape[key]
    const parsed = field.safeParse(raw[key])
    return parsed.success ? parsed.data : DETECTION_SENSITIVITY_DEFAULTS[key]
  }
  return {
    minTrackAge: pick('minTrackAge'),
    cooldownSec: pick('cooldownSec'),
    minHits: pick('minHits'),
    stationaryThresholdSec: pick('stationaryThresholdSec'),
  }
}
