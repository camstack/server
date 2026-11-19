/**
 * Reolink's side of the core state refresh (D1062) for the cameras behind an NVR / Home Hub.
 *
 * The NVR reads its own cameras by itself and pushes their events, so the only scheduled work is
 * the regular reconcile of the children's sleep state, and it is answered by the NVR session
 * (`HubSessionHandle.refresh()`): the hub's channel summary and battery table. A refresh NEVER
 * dials or wakes a child camera. Push level is `partial` (events and awake/sleeping notices
 * arrive by push; the reconcile catches drift), one schedule per integration (`batch`).
 */
import {
  type DeviceContext,
  deviceStateRefreshCapability,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@camstack/types'
import { HUB_CHILD_SLEEP_RECONCILE_MS, type HubSessionHandle } from './reolink-hub-session.js'

export function hubChildRefreshPolicy(integrationId: string): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: HUB_CHILD_SLEEP_RECONCILE_MS,
    batch: true,
    push: 'partial',
  }
}

export interface HubChildStateRefreshTarget {
  readonly ctx: Pick<DeviceContext, 'registerNativeCap'>
  readonly integrationId: string
  /** The live NVR session, or null before it exists. */
  readonly session: () => Pick<HubSessionHandle, 'refresh'> | null
}

export function registerHubChildStateRefresh(target: HubChildStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      const session = target.session()
      if (session === null) {
        throw new Error(`reolink: no NVR session for integration ${target.integrationId}`)
      }
      await session.refresh()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: hubChildRefreshPolicy(target.integrationId),
  })
}
