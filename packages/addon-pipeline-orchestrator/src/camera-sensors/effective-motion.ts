/**
 * The camera's EFFECTIVE onboard motion (D673) — the combining rule as ONE
 * pure function, so the bridge, the status and any other reading of it can
 * never disagree, and a different reading of the rule is a change to this file
 * and its truth table only.
 *
 * The controller's ruling on Q1 (2026-10-01, spec C2): a Confirm sensor GATES
 * the camera's own motion even without a Replace sensor.
 *
 *   motion = A ∨ R ∨ (camera ∧ C) ∨ (camera ∧ no ready Replace ∧ no ready Confirm)
 *
 * A / R / C = some In-addition / Replace / Confirm sensor is active (an active
 * In-addition or Replace sensor counts whatever its readiness; readiness only
 * decides whether the camera is reshaped, and a Confirm must be ready to
 * confirm). A stuck sensor (C5) stops being active but stays READY, so a stuck
 * Replace still replaces and a stuck Confirm still gates. Only READY
 * sensors reshape the camera's own motion (C3: an offline Replace or Confirm
 * sensor hands the camera back, the D663 rule for a replaced field whose
 * source is gone). The operator's original formula (2026-09-30) made a lone
 * Confirm a no-op; reverting is a change to `cameraOwnMotionRule` only.
 * Activity (C4, C5): a camera is high while its last own edge was `true` and
 * younger than its cooldown (heartbeat-only cameras, D672 rule 8); a sensor
 * while its level is high and its last REAL rise is younger than
 * `maxSessionHoldMs` (a lost `off` is bounded per sensor); a Confirm sensor
 * also for one cooldown after it fell (the coincidence window).
 */
import type { CameraOwnMotion, CameraSensorMode } from '@camstack/types'

export interface SensorInputState {
  readonly mode: CameraSensorMode
  readonly ready: boolean
  readonly high: boolean
  /** Its last REAL rise (an edge, never a tick); null = never seen rising (a stale first sighting). */
  readonly lastRiseAt: number | null
  readonly lastFallAt: number | null
}

export interface CameraLevelState {
  readonly detected: boolean
  readonly atMs: number
}

export interface EffectiveMotionInput {
  readonly now: number
  readonly cooldownMs: number
  readonly maxHoldMs: number
  readonly camera: CameraLevelState | null
  readonly sensors: readonly SensorInputState[]
}

export type EffectiveSupport = 'in-addition' | 'replace' | 'camera' | 'camera-confirmed'
export type CameraDropReason = 'replaced' | 'not-confirmed'

export interface EffectiveMotion {
  readonly high: boolean
  readonly support: readonly EffectiveSupport[]
  readonly cameraMotion: CameraOwnMotion
  /** Why the camera's own HIGH motion did not count; null when it counted or was low. */
  readonly cameraDropped: CameraDropReason | null
}

type ModeReadiness = Pick<SensorInputState, 'mode' | 'ready'>

/**
 * `when-confirmed` with a ready Confirm (with or without a ready Replace),
 * `never` with a ready Replace and no ready Confirm, else `always`.
 */
export function cameraOwnMotionRule(sensors: readonly ModeReadiness[]): CameraOwnMotion {
  if (sensors.some((s) => s.mode === 'confirm' && s.ready)) return 'when-confirmed'
  return sensors.some((s) => s.mode === 'replace' && s.ready) ? 'never' : 'always'
}

export function cameraHigh(
  camera: CameraLevelState | null,
  now: number,
  cooldownMs: number,
): boolean {
  return camera !== null && camera.detected && now - camera.atMs < cooldownMs
}

export function sensorActive(
  sensor: SensorInputState,
  now: number,
  cooldownMs: number,
  maxHoldMs: number,
): boolean {
  if (sensor.high) return sensor.lastRiseAt !== null && now - sensor.lastRiseAt < maxHoldMs
  return (
    sensor.mode === 'confirm' && sensor.lastFallAt !== null && now - sensor.lastFallAt < cooldownMs
  )
}

interface CameraTerm {
  readonly support: readonly EffectiveSupport[]
  readonly dropped: CameraDropReason | null
}

function cameraTerm(
  input: EffectiveMotionInput,
  rule: CameraOwnMotion,
  active: (s: SensorInputState) => boolean,
): CameraTerm {
  if (!cameraHigh(input.camera, input.now, input.cooldownMs)) return { support: [], dropped: null }
  if (rule === 'always') return { support: ['camera'], dropped: null }
  const confirmed = input.sensors.some((s) => s.mode === 'confirm' && s.ready && active(s))
  if (confirmed) return { support: ['camera-confirmed'], dropped: null }
  return { support: [], dropped: rule === 'never' ? 'replaced' : 'not-confirmed' }
}

export function effectiveMotion(input: EffectiveMotionInput): EffectiveMotion {
  const active = (s: SensorInputState): boolean =>
    sensorActive(s, input.now, input.cooldownMs, input.maxHoldMs)
  const cameraMotion = cameraOwnMotionRule(input.sensors)
  const anyActive = (mode: CameraSensorMode): boolean =>
    input.sensors.some((s) => s.mode === mode && active(s))
  const camera = cameraTerm(input, cameraMotion, active)
  const support: readonly EffectiveSupport[] = [
    ...(anyActive('in-addition') ? (['in-addition'] as const) : []),
    ...(anyActive('replace') ? (['replace'] as const) : []),
    ...camera.support,
  ]
  return { high: support.length > 0, support, cameraMotion, cameraDropped: camera.dropped }
}
