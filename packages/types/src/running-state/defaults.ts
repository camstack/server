import type { RunningStateStatus } from '../capabilities/running-state.cap.js'

export const RUNNING_POWER_THRESHOLD_WATTS = 5
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
