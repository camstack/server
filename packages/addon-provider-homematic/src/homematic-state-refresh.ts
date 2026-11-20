/**
 * Homematic's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * The CCU pushes every radio device event over the XML-RPC callback, so those
 * devices are never read on a clock. The one thing it does NOT push is its own
 * WatchDog system variables (the gateway's `error` cap): they are a snapshot the
 * gateway has to read, so the gateway registers `device-state-refresh` with
 * `push: 'none'` and the core reads it at {@link HOMEMATIC_GATEWAY_REFRESH_MS}.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@camstack/types'

/** How often the core reads the CCU's WatchDog system variables. */
export const HOMEMATIC_GATEWAY_REFRESH_MS = 30_000

/** The part of a device context the refresh registration uses. */
export type HomematicRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface HomematicStateRefreshTarget {
  readonly ctx: HomematicRefreshContext
  readonly integrationId: string
  /** Read the system variables and publish the faults; throws when it cannot. */
  readonly readFaults: () => Promise<void>
}

export function homematicGatewayRefreshPolicy(integrationId: string): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: HOMEMATIC_GATEWAY_REFRESH_MS,
    batch: false,
    push: 'none',
  }
}

export function registerHomematicStateRefresh(target: HomematicStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      await target.readFaults()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: homematicGatewayRefreshPolicy(target.integrationId),
  })
}
