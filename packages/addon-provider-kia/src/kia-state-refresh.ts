/**
 * Kia's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * The maker cloud has no push channel and a daily call quota of about two hundred, so the
 * schedule is slow (30 minutes) and the read it asks for is the cloud's CACHED state of the
 * account: it never wakes the car. A command's follow-up read and the burst after it
 * (`command`, `burst`) would each cost quota for nothing, so the manager answers them from
 * what it already holds. Waking the car is the operator's `vehicle.requestRefresh`.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
  type StateRefreshReason,
} from '@dominevo/types'

/** The cadence of the scheduled cached read: 48 calls a day out of about 200. */
export const KIA_REFRESH_INTERVAL_MS = 30 * 60_000

/** The part of a device context the refresh registration uses. */
export type KiaRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface KiaStateRefreshTarget {
  readonly ctx: KiaRefreshContext
  /** The integration (account) id. */
  readonly integrationId: string
  /** Read the account for the core; throws when there is no connection. */
  readonly readAccount: (reason: StateRefreshReason) => Promise<void>
}

export function kiaRefreshPolicy(integrationId: string): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: KIA_REFRESH_INTERVAL_MS,
    // One call reads every vehicle of the account.
    batch: true,
    push: 'none',
  }
}

/** Register the vehicle's refresh cap with the account's policy. */
export function registerKiaStateRefresh(target: KiaStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async ({ reason }) => {
      await target.readAccount(reason)
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: kiaRefreshPolicy(target.integrationId),
  })
}
