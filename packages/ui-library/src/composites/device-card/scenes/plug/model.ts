import type { CardCommon, CardCommonActions } from '../../shell/model'

export interface PlugTimer {
  /** The run the button offers until the operator changes it. */
  readonly defaultMinutes: number
  /** The longest run the switch declares. */
  readonly maxMinutes: number
  /** Epoch ms the running cycle ends at; null when none runs. */
  readonly endsAt: number | null
}

export interface PlugCardModel {
  readonly common: CardCommon
  /** Null when the switch state is not known. */
  readonly on: boolean | null
  readonly since: string | null
  /** Null when the switch declares no timed run. */
  readonly timer: PlugTimer | null
}

export interface PlugCardActions extends CardCommonActions {
  readonly onPower: (on: boolean) => void
  readonly onTimerStart: (minutes: number) => void
  readonly onTimerStop: () => void
}

export const PLUG_TIMER_MIN_MINUTES = 5
const FINE_STEP = 5
const COARSE_STEP = 15
const FINE_UNTIL = 60

/** The next duration one press of + or - gives: 5 min steps up to an hour, then 15. */
export function stepPlugTimer(minutes: number, direction: 1 | -1, maxMinutes: number): number {
  const step =
    direction === 1
      ? minutes >= FINE_UNTIL
        ? COARSE_STEP
        : FINE_STEP
      : minutes > FINE_UNTIL
        ? COARSE_STEP
        : FINE_STEP
  return Math.min(maxMinutes, Math.max(PLUG_TIMER_MIN_MINUTES, minutes + direction * step))
}

export interface PlugDuration {
  readonly hours: number
  readonly minutes: number
}

export function splitPlugDuration(minutes: number): PlugDuration {
  return {
    hours: Math.floor(minutes / FINE_UNTIL),
    minutes: minutes % FINE_UNTIL,
  }
}
