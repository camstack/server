/** A duration in seconds, as the three numbers a person reads: hours, minutes, seconds. */
export interface DurationParts {
  readonly hours: number
  readonly minutes: number
  readonly seconds: number
}

export type DurationPart = keyof DurationParts

export const DURATION_PARTS: readonly DurationPart[] = ['hours', 'minutes', 'seconds']

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3_600
/** A fraction of a second is kept to the millisecond. */
const MILLIS = 1_000

export function splitDurationParts(totalSeconds: number): DurationParts {
  const total = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0
  const hours = Math.floor(total / SECONDS_PER_HOUR)
  const minutes = Math.floor((total - hours * SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const rest = total - hours * SECONDS_PER_HOUR - minutes * SECONDS_PER_MINUTE
  return { hours, minutes, seconds: Math.round(rest * MILLIS) / MILLIS }
}

export function joinDurationParts(parts: DurationParts): number {
  const total = parts.hours * SECONDS_PER_HOUR + parts.minutes * SECONDS_PER_MINUTE + parts.seconds
  return Math.round(total * MILLIS) / MILLIS
}
