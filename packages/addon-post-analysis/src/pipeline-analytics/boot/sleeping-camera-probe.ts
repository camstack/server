import { deviceSleeps } from '@camstack/types'

/** The part of a registry device the probe reads. */
export interface SleepingCameraFacts {
  readonly features: readonly string[]
}

/** A type alias, not an interface: tRPC's input carries an index signature. */
export type SleepingCameraQuery = { readonly deviceId: number }

/**
 * The one registry read the probe needs — a structural subset that
 * `AddonApi['deviceManager']` satisfies.
 */
export interface SleepingCameraProbeClient {
  readonly getDevice: {
    readonly query: (input: SleepingCameraQuery) => Promise<SleepingCameraFacts | null>
  }
}

/**
 * "May this linked camera be woken on an unknown state?" — only when it SLEEPS
 * (`DeviceFeature.Sleeps`, derived from its `low-power-sleep` binding, #459 Q2).
 * A device that merely reports a battery is never woken here.
 *
 * `undefined` when the registry does not know the device: unknown is not a
 * sleeper (D49). A failed read throws, and the shelf reads a throw as no.
 */
export function sleepingCameraProbe(
  deviceManager: SleepingCameraProbeClient,
): (deviceId: number) => Promise<boolean | undefined> {
  return async (deviceId) => {
    const device = await deviceManager.getDevice.query({ deviceId })
    if (!device) return undefined
    return deviceSleeps(device.features)
  }
}
