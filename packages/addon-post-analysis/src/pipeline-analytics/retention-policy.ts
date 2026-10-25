/**
 * Analytics retention policy — **ONE window per device** (D62).
 *
 * A device has one retention window, and everything scoped to that device is
 * deleted on it: the track (which cascades to its object events, their child
 * crops, its media, its unassigned face/plate rows and crops, and its CLIP
 * vector) AND the trackless roots (motion, audio, sensor events). The only
 * thing outside it is the ops log, which is global and longer than any device
 * window because it records what retention did — including for devices that no
 * longer exist.
 *
 * Two modes:
 *
 *  - `follow-recordings` (the DEFAULT): the window is the instant of the oldest
 *    segment still on disk. That follows the recorder's age retention AND its
 *    disk-pressure eviction automatically, with no second policy to keep in
 *    sync. A camera with no footage at all (recording off / brand new) falls
 *    back to `trackRetentionDays`, so analytics stay bounded either way.
 *
 *  - `custom`: `trackRetentionDays`, and nothing else. `0` = keep forever, and
 *    that is the ONE way retention is off for a device.
 *
 * ## Why there is only one number here
 *
 * There used to be four: `trackRetentionDays` plus a day window per event
 * family (motion / object / audio). [D61](../../../../docs/decisions/adr-0061.md)
 * made object events, faces, plates, crops and vectors TRACK-OWNED — they leave
 * through the cascade and by no other path — which silently disconnected
 * `retentionObjectDays` from the thing it was named after. An operator could set
 * object retention to 30 days, the form would save it, and the events would die
 * with their track at 7. A knob that decides nothing is worse than a missing
 * one: it reads as a decision that was made.
 *
 * So the per-family windows are gone (D62), not merely ignored, and the
 * surviving surface is ENUMERATED in {@link RETENTION_SETTING_KEYS} so
 * `scripts/check-retention-settings-consumed.ts` can fail the build the next
 * time a knob and its reader come apart.
 *
 * Follow-mode floor: nothing younger than {@link FOLLOW_FLOOR_DAYS} is ever
 * pruned, even when footage is younger (a camera that STARTED recording
 * yesterday must not nuke its whole history back to the first segment).
 */
import { z } from 'zod'

const DAY_MS = 24 * 60 * 60 * 1000

export type RetentionMode = 'follow-recordings' | 'custom'

/**
 * Follow-mode guard: never prune anything younger than this, regardless of how
 * young the oldest footage is.
 *
 * It is the SAME number as {@link TRACK_RETENTION_DEFAULT_DAYS} on purpose. Now
 * that this cutoff governs the whole cascade rather than a handful of event
 * rows, that equality is what makes `follow-recordings` safe as the default:
 * switching a camera from `custom(7)` to follow can only ever keep MORE, never
 * less. The cost is real and worth naming — the floor is now measured in media
 * bytes (~2–4 MB/track), not event rows, so a camera whose footage is down to
 * hours still holds 7 days of crops. The lever for that is `custom` with a
 * smaller number, which has no floor.
 */
export const FOLLOW_FLOOR_DAYS = 7

/**
 * Per-device analytics retention settings as stored in the device blob.
 * `retentionMode` absent = follow-recordings (the default).
 */
export const RetentionSettingsSchema = z.object({
  retentionMode: z.enum(['follow-recordings', 'custom']).default('follow-recordings'),
  trackRetentionDays: z.number().min(0).default(7),
})
export type RetentionSettings = z.infer<typeof RetentionSettingsSchema>

/**
 * The complete operator-visible retention surface, enumerated.
 *
 * Every key here must appear in the settings form AND be read by
 * {@link resolveRetentionCutoffs}; every retention field in the form must
 * appear here. `scripts/check-retention-settings-consumed.ts` enforces both
 * directions, and `__tests__/retention-policy.spec.ts` asserts this list IS the
 * schema (the list is hand-written because deriving it would need a cast).
 */
export const RETENTION_SETTING_KEYS: readonly (keyof RetentionSettings)[] = [
  'retentionMode',
  'trackRetentionDays',
]

/** The default retention window, in days. The form's default reads from here so
 *  the schema is the single source. */
export const TRACK_RETENTION_DEFAULT_DAYS: number = RetentionSettingsSchema.parse(
  {},
).trackRetentionDays

/** Resolve the settings from a raw device-store blob — invalid or missing
 *  fields fall back to defaults, never throw. */
export function resolveRetentionSettings(raw: Record<string, unknown>): RetentionSettings {
  const parsed = RetentionSettingsSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  // Field-by-field salvage: one bad field must not discard the others. Written
  // out per field rather than through a generic indexed helper, because the
  // helper needs a cast to convince TypeScript that `shape[k]` parses to
  // `RetentionSettings[K]`, and casts are exactly how a settings shape drifts
  // from the schema that is supposed to define it.
  const shape = RetentionSettingsSchema.shape
  const defaults = RetentionSettingsSchema.parse({})
  const mode = shape.retentionMode.safeParse(raw['retentionMode'])
  const days = shape.trackRetentionDays.safeParse(raw['trackRetentionDays'])
  return {
    retentionMode: mode.success ? mode.data : defaults.retentionMode,
    trackRetentionDays: days.success ? days.data : defaults.trackRetentionDays,
  }
}

/**
 * The effective retention cutoff for ONE device. `null` = keep forever, and the
 * sweep skips the device entirely — tracks, motion, audio and sensor alike.
 */
export interface DeviceRetentionCutoffs {
  /** Everything scoped to this device older than this instant is deleted.
   *  `null` = retention is OFF for this device. */
  readonly cutoffMs: number | null
  /** Which mode actually decided the number (follow may fall back to custom). */
  readonly effectiveMode: RetentionMode
  /**
   * `true` when `cutoffMs` is null because the follow-recordings floor could
   * not be READ this pass (D674) — not because the operator asked to keep
   * forever. A sweep skips the device either way, but must not report the
   * operator's setting as the cause: that line is latched and would state a
   * wrong cause for the life of the process. The floor's own owner logs this
   * case, once per episode.
   */
  readonly floorUnreadable?: true
}

/**
 * Follow-mode cutoff: the oldest retained footage instant, floored so anything
 * younger than {@link FOLLOW_FLOOR_DAYS} survives. `null` footage (none on
 * disk) → `null`, and the caller falls back to the custom window.
 */
export function followCutoffMs(nowMs: number, earliestFootageMs: number | null): number | null {
  if (earliestFootageMs === null) return null
  return Math.min(earliestFootageMs, nowMs - FOLLOW_FLOOR_DAYS * DAY_MS)
}

/** Compute the effective cutoff for one device at `nowMs`. */
export function resolveRetentionCutoffs(
  settings: RetentionSettings,
  nowMs: number,
  earliestFootageMs: number | null,
): DeviceRetentionCutoffs {
  if (settings.retentionMode === 'follow-recordings') {
    const cutoff = followCutoffMs(nowMs, earliestFootageMs)
    if (cutoff !== null) return { cutoffMs: cutoff, effectiveMode: 'follow-recordings' }
    // No footage → bounded by the custom window (fall through).
  }
  return {
    cutoffMs:
      settings.trackRetentionDays <= 0 ? null : nowMs - settings.trackRetentionDays * DAY_MS,
    effectiveMode: 'custom',
  }
}
