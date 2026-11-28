import type { TimedRunResult } from '@dominevo/types'

/**
 * The switch's timed run, as every card whose power is a `switch` offers it
 * (plug, heater, fan, light, siren, appliance): one model, one control
 * (`SwitchTimer`, the shared `TimedRunQuick`).
 */
export interface SwitchTimerModel {
  /** The device's saved one-tap run, in minutes: what the control holds until it is edited. */
  readonly defaultMinutes: number
  /** The longest run the switch declares. */
  readonly maxMinutes: number
  /** Epoch ms the running cycle ends at; null when none runs. */
  readonly endsAt: number | null
}

/** Each call rejects with the reason it was refused; the control says it. */
export interface SwitchTimerActions {
  readonly onTimerStart: (minutes: number) => Promise<TimedRunResult>
  /** Saves the one-tap run for this device. */
  readonly onTimerSave: (minutes: number) => Promise<void>
  readonly onTimerStop: () => Promise<void>
}
