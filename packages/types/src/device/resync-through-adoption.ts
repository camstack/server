import type { AddonApi } from '../generated/addon-api.js'
import type { resyncCapability } from '../capabilities/resync.cap.js'
import type { InferNativeProvider } from '../capabilities/capability-definition.js'

/** The one deviceManager method a `resync` provider needs. */
export type AdoptionResyncClient = Pick<AddonApi['deviceManager'], 'adoptionResync'>

/**
 * The `resync` provider of an adopted container (#459, Q6): the work is the
 * owning addon's `device-adoption.resync`, reached through
 * `deviceManager.adoptionResync`, which also owns the "resync from zero" child
 * purge. Registering this is what makes `DeviceFeature.Resyncable` true.
 */
export function resyncThroughAdoption(
  deviceManager: AdoptionResyncClient,
  ownDeviceId: number,
): InferNativeProvider<typeof resyncCapability> {
  return {
    resync: async ({ deviceId, resetToSource }) => {
      if (deviceId !== ownDeviceId) {
        throw new Error(`resync: deviceId mismatch, expected ${ownDeviceId}, got ${deviceId}`)
      }
      return deviceManager.adoptionResync.mutate({
        camDeviceId: deviceId,
        ...(resetToSource !== undefined ? { resetToSource } : {}),
      })
    },
  }
}
