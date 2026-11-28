/**
 * ESPHome's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * A board streams every entity state over its native API connection and the
 * link keeps the last value of each (`push: 'full'`), so the core never
 * schedules a read. The `refresh` it can ask for is NOT an upstream read: the
 * board has no query, so it re-applies the link's last reported states to the
 * device's slices. A board that is not connected refuses by name.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@dominevo/types'

/** Never scheduled (push full); only the floor the core accepts. */
export const ESPHOME_MIN_REFRESH_INTERVAL_MS = 1_000

/** The part of a device context the refresh registration uses. */
export type EspRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface EspStateRefreshTarget {
  readonly ctx: EspRefreshContext
  /** The board (broker) id, the integration the core groups the device under. */
  readonly brokerId: string
  /** Re-apply the link's last reported states; throws when the board is not connected. */
  readonly replayLink: () => void
}

export function espRefreshPolicy(brokerId: string): StateRefreshPolicy {
  return {
    integrationId: brokerId,
    minIntervalMs: ESPHOME_MIN_REFRESH_INTERVAL_MS,
    batch: false,
    push: 'full',
  }
}

export function registerEspStateRefresh(target: EspStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      target.replayLink()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: espRefreshPolicy(target.brokerId),
  })
}
