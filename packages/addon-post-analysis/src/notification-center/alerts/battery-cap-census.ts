/**
 * What one bindings read says about a device's `battery` cap (#522) — the
 * production answer behind {@link NcDeviceAlertsDeps.batteryCapCensus}.
 *
 * A battery episode may be closed only when the device's OWN provider is up
 * and simply no longer declares the cap. A provider that crashed or is still
 * restarting holds no native binding at all, and that is no answer about the
 * battery: the census says so with `nativeBindings: 0`.
 */
import { batteryCapability } from '@camstack/types'

export interface NcBatteryCapCensus {
  /** The device still has a `battery` binding. */
  readonly battery: boolean
  /** Native bindings its owning addon holds; 0 = the provider is not up. */
  readonly nativeBindings: number
}

/** The part of a `deviceManager.getBindings` entry the census reads. */
export interface NcBindingEntryFacts {
  readonly capName: string
  readonly kind: 'native' | 'wrapped'
}

/** The part of a `deviceManager.getBindings` answer the census reads. */
export interface NcDeviceBindingsFacts {
  readonly entries: readonly NcBindingEntryFacts[]
}

export type NcReadDeviceBindings = (deviceId: number) => Promise<NcDeviceBindingsFacts>

/** `null` = the read failed, which changes nothing (D49). */
export type NcBatteryCapCensusPort = (deviceId: number) => Promise<NcBatteryCapCensus | null>

export function batteryCapCensusOver(read: NcReadDeviceBindings): NcBatteryCapCensusPort {
  return async (deviceId) => {
    try {
      const { entries } = await read(deviceId)
      return {
        battery: entries.some((entry) => entry.capName === batteryCapability.name),
        nativeBindings: entries.filter((entry) => entry.kind === 'native').length,
      }
    } catch {
      return null
    }
  }
}
