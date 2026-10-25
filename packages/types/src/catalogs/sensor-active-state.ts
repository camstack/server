/**
 * THE table "which boolean of this device type counts as HIGH", and the
 * pure evaluator of its EDGE.
 *
 * ONE table for everyone who asks "is this device HIGH?": the
 * recorder's `RecordingTriggers.sensorDeviceIds` trigger, the post-analysis
 * sensor markers, the orchestrator's camera-sensors bridge and
 * the sources of a pulse (`compilePulseOverride`, D936).
 * A second copy would diverge at the first cap added, and the symptom — "the
 * sensor rings the doorbell but does not record" — is exactly D62.
 *
 * ⚠ NOT `DEVICE_STATE_READERS` (`catalogs/device-state-vocabulary.ts`), and the
 * two must not be unified: that one answers "what is the state WORD for a
 * rule" (and includes `presence`, `cover`, `alarm-panel`), this one "which
 * boolean's EDGE counts". Deliberately different vocabularies.
 */

/**
 * Known binary / switch source caps → the boolean slice field whose
 * false→true rise counts as ACTIVE. Every entry is "fire on active".
 * Sensors whose "active" reading is not a plain boolean (presence's string
 * state, connectivity's connected flag) are deliberately excluded — a
 * reconnect is not a doorbell press, and it is not a recording either.
 */
export const SOURCE_CAP_ACTIVE_FIELD: Readonly<Record<string, string>> = {
  contact: 'entryOpen',
  binary: 'on',
  switch: 'on',
  motion: 'detected',
  flood: 'flooded',
  gas: 'detected',
  smoke: 'detected',
  'carbon-monoxide': 'detected',
  vibration: 'detected',
  tamper: 'tampered',
}

/**
 * The same caps → the slice field carrying the ms-epoch timestamp of the
 * last transition. Every source cap MUST appear here (guarded by a spec):
 * without a transition timestamp the evaluator cannot tell a genuine rise
 * from a boot-time hydration when the FIRST slice it ever sees is already
 * active, and errs towards silence — swallowing the rise.
 *
 * These timestamps are UPSTREAM ones, not ingest ones: the Home Assistant
 * provider derives them from `state.last_changed`, so they survive our own
 * restarts and correctly read as "hours ago" for a state that has been
 * active for hours. `motion` names its rise timestamp `lastDetectedAt`.
 */
export const SOURCE_CAP_CHANGED_AT_FIELD: Readonly<Record<string, string>> = {
  contact: 'lastChangedAt',
  binary: 'lastChangedAt',
  switch: 'lastChangedAt',
  motion: 'lastDetectedAt',
  flood: 'lastChangedAt',
  gas: 'lastChangedAt',
  smoke: 'lastChangedAt',
  'carbon-monoxide': 'lastChangedAt',
  vibration: 'lastChangedAt',
  tamper: 'lastChangedAt',
}

/** Cap names whose presence in a device's bindings qualify it as a source. */
export const SOURCE_CAPS: readonly string[] = Object.keys(SOURCE_CAP_ACTIVE_FIELD)

/**
 * Device `type` values (from `DeviceType`) that can host a binary/switch
 * source cap. Used by the camera's `device-multiselect` picker as the
 * CLIENT-SIDE filter, alongside `SOURCE_CAPS`.
 *
 * Why types and not caps alone: the shared picker filters
 * `deviceManager.listAll` rows client-side, and those rows carry only the
 * device's advertised `features` — NOT its registered cap list. On the live
 * cluster binary sensors and switches advertise EMPTY features (features
 * mirror only a handful of caps like `motion-trigger`), so a caps-only
 * filter matched against `features` would list nothing (the very bug this
 * replaced, which relied on the now-empty `getAllBindings`). Matching by
 * `type` is the reliable client-side signal; the union with `SOURCE_CAPS`
 * still captures any device that DOES advertise a source-cap feature.
 * `sensor` covers contact/motion/flood/gas/smoke/CO/vibration/tamper,
 * `switch` covers switches, `control` covers generic binary actuators.
 */
export const SOURCE_DEVICE_TYPES: readonly string[] = ['sensor', 'switch', 'control']

/** True when a cap is a recognised binary/switch source. */
export function isSourceCap(capName: string): boolean {
  return Object.prototype.hasOwnProperty.call(SOURCE_CAP_ACTIVE_FIELD, capName)
}

/** Extract the "active" boolean a source cap's slice carries, or null when
 *  the cap is unknown or the field is missing / non-boolean. */
export function sliceActiveValue(
  capName: string,
  slice: Readonly<Record<string, unknown>>,
): boolean | null {
  const field = SOURCE_CAP_ACTIVE_FIELD[capName]
  if (field === undefined) return null
  const raw = slice[field]
  return typeof raw === 'boolean' ? raw : null
}

/** Ms-epoch transition timestamp a source cap's slice carries, or null when
 *  it is absent, non-numeric or the zero "never observed" sentinel. */
export function sliceChangedAt(
  capName: string,
  slice: Readonly<Record<string, unknown>>,
): number | null {
  const field = SOURCE_CAP_CHANGED_AT_FIELD[capName]
  if (field === undefined) return null
  const raw = slice[field]
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  return raw
}

/**
 * Why a slice did not carry a rising edge. ONE enum, so "why did nothing
 * fire" has a single answer, whoever asks.
 */
export type SensorEdgeIgnoreReason =
  /** Not a recognised binary/switch source cap. */
  | 'unknown-cap'
  /** Recognised cap, but its active field is missing or not a boolean. */
  | 'non-boolean-value'
  /** First sighting, INACTIVE — nothing can have been lost. */
  | 'baseline-seeded-inactive'
  /** First sighting, ALREADY ACTIVE, and we could not prove it is a fresh
   *  transition. A genuine rise MAY have been swallowed here. */
  | 'baseline-seeded-stale-active'
  /** Re-emission carrying the same binary value. */
  | 'no-change'
  /** The falling edge — switch-off / contact-close never fires. */
  | 'falling-edge'
  /** A false→true level moved, but no finite source transition timestamp can
   *  prove when it happened. */
  | 'missing-timestamp'

export interface SensorEdgeInput {
  readonly capName: string
  readonly slice: Readonly<Record<string, unknown>>
  /** Last boolean observed for this `(device, cap)`; `undefined` = never seen. */
  readonly prior: boolean | undefined
  /** When the OBSERVER started watching — the floor for a first
   *  already-active observation. Each observer has its own. */
  readonly startedAtMs: number
  readonly nowMs: number
  readonly firstSightingFreshnessMs: number
}

/**
 * `value` is returned on every path where the slice CARRIED a boolean,
 * even when there is no edge: the caller updates its memory with that
 * and does not re-read the slice. On `unknown-cap` / `non-boolean-value` it is `null` and the
 * memory must not be touched.
 */
export type SensorEdgeVerdict =
  | { readonly edge: 'rising'; readonly value: true }
  | {
      readonly edge: 'none'
      readonly value: boolean | null
      readonly reason: SensorEdgeIgnoreReason
    }

/**
 * How recent a source's own transition timestamp must be for a FIRST
 * sighting that is already active to count as a genuine rise rather than a
 * hydration of long-standing state.
 */
export const DEFAULT_FIRST_SIGHTING_FRESHNESS_MS = 30_000

export interface SensorLevelEdgeInput {
  readonly level: boolean
  readonly changedAt: number | null
  readonly priorLevel: boolean | undefined
  readonly startedAtMs: number
  readonly nowMs: number
  readonly firstSightingFreshnessMs: number
}

export type SensorLevelEdgeVerdict =
  | { readonly kind: 'rise'; readonly timestamp: number }
  | { readonly kind: 'none'; readonly nextPriorLevel: boolean }

/**
 * The source-independent edge rule. The caller supplies an already extracted
 * boolean level and source timestamp; this function owns first-sighting
 * freshness and false-to-true detection.
 */
export function evaluateSensorLevelEdge(input: SensorLevelEdgeInput): SensorLevelEdgeVerdict {
  const timestamp = input.changedAt
  const freshFloor = Math.max(input.startedAtMs, input.nowMs - input.firstSightingFreshnessMs)
  const firstRise =
    input.priorLevel === undefined &&
    input.level &&
    timestamp !== null &&
    Number.isFinite(timestamp) &&
    timestamp >= freshFloor
  const transitionRise =
    input.priorLevel === false && input.level && timestamp !== null && Number.isFinite(timestamp)

  if ((firstRise || transitionRise) && timestamp !== null) {
    return { kind: 'rise', timestamp }
  }
  return { kind: 'none', nextPriorLevel: input.level }
}

/**
 * THE edge. Pure: no clock of its own, no memory — the caller
 * brings `prior`, `nowMs` and its own `startedAtMs`.
 *
 * The case of the FIRST slice already active is treated explicitly and counts as an
 * edge only if the UPSTREAM timestamp of the transition is later than
 * `startedAtMs` **and** within `firstSightingFreshnessMs`. Both halves
 * are needed: freshness alone would fire on a boot-time hydration of a
 * state flipped a few seconds before the restart, and "after we started"
 * alone would fire, on a long-lived process, for a source
 * adopted today whose state changed yesterday. The ambiguous case ERRS TOWARD
 * SILENCE and declares it (`baseline-seeded-stale-active`).
 */
export function evaluateSensorEdge(input: SensorEdgeInput): SensorEdgeVerdict {
  const value = sliceActiveValue(input.capName, input.slice)
  if (value === null) {
    return {
      edge: 'none',
      value: null,
      reason: isSourceCap(input.capName) ? 'non-boolean-value' : 'unknown-cap',
    }
  }
  const verdict = evaluateSensorLevelEdge({
    level: value,
    changedAt: sliceChangedAt(input.capName, input.slice),
    priorLevel: input.prior,
    startedAtMs: input.startedAtMs,
    nowMs: input.nowMs,
    firstSightingFreshnessMs: input.firstSightingFreshnessMs,
  })
  if (verdict.kind === 'rise') return { edge: 'rising', value: true }
  if (input.prior === undefined) {
    if (!value) return { edge: 'none', value, reason: 'baseline-seeded-inactive' }
    return { edge: 'none', value, reason: 'baseline-seeded-stale-active' }
  }
  if (input.prior === value) return { edge: 'none', value, reason: 'no-change' }
  if (!value) return { edge: 'none', value, reason: 'falling-edge' }
  return { edge: 'none', value, reason: 'missing-timestamp' }
}
