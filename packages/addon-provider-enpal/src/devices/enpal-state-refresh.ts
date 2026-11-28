/**
 * Enpal's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * The box is polled (`push: 'none'`) and one read answers every device of the
 * integration (`batch: true`), so the box-level devices (gateway, equipment,
 * energy system) register `device-state-refresh` and the hub's scheduler calls
 * `refresh` on its cadence. The cadence is the connection's poll interval, with
 * the box-web-channel read time as a floor (`effectivePollIntervalMs`). When the
 * connection changes the cap is registered again with the new interval.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@dominevo/types'
import { effectivePollIntervalMs } from '../enpal-blazor.js'
import { enpalConnections } from '../enpal-resolver.js'

/** The fastest a box is read: the connection form's lower bound for the poll interval. */
export const ENPAL_MIN_REFRESH_INTERVAL_MS = 10_000

/** The part of a device context the refresh registration uses. */
export type EnpalRefreshContext = Pick<DeviceContext, 'registerNativeCap' | 'unregisterNativeCap'>

export interface EnpalStateRefreshTarget {
  readonly ctx: EnpalRefreshContext
  readonly deviceId: number
  readonly integrationId: string
}

/** The policy for a box read every `intervalMs` (unknown: the minimum). */
export function enpalRefreshPolicy(
  integrationId: string,
  intervalMs: number | undefined,
): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: ENPAL_MIN_REFRESH_INTERVAL_MS,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    batch: true,
    push: 'none',
  }
}

const intervalOf = (integrationId: string): number | undefined => {
  const connection = enpalConnections.getManager(integrationId)?.connection
  return connection === undefined ? undefined : effectivePollIntervalMs(connection)
}

/** Register the device's refresh cap; returns the cleanup. */
export function registerEnpalStateRefresh(target: EnpalStateRefreshTarget): () => void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      const manager = enpalConnections.getManager(target.integrationId)
      if (manager === null) {
        throw new Error(`enpal: integration ${target.integrationId} is not running — no refresh`)
      }
      await manager.poll()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  let registeredInterval = intervalOf(target.integrationId)
  const register = (): void => {
    target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
      stateRefresh: enpalRefreshPolicy(target.integrationId, registeredInterval),
    })
  }
  register()
  return enpalConnections.onSnapshot(target.integrationId, () => {
    const now = intervalOf(target.integrationId)
    const unregister = target.ctx.unregisterNativeCap
    if (now === undefined || now === registeredInterval || unregister === undefined) return
    registeredInterval = now
    unregister.call(target.ctx, deviceStateRefreshCapability.name)
    register()
  })
}
