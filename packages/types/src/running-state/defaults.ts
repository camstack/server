import type { RunningStateStatus } from '../capabilities/running-state.cap.js'

export const RUNNING_POWER_THRESHOLD_WATTS = 5
/**
 * A power reading starts a run only on this many samples above the threshold: a
 * standby plug sends ONE isolated blip and goes quiet, and a held value must not
 * start a run when the start dwell's timer fires. Emitted as `dwell`'s 4th argument.
 */
export const RUNNING_POWER_MIN_SAMPLES = 2
export const RUNNING_POWER_START_DELAY_MS = 30_000
export const RUNNING_POWER_STOP_DELAY_MS = 180_000

/** Before any provider reading — all fields unknown (D933). */
export const RUNNING_STATE_COLD: RunningStateStatus = {
  running: null,
  since: null,
  source: 'native',
  phase: null,
  lastFetchedAt: null,
}
