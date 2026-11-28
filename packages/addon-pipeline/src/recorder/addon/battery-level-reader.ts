import { batteryCapability, type AddonApi } from '@dominevo/types'
import { batteryLevelFromSlice, type BatteryReading } from '../battery-hysteresis.js'
import { withDeadline } from './with-deadline.js'

/** The one hub call the charge read makes. */
export interface BatteryLevelApi {
  readonly deviceState: Pick<AddonApi['deviceState'], 'getCapSlice'>
}

/**
 * The charge a battery device's OWNER published, read from its `battery` slice
 * (D224) — never from the camera, so reading it cannot wake it. Bounded: a read
 * that fails or times out is `null` (UNKNOWN), exactly like a stale or
 * unparseable slice, and unknown is never `0` (D49, D315).
 */
export function batteryLevelReader(
  api: BatteryLevelApi,
  readTimeoutMs: number,
  nowMs: () => number,
): (deviceId: number) => Promise<BatteryReading | null> {
  return async (deviceId) => {
    const slice = await withDeadline(
      api.deviceState.getCapSlice.query({ deviceId, capName: batteryCapability.name }),
      readTimeoutMs,
      'getCapSlice',
    ).catch(() => null)
    return batteryLevelFromSlice(slice, nowMs())
  }
}
