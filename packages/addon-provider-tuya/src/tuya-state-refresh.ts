/**
 * Tuya's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * A device holds one LAN connection and every datapoint change reaches it as a
 * `dps` push (`push: 'full'`), so the core never schedules a read. The read it
 * can ask for is the one after a command no push confirmed: a `get` on the
 * live client, which the owner then folds into its slices and fans out to its
 * accessory children.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@camstack/types'

/** Never scheduled (push full); only the floor the core accepts. */
export const TUYA_MIN_REFRESH_INTERVAL_MS = 1_000

/** The part of a device context the refresh registration uses. */
export type TuyaRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface TuyaStateRefreshTarget {
  readonly ctx: TuyaRefreshContext
  readonly integrationId: string
  /** Query the device over the live client and fold the answer in; throws when there is no client. */
  readonly readDevice: () => Promise<void>
}

export function tuyaRefreshPolicy(integrationId: string): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: TUYA_MIN_REFRESH_INTERVAL_MS,
    batch: false,
    push: 'full',
  }
}

export function registerTuyaStateRefresh(target: TuyaStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      await target.readDevice()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: tuyaRefreshPolicy(target.integrationId),
  })
}
