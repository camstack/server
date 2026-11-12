/**
 * The switch's timed run, as every card whose power is a `switch` offers it
 * (plug, heater, fan): one model, one stepping rule, one control
 * (`SwitchTimer`).
 */
export interface SwitchTimerModel {
  /** The run the button offers until the operator changes it. */
  readonly defaultMinutes: number
  /** The longest run the switch declares. */
  readonly maxMinutes: number
  /** Epoch ms the running cycle ends at; null when none runs. */
  readonly endsAt: number | null
}

export interface SwitchTimerActions {
  readonly onTimerStart: (minutes: number) => void
  readonly onTimerStop: () => void
}

export const SWITCH_TIMER_MIN_MINUTES = 5
const FINE_STEP = 5
const COARSE_STEP = 15
const FINE_UNTIL = 60

/** The next duration one press of + or - gives: 5 min steps up to an hour, then 15. */
export function stepSwitchTimer(minutes: number, direction: 1 | -1, maxMinutes: number): number {
  const step =
    direction === 1
      ? minutes >= FINE_UNTIL
        ? COARSE_STEP
        : FINE_STEP
      : minutes > FINE_UNTIL
        ? COARSE_STEP
        : FINE_STEP
  return Math.min(maxMinutes, Math.max(SWITCH_TIMER_MIN_MINUTES, minutes + direction * step))
}

export interface SwitchTimerDuration {
  readonly hours: number
  readonly minutes: number
}

export function splitSwitchTimerDuration(minutes: number): SwitchTimerDuration {
  return {
    hours: Math.floor(minutes / FINE_UNTIL),
    minutes: minutes % FINE_UNTIL,
  }
}
