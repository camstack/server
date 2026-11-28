/**
 * Unraid's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * The server is read through its GraphQL API on request (it also offers live
 * subscriptions, which this provider does not use), so it is polled
 * (`push: 'none'`); one snapshot answers every device of the instance
 * (`batch: true`). The server (host) device and the UPS devices register
 * `device-state-refresh`. The cadence is the connection's `pollIntervalMs`, and
 * the cap is registered again when it changes.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@dominevo/types'
import { unraidInstances } from '../unraid-node-resolver.js'

/** The fastest an Unraid server is read: the connection form's lower bound. */
export const UNRAID_MIN_REFRESH_INTERVAL_MS = 2_000

/** The part of a device context the refresh registration uses. */
export type UnraidRefreshContext = Pick<DeviceContext, 'registerNativeCap' | 'unregisterNativeCap'>

export interface UnraidStateRefreshTarget {
  readonly ctx: UnraidRefreshContext
  readonly deviceId: number
  readonly integrationId: string
}

export function unraidRefreshPolicy(
  integrationId: string,
  pollIntervalMs: number | undefined,
): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: UNRAID_MIN_REFRESH_INTERVAL_MS,
    ...(pollIntervalMs !== undefined ? { intervalMs: pollIntervalMs } : {}),
    batch: true,
    push: 'none',
  }
}

/** Register the device's refresh cap; returns the cleanup. */
export function registerUnraidStateRefresh(target: UnraidStateRefreshTarget): () => void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      const manager = unraidInstances.getManager(target.integrationId)
      if (manager === null) {
        throw new Error(`unraid: integration ${target.integrationId} is not available — no refresh`)
      }
      await manager.poll()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  const intervalOf = (): number | undefined =>
    unraidInstances.getManager(target.integrationId)?.getConnection().pollIntervalMs
  let registeredInterval = intervalOf()
  const register = (): void => {
    target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
      stateRefresh: unraidRefreshPolicy(target.integrationId, registeredInterval),
    })
  }
  register()
  return unraidInstances.onSnapshot(target.integrationId, () => {
    const now = intervalOf()
    const unregister = target.ctx.unregisterNativeCap
    if (now === undefined || now === registeredInterval || unregister === undefined) return
    registeredInterval = now
    unregister.call(target.ctx, deviceStateRefreshCapability.name)
    register()
  })
}
