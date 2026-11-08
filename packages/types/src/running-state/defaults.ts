import { DeviceType } from '../device/device-type.js'
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

/** The dwell numbers a power-driven running threshold starts from. */
export interface RunningPowerDefaults {
  readonly startDwellMs: number
  readonly stopDwellMs: number
  readonly minSamples: number
}

/** What every type without its own row starts from. */
export const RUNNING_POWER_GLOBAL_DEFAULTS: RunningPowerDefaults = {
  startDwellMs: RUNNING_POWER_START_DELAY_MS,
  stopDwellMs: RUNNING_POWER_STOP_DELAY_MS,
  minSamples: RUNNING_POWER_MIN_SAMPLES,
}

/**
 * Per-type overrides of the dwell defaults. A media player draws power the
 * moment it is on and stops drawing the moment it is off, so it needs neither
 * a long dwell nor a second sample. A type absent here keeps the global values.
 */
export const RUNNING_POWER_DEFAULTS_BY_TYPE: Readonly<
  Partial<Record<DeviceType, RunningPowerDefaults>>
> = {
  [DeviceType.MediaPlayer]: {
    startDwellMs: 10_000,
    stopDwellMs: 10_000,
    minSamples: 1,
  },
}

/** The only place a running-power dwell default is resolved for a device type. */
export function runningPowerDefaultsFor(deviceType: DeviceType | undefined): RunningPowerDefaults {
  if (deviceType === undefined) return RUNNING_POWER_GLOBAL_DEFAULTS
  return RUNNING_POWER_DEFAULTS_BY_TYPE[deviceType] ?? RUNNING_POWER_GLOBAL_DEFAULTS
}

/** Before any provider reading — all fields unknown (D933). */
export const RUNNING_STATE_COLD: RunningStateStatus = {
  running: null,
  since: null,
  source: 'native',
  phase: null,
  lastFetchedAt: null,
}
