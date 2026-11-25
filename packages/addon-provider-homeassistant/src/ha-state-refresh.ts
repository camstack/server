/**
 * Home Assistant's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * Every entity state arrives over the websocket (`push: 'full'`), so the core
 * never schedules a read. The read it can ask for is the one after a command
 * that was not confirmed by a push: it re-applies the broker's cached state of
 * the entity (no upstream round-trip — the cache is what the push folds into).
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@camstack/types'

/** Never scheduled (push full); only the floor the core accepts. */
export const HA_MIN_REFRESH_INTERVAL_MS = 1_000

/** The part of a device context the refresh registration uses. */
export type HaRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface HaStateRefreshTarget {
  readonly ctx: HaRefreshContext
  /**
   * The integration instance the device belongs to (`meta.integrationId`, e.g.
   * `int_0019`) — the SAME key the device-manager's readiness gate groups the
   * device's status writes under (D1099). The broker id is only the fallback of
   * a legacy row that carries none.
   */
  readonly integrationId: string
  /** Re-apply the broker's cached state of this device's entity. */
  readonly reapplyCachedState: () => Promise<void>
}

export function haRefreshPolicy(integrationId: string): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: HA_MIN_REFRESH_INTERVAL_MS,
    batch: false,
    push: 'full',
  }
}

export function registerHaStateRefresh(target: HaStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      await target.reapplyCachedState()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: haRefreshPolicy(target.integrationId),
  })
}
