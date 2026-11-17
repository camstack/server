import type { BatteryStatus } from '../capabilities/battery.cap.js'
import type { LowPowerSleepStatus } from '../capabilities/low-power-sleep.cap.js'
import { DeviceFeature } from './device-type.js'

/**
 * Does this device SLEEP and need waking before it streams (#459, Q2)?
 *
 * The one predicate every data-plane consumer asks (prebuffer, wake-on-play,
 * the recorder, sentry, the snapshot wrapper, the detection profile). It reads
 * `DeviceFeature.Sleeps`, derived from the `low-power-sleep` cap — never
 * `DeviceFeature.BatteryOperated`, which only says the device reports a
 * battery: a battery sensor reports charge and never sleeps.
 */
export function deviceSleeps(features: readonly string[]): boolean {
  return features.includes(DeviceFeature.Sleeps)
}

/**
 * The `low-power-sleep` slice a provider projects from the `battery` slice it
 * already keeps: the sleep inputs, nothing else. One fact, one writer — the
 * provider's battery bookkeeping stays the source until the sleep state gets
 * its own writer.
 */
export function sleepSliceOfBattery(status: BatteryStatus): LowPowerSleepStatus {
  return {
    sleeping: status.sleeping,
    ...(status.lastContactAt !== undefined ? { lastContactAt: status.lastContactAt } : {}),
    lastUpdated: status.lastUpdated,
  }
}
