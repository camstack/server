/**
 * VeSync's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * Each VeSync device that drives a cid (purifier, humidifier, their toggles)
 * registers `device-state-refresh` with the account's policy: polled
 * (`push: 'none'`), read in batch (one device list answers the whole account),
 * no faster than {@link VESYNC_MIN_REFRESH_INTERVAL_MS}, slowed by the
 * integration's `pollIntervalMs`. The hub's scheduler calls `refresh` on its
 * cadence and after every command; the account manager does the read.
 *
 * When the integration's `pollIntervalMs` changes the cap is registered again
 * with the new policy (checked on every snapshot fan-out). VeSync has no push
 * subscription, so `resubscribe` has nothing to do.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@camstack/types'
import { vesyncAccounts } from '../vesync-account-resolver.js'
import type { VeSyncRefreshTarget } from '../vesync-integration-manager.js'

/** The fastest the core may re-read a VeSync account (the cloud rate-limits). */
export const VESYNC_MIN_REFRESH_INTERVAL_MS = 15_000

/** Every registered device's cid, so a batch read can name the cid of each device asked for. */
const cidOfDevice = new Map<number, VeSyncRefreshTarget>()

/** The policy a VeSync device declares for an integration polled every `pollIntervalMs` (unknown: the minimum). */
export function vesyncRefreshPolicy(
  integrationId: string,
  pollIntervalMs: number | undefined,
): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: VESYNC_MIN_REFRESH_INTERVAL_MS,
    ...(pollIntervalMs !== undefined ? { intervalMs: pollIntervalMs } : {}),
    batch: true,
    push: 'none',
  }
}

/** The part of a device context the refresh registration uses. */
export type VeSyncRefreshContext = Pick<DeviceContext, 'registerNativeCap' | 'unregisterNativeCap'>

export interface VeSyncStateRefreshTarget {
  readonly ctx: VeSyncRefreshContext
  readonly deviceId: number
  readonly integrationId: string
  /** The cid this device reads (a child reads its parent's). */
  readonly nativeId: string
}

/** Register the device's refresh cap; returns the cleanup (stops re-registering, forgets the cid). */
export function registerVeSyncStateRefresh(target: VeSyncStateRefreshTarget): () => void {
  const own: VeSyncRefreshTarget = { nativeId: target.nativeId, deviceId: target.deviceId }
  cidOfDevice.set(target.deviceId, own)
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async ({ deviceIds, reason }) => {
      const manager = vesyncAccounts.getManager(target.integrationId)
      if (manager === null) {
        throw new Error(`vesync: integration ${target.integrationId} is not available — no refresh`)
      }
      const targets = deviceIds.map((id) => cidOfDevice.get(id) ?? own)
      await manager.refresh(reason, targets)
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  const pollIntervalOf = (): number | undefined =>
    vesyncAccounts.getManager(target.integrationId)?.getConnection().pollIntervalMs
  let registeredInterval = pollIntervalOf()
  const register = (): void => {
    target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
      stateRefresh: vesyncRefreshPolicy(target.integrationId, registeredInterval),
    })
  }
  register()
  const unsubscribe = vesyncAccounts.onSnapshot(target.integrationId, () => {
    const now = pollIntervalOf()
    const unregister = target.ctx.unregisterNativeCap
    if (now === undefined || now === registeredInterval || unregister === undefined) return
    registeredInterval = now
    unregister.call(target.ctx, deviceStateRefreshCapability.name)
    register()
  })
  return () => {
    unsubscribe()
    cidOfDevice.delete(target.deviceId)
  }
}
