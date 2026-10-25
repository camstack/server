import { z } from 'zod'
import {
  SUPPRESS_IOU,
  WAKE_ASSOC_IOU,
  SESSION_STILLNESS_WINDOW_MS,
  ENTRY_TTL_MS,
} from './pipeline/stationary/stationary-types.js'

/**
 * Per-device stationary-object (parked/idle suppression) settings. Cascade: a
 * per-device override on top of the global default, resolved per field (an
 * invalid/missing value falls back to its default — parse never throws).
 * Mirrors `media-settings` / `tracking-settings`.
 *
 * The defaults are the SAME constants the registry uses at runtime
 * (`stationary-types.ts`), imported (not copied) so an unset value and a reset
 * value both resolve to exactly today's behaviour — "reset == unset == today",
 * with no drift. Guarded by a unit test asserting the equality.
 */
export const StationarySettingsSchema = z.object({
  /** Master switch. Off ⇒ this camera gathers no evidence and suppresses
   *  nothing (every parked object keeps spawning normal tracks). */
  enabled: z.boolean().default(true),
  /** IoU at/above which a detection is the same parked object, unmoved →
   *  suppress its spawn. `SUPPRESS_IOU`. */
  suppressIou: z.number().min(0.3).max(0.9).default(SUPPRESS_IOU),
  /** Minimum IoU for a detection to be ASSOCIATED with an entry (confirm or
   *  wake it) — the overlap gate that stops a different vehicle from waking a
   *  parked entry (the 102 flood fix). `WAKE_ASSOC_IOU`. */
  wakeAssocIou: z.number().min(0.02).max(0.5).default(WAKE_ASSOC_IOU),
  /** Recent-window stillness after which a track stops holding its motion
   *  session open (also the minimum track age). Creates nothing — birth is
   *  decided by repeated evidence. `SESSION_STILLNESS_WINDOW_MS`. */
  sessionStillnessWindowMs: z
    .number()
    .int()
    .min(5_000)
    .max(120_000)
    .default(SESSION_STILLNESS_WINDOW_MS),
  /** Observed-time TTL: retire an entry unconfirmed for this long (measured on
   *  frames-flowing time, not wall-clock). `ENTRY_TTL_MS`. */
  entryTtlMs: z.number().int().min(60_000).max(1_800_000).default(ENTRY_TTL_MS),
})

export type StationarySettings = z.infer<typeof StationarySettingsSchema>

export const STATIONARY_DEFAULTS: StationarySettings = StationarySettingsSchema.parse({})

/**
 * Resolve a per-device store blob into typed stationary settings. Unknown/invalid
 * fields fall back to the default for that field (never throws on a bad blob).
 */
export function resolveStationarySettings(raw: Record<string, unknown>): StationarySettings {
  const pick = <K extends keyof StationarySettings>(key: K): StationarySettings[K] => {
    const field = StationarySettingsSchema.shape[key]
    const parsed = field.safeParse(raw[key])
    return parsed.success ? (parsed.data as StationarySettings[K]) : STATIONARY_DEFAULTS[key]
  }
  return {
    enabled: pick('enabled'),
    suppressIou: pick('suppressIou'),
    wakeAssocIou: pick('wakeAssocIou'),
    sessionStillnessWindowMs: pick('sessionStillnessWindowMs'),
    entryTtlMs: pick('entryTtlMs'),
  }
}
