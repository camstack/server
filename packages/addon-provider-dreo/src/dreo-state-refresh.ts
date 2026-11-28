/**
 * Dreo's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * Every device state arrives over the account's WebSocket (`push: 'full'`), so the core never
 * schedules a read. The read it can ask for is the one after a command no push confirmed: a
 * real read of the account from the cloud through the Python worker (not a cache re-apply),
 * which the manager folds into the device handles.
 *
 * The library reconnects its WebSocket on its own and pushes sent while it was down are lost.
 * The worker reports the reconnect, and the function {@link registerDreoStateRefresh} returns
 * publishes a higher connection epoch so the core reads the account again.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@dominevo/types'

/** Never scheduled (push full); only the floor the core accepts. */
export const DREO_MIN_REFRESH_INTERVAL_MS = 1_000

/** The part of a device context the refresh registration uses. */
export type DreoRefreshContext = Pick<DeviceContext, 'registerNativeCap' | 'unregisterNativeCap'>

/**
 * One counter per account: the core compares an account's epoch with the highest it saw, so
 * every device of the account draws its bump from the same counter and a reconnect read once
 * covers the whole account.
 */
const epochs = new Map<string, number>()

function currentEpoch(integrationId: string): number {
  return epochs.get(integrationId) ?? 0
}

/**
 * The account came back: one bump per reconnect, taken by the manager before it tells the
 * devices, so every device of the account publishes the same new epoch.
 */
export function bumpDreoEpoch(integrationId: string): number {
  const next = currentEpoch(integrationId) + 1
  epochs.set(integrationId, next)
  return next
}

/** The account is gone for good: drop its counter (a re-added account starts clean). */
export function forgetDreoEpoch(integrationId: string): void {
  epochs.delete(integrationId)
}

export interface DreoStateRefreshTarget {
  readonly ctx: DreoRefreshContext
  /** The integration (account) id. */
  readonly integrationId: string
  /** Read the account from the cloud and fold it in; throws when there is no connection. */
  readonly readAccount: () => Promise<void>
}

export function dreoRefreshPolicy(integrationId: string, connectionEpoch = 0): StateRefreshPolicy {
  return {
    integrationId,
    connectionEpoch,
    minIntervalMs: DREO_MIN_REFRESH_INTERVAL_MS,
    batch: false,
    push: 'full',
  }
}

/**
 * Register the device's refresh cap. Call the returned function when the account's channel
 * came back (after {@link bumpDreoEpoch}): it re-registers the cap with the account's epoch.
 */
export function registerDreoStateRefresh(target: DreoStateRefreshTarget): () => void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      await target.readAccount()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  const register = (epoch: number): void => {
    target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
      stateRefresh: dreoRefreshPolicy(target.integrationId, epoch),
    })
  }
  register(currentEpoch(target.integrationId))
  return () => {
    const unregister = target.ctx.unregisterNativeCap
    if (unregister === undefined) return
    unregister.call(target.ctx, deviceStateRefreshCapability.name)
    register(currentEpoch(target.integrationId))
  }
}
