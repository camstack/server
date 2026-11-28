/**
 * HomeCom's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * One `fetchSystem` answers the whole gateway (`batch: true`), polled
 * (`push: 'none'`), no faster than {@link HOMECOM_MIN_REFRESH_INTERVAL_MS}. A
 * device registers `device-state-refresh`, and follows the new snapshot the read
 * produced, so every device of the gateway is current after one read.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@dominevo/types'
import { homeComConnections } from '../homecom-gateway.js'

/** The cadence the integration's own timer ran at before the core took over. */
export const HOMECOM_MIN_REFRESH_INTERVAL_MS = 60_000

/** The part of a device context the refresh registration uses. */
export type HomeComRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface HomeComStateRefreshTarget {
  readonly ctx: HomeComRefreshContext
  readonly integrationId: string
  /** Re-derive the device's slice from the snapshot the read just stored. */
  readonly onSnapshot: () => void
}

export function homeComRefreshPolicy(integrationId: string): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: HOMECOM_MIN_REFRESH_INTERVAL_MS,
    batch: true,
    push: 'none',
  }
}

/** Register the device's refresh cap; returns the cleanup of its snapshot subscription. */
export function registerHomeComStateRefresh(target: HomeComStateRefreshTarget): () => void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      const refresh = homeComConnections.getRefresh(target.integrationId)
      if (refresh === null) {
        throw new Error(
          `homecom: integration ${target.integrationId} is not connected — no refresh`,
        )
      }
      await refresh()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: homeComRefreshPolicy(target.integrationId),
  })
  return homeComConnections.onSnapshot(target.integrationId, target.onSnapshot)
}
