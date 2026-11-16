import type { SirenOptions, SirenStatus } from './siren.cap.js'

/**
 * Pure duration maths for the `siren` cap, shared by every provider so a
 * trigger and the countdown it publishes mean the same thing everywhere.
 */

/** The state of a siren that is not sounding. Keeps the last activation's facts. */
export function sirenIdleStatus(previous: SirenStatus | undefined): SirenStatus {
  return {
    active: false,
    activeUntil: null,
    durationSeconds: previous?.durationSeconds ?? null,
    lastTriggeredAt: previous?.lastTriggeredAt ?? 0,
  }
}

/** The state right after a timed trigger: sounding until `now + seconds`. */
export function sirenTriggeredStatus(nowMs: number, seconds: number): SirenStatus {
  return {
    active: true,
    activeUntil: nowMs + Math.round(seconds * 1000),
    durationSeconds: seconds,
    lastTriggeredAt: nowMs,
  }
}

/**
 * The duration a trigger will really use: the request (or the camera default)
 * snapped to what the camera allows — the nearest listed value, or clamped and
 * stepped inside the range. Never longer or shorter than the camera can play.
 */
export function resolveSirenSeconds(options: SirenOptions, requested: number | undefined): number {
  const wanted = requested ?? options.defaultSeconds
  const list = options.allowedSeconds
  if (list !== null && list.length > 0) {
    return list.reduce((best, candidate) =>
      Math.abs(candidate - wanted) < Math.abs(best - wanted) ? candidate : best,
    )
  }
  const range = options.rangeSeconds
  if (range !== null) {
    const clamped = Math.min(range.max, Math.max(range.min, wanted))
    const steps = Math.min(
      Math.round((clamped - range.min) / range.step),
      Math.floor((range.max - range.min) / range.step),
    )
    return range.min + steps * range.step
  }
  return wanted
}
