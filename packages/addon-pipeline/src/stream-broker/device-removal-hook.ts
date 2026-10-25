/**
 * The stream-broker's `device-removal-hook` (D870).
 *
 * What the broker keeps PER CAMERA is a key of the camera's own settings
 * (`probeSnapshots`, `brokerProfile`, `rtspTokens` - see `broker-device-state.ts`),
 * and the central device delete (D865) clears those for every addon. What is
 * left is the broker's live state and its one addon-level map keyed by camera,
 * `deviceOverrides`: the hook retracts the camera's streams, purges its slot
 * assignments and drops its override entry. Idempotent - a camera with nothing
 * left answers zero counts.
 */
import {
  errMsg,
  type DeviceDataEntry,
  type DeviceRemovedInput,
  type DeviceRemovedResult,
  type IDeviceRemovalHookProvider,
  type IScopedLogger,
} from '@camstack/types'

export interface BrokerRemovalHookDeps {
  readonly logger: IScopedLogger
  /** Retract every stream and purge the slot assignments (the permanent-removal treatment). */
  readonly retractDevice: (deviceId: number) => Promise<void>
  /** Drop the camera's `deviceOverrides` entry; true when there was one. */
  readonly dropDeviceOverride: (deviceId: number) => boolean
  /** Cameras that still have a `deviceOverrides` entry. */
  readonly overrideDeviceIds: () => readonly number[]
}

export function createBrokerRemovalHook(deps: BrokerRemovalHookDeps): IDeviceRemovalHookProvider {
  return {
    onDeviceRemoved: async (input: DeviceRemovedInput): Promise<DeviceRemovedResult> => {
      const { deviceId } = input
      try {
        await deps.retractDevice(deviceId)
      } catch (err: unknown) {
        // A retract that failed must be retried by the caller: say so by throwing.
        deps.logger.warn('stream-broker: retract of a deleted device failed', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
        throw err
      }
      const overrides = deps.dropDeviceOverride(deviceId) ? 1 : 0
      if (overrides > 0) {
        deps.logger.info('stream-broker: removed the override of a deleted device', {
          tags: { deviceId },
          meta: { deletedAt: input.deletedAt },
        })
      }
      return { counts: { 'device-overrides': overrides } }
    },
    listDeviceData: async (): Promise<readonly DeviceDataEntry[]> =>
      deps
        .overrideDeviceIds()
        .filter((deviceId) => Number.isInteger(deviceId) && deviceId > 0)
        .map((deviceId) => ({ store: 'device-overrides', deviceId, count: 1 })),
  }
}
