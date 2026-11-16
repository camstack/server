import {
  SirenOptionsSource,
  type SirenDurationRange,
  type SirenOptions,
  type SirenStatus,
} from './siren.cap.js'

/**
 * Pure duration maths for the `siren` cap, shared by every provider so a
 * trigger and the countdown it publishes mean the same thing everywhere.
 */

/** The longest range `sirenPlayChoices` spells out; a picker of more entries is not a picker. */
const MAX_PLAY_CHOICES = 200

/** An activation asked in plays (#589): the count, and whether its end is an estimate. */
export interface SirenPlaysActivation {
  readonly plays: number | null
  readonly estimated: boolean
}

/** What a trigger asked for: seconds, plays, or neither (the camera default). */
export interface SirenTriggerRequest {
  readonly durationSeconds?: number
  readonly plays?: number
}

/** How a provider carries out a trigger, decided before it touches the camera. */
export type SirenTriggerPlan =
  | {
      readonly asked: 'seconds'
      readonly seconds: number
      /** The camera counts plays and the factor is not its own: the end is an estimate. */
      readonly estimated: boolean
    }
  | {
      readonly asked: 'plays'
      readonly plays: number
      /** `plays × secondsPerPlay`; `null` when the camera gives no factor. */
      readonly seconds: number | null
      readonly estimated: boolean
    }
  | { readonly asked: 'refused'; readonly reason: string }

/** The state of a siren that is not sounding. Keeps the last activation's facts. */
export function sirenIdleStatus(previous: SirenStatus | undefined): SirenStatus {
  return {
    active: false,
    activeUntil: null,
    durationSeconds: previous?.durationSeconds ?? null,
    plays: previous?.plays ?? null,
    activeUntilEstimated: false,
    lastTriggeredAt: previous?.lastTriggeredAt ?? 0,
  }
}

/**
 * The state right after a timed trigger: sounding until `now + seconds`. A
 * trigger asked in plays passes its count, and whether that end is an estimate.
 */
export function sirenTriggeredStatus(
  nowMs: number,
  seconds: number,
  activation?: SirenPlaysActivation,
): SirenStatus {
  return {
    active: true,
    activeUntil: nowMs + Math.round(seconds * 1000),
    durationSeconds: seconds,
    plays: activation?.plays ?? null,
    activeUntilEstimated: activation?.estimated ?? false,
    lastTriggeredAt: nowMs,
  }
}

/** The nearest listed value, or the value clamped and stepped inside the range. */
function snap(
  list: readonly number[] | null,
  range: SirenDurationRange | null,
  wanted: number,
): number {
  if (list !== null && list.length > 0) {
    return list.reduce((best, candidate) =>
      Math.abs(candidate - wanted) < Math.abs(best - wanted) ? candidate : best,
    )
  }
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

/**
 * The duration a trigger will really use: the request (or the camera default)
 * snapped to what the camera allows — the nearest listed value, or clamped and
 * stepped inside the range. Never longer or shorter than the camera can play.
 */
export function resolveSirenSeconds(options: SirenOptions, requested: number | undefined): number {
  return snap(options.allowedSeconds, options.rangeSeconds, requested ?? options.defaultSeconds)
}

/**
 * The play count a trigger will really use, snapped like the seconds; `null`
 * when the camera declares no plays (it counts seconds).
 */
export function resolveSirenPlays(
  options: SirenOptions,
  requested: number | undefined,
): number | null {
  if (options.defaultPlays === null) return null
  return snap(options.allowedPlays, options.rangePlays, requested ?? options.defaultPlays)
}

/** The counts a rule may pick: the list, or the range spelled out; empty without plays. */
export function sirenPlayChoices(options: SirenOptions): number[] {
  if (options.allowedPlays !== null) return [...options.allowedPlays]
  const range = options.rangePlays
  if (range === null) return []
  const count = Math.min(MAX_PLAY_CHOICES, Math.floor((range.max - range.min) / range.step) + 1)
  return Array.from({ length: count }, (_, i) => range.min + i * range.step)
}

/** Whether an end computed through `secondsPerPlay` is an estimate. */
function playsEndIsEstimate(options: SirenOptions): boolean {
  return options.source !== SirenOptionsSource.Camera
}

/**
 * Decides a trigger: a count on a siren that declares no plays is refused; a
 * count is snapped and timed through `secondsPerPlay`; seconds keep the old
 * snapping. Never both — the input schema refuses that before it gets here.
 */
export function planSirenTrigger(
  options: SirenOptions,
  request: SirenTriggerRequest,
): SirenTriggerPlan {
  if (request.plays !== undefined) {
    const plays = resolveSirenPlays(options, request.plays)
    if (plays === null) {
      return { asked: 'refused', reason: 'this siren counts seconds, not plays' }
    }
    const factor = options.secondsPerPlay
    return {
      asked: 'plays',
      plays,
      seconds: factor === null ? null : plays * factor,
      estimated: factor === null || playsEndIsEstimate(options),
    }
  }
  return {
    asked: 'seconds',
    seconds: resolveSirenSeconds(options, request.durationSeconds),
    estimated: options.unit === 'plays' && playsEndIsEstimate(options),
  }
}
