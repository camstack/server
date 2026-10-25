import { z } from 'zod'

/**
 * Per-device DETECTION CONFIRMATION GATE tuning.
 *
 * Before a NEW track is born (its `start` lifecycle + firstFrame media emitted)
 * the gate optionally re-runs object detection on the HI-RES NATIVE CROP of the
 * detection box. If the crop does not confirm a compatible object above
 * `minConfidence`, the birth is SUPPRESSED — it was a false positive from the
 * low-res detection frame (a static "person" phantom, a parked-truck ghost, a
 * misclassified static object).
 *
 * ON by default (`enabled` defaults to TRUE). An earlier version of this line
 * said "Ships DORMANT: `enabled` defaults to `false`" — that was stale, and on
 * 2026-07-30 it nearly produced the conclusion that the gate was not running at
 * all. It is: it suppressed several phantom births on device 101 that same day.
 * Read the schema, not this paragraph.
 *
 * The gate is fail-DEFERRED, not fail-open (changed 2026-08-01). Anything that
 * prevents a MEASUREMENT — a missing frame handle, an unavailable inference
 * cap, a crop-fetch miss, a re-detection error, a timeout — leaves the birth
 * UNDECIDED and re-tried on later frames. Only an exhausted deferral with no
 * crop at all falls open, and that is logged at `warn`. Fail-open on every one
 * of those paths is what let a brick wall onto camera 636's track feed as a
 * `vehicle`, and left 45% of births unmeasured over twelve hours.
 *
 * Every field is independently overridable per camera; an unknown/invalid value
 * falls back to the field default (never throws on a bad blob) — mirrors
 * {@link resolveTrackingSettings}.
 */
/**
 * Per-device store keys the confirmation gate reads. FLAT (not nested under a
 * `confirmationGate` blob) so the fields flow through the same hydrate /
 * `applyDeviceSettingsPatch` path as every other per-device tunable
 * (trackTtlMs, minScorePerson, …) and surface directly in the operator's
 * Detection-pipeline → Settings form.
 */
export const CONFIRMATION_GATE_KEYS = {
  enabled: 'confirmationGateEnabled',
  minConfidence: 'confirmationGateMinConfidence',
  minCropPx: 'confirmationGateMinCropPx',
  timeoutMs: 'confirmationGateTimeoutMs',
  maxDeferralMs: 'confirmationGateMaxDeferralMs',
  maxAttempts: 'confirmationGateMaxAttempts',
} as const

const ConfirmationGateSettingsSchema = z.object({
  /** Master switch. DEFAULT ON (2026-07-20 rollout) — the gate is FAIL-OPEN (any
   *  crop-fetch / re-detection error or timeout confirms the birth), so enabling
   *  it can only SUPPRESS false-positive births, never drop a real track on
   *  error. Per-device store `confirmationGateEnabled=false` opts a camera out. */
  enabled: z.boolean().default(true),
  /**
   * Minimum re-detection score (0..1) required in the crop for a birth to be
   * confirmed. A detection must clear this AND be class-compatible with the
   * track's class.
   */
  minConfidence: z.number().min(0).max(1).default(0.4),
  /**
   * Minimum crop size (px, longest side in detection-frame pixel space) worth
   * re-detecting. A subject box smaller than this is too tiny to confirm
   * reliably, so the gate SKIPS it and fails open (confirms the birth). 0 =
   * confirm every birth regardless of size.
   */
  minCropPx: z.number().int().min(0).default(48),
  /**
   * Per-ATTEMPT confirmation budget (ms). If the crop fetch + re-detection does
   * not resolve within this window the attempt ends UNDECIDED, so the
   * synchronous frame path never stalls on inference.
   */
  timeoutMs: z.number().int().min(1).default(300),
  /**
   * How long a birth may stay UNDECIDED before the gate stops waiting for a
   * native crop and decides on the sub-native fallback.
   *
   * Measured from the FIRST attempt, so retries cannot push it out. 0 = decide
   * on the first attempt (the pre-2026-08-01 cadence, without the fail-open).
   */
  maxDeferralMs: z.number().int().min(0).default(2000),
  /** How many gate attempts one birth may have, the first included. */
  maxAttempts: z.number().int().min(1).default(4),
})
export type ConfirmationGateSettings = z.infer<typeof ConfirmationGateSettingsSchema>

export const CONFIRMATION_GATE_DEFAULTS: ConfirmationGateSettings =
  ConfirmationGateSettingsSchema.parse({})

/**
 * Resolve a per-device store blob into typed confirmation-gate settings. The
 * gate's fields live as FLAT keys ({@link CONFIRMATION_GATE_KEYS}) in the
 * per-device store — the same shape the Detection-pipeline → Settings form
 * writes. Each field is validated independently via `.catch(default)` so an
 * invalid/missing field falls back to its default and parse never throws.
 * (A legacy nested `confirmationGate` blob, if any, is simply ignored.)
 */
export function resolveConfirmationGateSettings(
  raw: Record<string, unknown>,
): ConfirmationGateSettings {
  const s = ConfirmationGateSettingsSchema.shape
  return {
    enabled: s.enabled
      .catch(CONFIRMATION_GATE_DEFAULTS.enabled)
      .parse(raw[CONFIRMATION_GATE_KEYS.enabled]),
    minConfidence: s.minConfidence
      .catch(CONFIRMATION_GATE_DEFAULTS.minConfidence)
      .parse(raw[CONFIRMATION_GATE_KEYS.minConfidence]),
    minCropPx: s.minCropPx
      .catch(CONFIRMATION_GATE_DEFAULTS.minCropPx)
      .parse(raw[CONFIRMATION_GATE_KEYS.minCropPx]),
    timeoutMs: s.timeoutMs
      .catch(CONFIRMATION_GATE_DEFAULTS.timeoutMs)
      .parse(raw[CONFIRMATION_GATE_KEYS.timeoutMs]),
    maxDeferralMs: s.maxDeferralMs
      .catch(CONFIRMATION_GATE_DEFAULTS.maxDeferralMs)
      .parse(raw[CONFIRMATION_GATE_KEYS.maxDeferralMs]),
    maxAttempts: s.maxAttempts
      .catch(CONFIRMATION_GATE_DEFAULTS.maxAttempts)
      .parse(raw[CONFIRMATION_GATE_KEYS.maxAttempts]),
  }
}
