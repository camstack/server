import { z } from 'zod'
import { STILLNESS_BAR_MAX, STILLNESS_BAR_MIN } from './pipeline/tracker/stillness-scale.js'

/**
 * Per-device STILLNESS SCALE — the one number that says how fast a subject on
 * THIS camera has to move before it is travelling.
 *
 * A threshold belongs to whoever GENERATES the event, per device, never baked
 * into a classifier default. The judgement this feeds is
 * `StateAnalyzer.speedSaysSettled`; the measurement behind the number is
 * `pipeline/tracker/stillness-scale.ts`, which also carries the live
 * measurement showing why one number cannot serve a 30 m driveway and a 2 m
 * doorway.
 *
 * Cascade and shape mirror `stationary-settings` / `media-settings`: a
 * per-device override on top of the default, resolved per FIELD, and a parse
 * that never throws on a bad blob.
 *
 * **Absent behaves exactly as today.** The device store is a flat numeric blob
 * with no room for "unset", so the stored form of absent is `0` — and `0` is
 * not a bar anyone could want (it would mean nothing on this camera is ever
 * still) and not a value the calibration can produce (`minBar`). The decision
 * layer never sees it: {@link resolveStillSpeedFracPerSec} maps it to
 * `undefined`, and `undefined` is what leaves `StateAnalyzer` on its original
 * absolute `velocityThreshold` path.
 */
const StillnessSettingsSchema = z.object({
  /**
   * The camera's "not travelling" bar: centroid speed as a fraction of the
   * SUBJECT's own box diagonal, per second. `0` = not calibrated (see above).
   *
   * Measured p50 on the live hub 2026-09-19, for scale: 0.0136 (device 107,
   * close view, mostly parked subjects) to 0.3081 (device 101, far view, only
   * transits).
   */
  stillnessSpeedFracPerSec: z.number().min(0).max(STILLNESS_BAR_MAX).default(0),
  /**
   * When the number above was last CHOSEN — by a calibration run or by the
   * operator. `0` = never. Purely a readout; nothing gates on it.
   */
  stillnessCalibratedAt: z.number().int().min(0).default(0),
  /**
   * What the last calibration run measured and decided, in one line
   * (`describeStillnessCalibration`) — including a REFUSAL and its named
   * reason, because "why is this camera still on the default" has to be
   * answerable without re-running anything.
   */
  stillnessCalibrationNote: z.string().max(400).default(''),
})

export type StillnessSettings = z.infer<typeof StillnessSettingsSchema>

export const STILLNESS_DEFAULTS: StillnessSettings = StillnessSettingsSchema.parse({})

/**
 * Resolve a per-device store blob into typed stillness settings. Unknown or
 * invalid fields fall back to the default for that field — including a bar
 * outside the calibration's own rails, which is refused rather than clamped:
 * a number the calibration could never have produced is not evidence about
 * this camera, and silently bending it into range would present it as if it
 * were.
 */
export function resolveStillnessSettings(raw: Record<string, unknown>): StillnessSettings {
  const pick = <K extends keyof StillnessSettings>(key: K): StillnessSettings[K] => {
    const field = StillnessSettingsSchema.shape[key]
    const parsed = field.safeParse(raw[key])
    return parsed.success ? (parsed.data as StillnessSettings[K]) : STILLNESS_DEFAULTS[key]
  }
  return {
    stillnessSpeedFracPerSec: pick('stillnessSpeedFracPerSec'),
    stillnessCalibratedAt: pick('stillnessCalibratedAt'),
    stillnessCalibrationNote: pick('stillnessCalibrationNote'),
  }
}

/**
 * The bar the decision layer gets: a positive, in-rails number, or
 * `undefined` for "this camera is not calibrated — judge it exactly as
 * before". The ONE place the stored-zero convention is interpreted.
 */
export function resolveStillSpeedFracPerSec(settings: StillnessSettings): number | undefined {
  const bar = settings.stillnessSpeedFracPerSec
  if (!(bar >= STILLNESS_BAR_MIN) || bar > STILLNESS_BAR_MAX) return undefined
  return bar
}
