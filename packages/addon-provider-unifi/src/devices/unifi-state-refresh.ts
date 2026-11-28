/**
 * UniFi's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * One list answers the whole controller (`batch: true`). With the event stream
 * down the controller is polled at the connection's `pollIntervalMs`
 * (`push: 'none'`); with it up the tables arrive by push and the read is only a
 * reconcile at `UNIFI_RECONCILE_POLL_MS` (`push: 'partial'`). The stream going up
 * or down fans a snapshot out, and the cap is registered again with the new
 * policy.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@dominevo/types'
import { unifiControllers } from '../unifi-node-resolver.js'

/** The fastest a controller is read: the connection form's lower bound. */
export const UNIFI_MIN_REFRESH_INTERVAL_MS = 2_000

/** The part of a device context the refresh registration uses. */
export type UnifiRefreshContext = Pick<DeviceContext, 'registerNativeCap' | 'unregisterNativeCap'>

export interface UnifiStateRefreshTarget {
  readonly ctx: UnifiRefreshContext
  readonly deviceId: number
  readonly integrationId: string
}

interface UnifiCadence {
  readonly intervalMs: number
  readonly streamUp: boolean
}

export function unifiRefreshPolicy(
  integrationId: string,
  cadence: UnifiCadence | undefined,
): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: UNIFI_MIN_REFRESH_INTERVAL_MS,
    ...(cadence !== undefined ? { intervalMs: cadence.intervalMs } : {}),
    batch: true,
    push: cadence?.streamUp === true ? 'partial' : 'none',
  }
}

const cadenceOf = (integrationId: string): UnifiCadence | undefined => {
  const manager = unifiControllers.getManager(integrationId)
  return manager === null
    ? undefined
    : { intervalMs: manager.pollDelayMs(), streamUp: manager.streamUp }
}

const sameCadence = (a: UnifiCadence | undefined, b: UnifiCadence | undefined): boolean =>
  a?.intervalMs === b?.intervalMs && a?.streamUp === b?.streamUp

/** Register the device's refresh cap; returns the cleanup. */
export function registerUnifiStateRefresh(target: UnifiStateRefreshTarget): () => void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      const manager = unifiControllers.getManager(target.integrationId)
      if (manager === null) {
        throw new Error(`unifi: integration ${target.integrationId} is not available — no refresh`)
      }
      await manager.poll()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  let registered = cadenceOf(target.integrationId)
  const register = (): void => {
    target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
      stateRefresh: unifiRefreshPolicy(target.integrationId, registered),
    })
  }
  register()
  return unifiControllers.onSnapshot(target.integrationId, () => {
    const now = cadenceOf(target.integrationId)
    const unregister = target.ctx.unregisterNativeCap
    if (now === undefined || sameCadence(now, registered) || unregister === undefined) return
    registered = now
    unregister.call(target.ctx, deviceStateRefreshCapability.name)
    register()
  })
}
