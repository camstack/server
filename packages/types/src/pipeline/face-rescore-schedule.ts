/**
 * The cadence of the automatic whole-archive face rescore (D866).
 *
 * One cluster-wide knob in `pipeline-orchestrator`'s GLOBAL settings, read by
 * `pipeline-analytics` over the hub-routed `addon-settings` cap on every tick.
 * It lives here for the same reason the detail-crop convention does: the
 * writer (orchestrator) and the reader (analytics) are different addons, they
 * never import each other, and a key copied by hand is how a setting silently
 * stops arriving.
 */

export const FACE_RESCORE_SECTION_ID = 'face-rescore'
export const FACE_RESCORE_INTERVAL_KEY = 'faceRescoreIntervalMinutes'

/** Slider bounds. `0` is "disabled"; anything in 1..9 is raised to `min`. */
export const FACE_RESCORE_INTERVAL_FIELD = {
  min: 0,
  max: 1440,
  step: 5,
  default: 60,
} as const

/** The smallest period that actually runs; below it (but above 0) is clamped up. */
export const FACE_RESCORE_INTERVAL_MIN_RUNNING = 10

/**
 * Narrow a stored value to minutes. `0` ⇒ disabled; a positive value under
 * {@link FACE_RESCORE_INTERVAL_MIN_RUNNING} is raised to it; junk or absent ⇒
 * the default (an unreadable setting must not switch the job off nor storm it).
 */
export function readFaceRescoreIntervalMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return FACE_RESCORE_INTERVAL_FIELD.default
  }
  if (value === 0) return 0
  return Math.min(
    FACE_RESCORE_INTERVAL_FIELD.max,
    Math.max(FACE_RESCORE_INTERVAL_MIN_RUNNING, Math.floor(value)),
  )
}

/** One hydrated section of an `addon-settings.getGlobalSettings` payload. */
export interface FaceRescoreSettingsView {
  readonly sections: readonly { readonly fields: readonly unknown[] }[]
}

/** The interval out of a hydrated payload; a `null` view (mid-boot) is the default. */
export function pickFaceRescoreIntervalMinutes(view: FaceRescoreSettingsView | null): number {
  if (view === null) return FACE_RESCORE_INTERVAL_FIELD.default
  for (const section of view.sections) {
    for (const entry of section.fields) {
      if (typeof entry !== 'object' || entry === null || !('key' in entry)) continue
      if (entry.key === FACE_RESCORE_INTERVAL_KEY) {
        return readFaceRescoreIntervalMinutes('value' in entry ? entry.value : undefined)
      }
    }
  }
  return FACE_RESCORE_INTERVAL_FIELD.default
}
