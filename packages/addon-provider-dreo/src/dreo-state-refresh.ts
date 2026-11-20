/**
 * Dreo's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * Every device state arrives over the account's WebSocket (`push: 'full'`), so
 * the core never schedules a read. The read it can ask for is the one after a
 * command no push confirmed: it re-applies the live handle's state to the
 * device's slices. The library offers no upstream read of a device it already
 * holds, so the handle's cache (what the push folds into) is what is served.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@camstack/types'

/** Never scheduled (push full); only the floor the core accepts. */
export const DREO_MIN_REFRESH_INTERVAL_MS = 1_000

/** The part of a device context the refresh registration uses. */
export type DreoRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface DreoStateRefreshTarget {
  readonly ctx: DreoRefreshContext
  /** The integration (account) id. */
  readonly integrationId: string
  /** Re-apply the live handle's state to the device's slices; throws when there is no connection. */
  readonly reapplyHandleState: () => void
}

export function dreoRefreshPolicy(integrationId: string): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: DREO_MIN_REFRESH_INTERVAL_MS,
    batch: false,
    push: 'full',
  }
}

export function registerDreoStateRefresh(target: DreoStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      target.reapplyHandleState()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: dreoRefreshPolicy(target.integrationId),
  })
}
