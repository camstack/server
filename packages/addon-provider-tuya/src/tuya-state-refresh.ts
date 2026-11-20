/**
 * Tuya's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * A device holds one LAN connection and every datapoint change reaches it as a
 * `dps` push (`push: 'full'`), so the core never schedules a read. The read it
 * can ask for is the one after a command no push confirmed: a `get` on the
 * live client, which the owner then folds into its slices and fans out to its
 * accessory children.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@camstack/types'

/** Never scheduled (push full); only the floor the core accepts. */
export const TUYA_MIN_REFRESH_INTERVAL_MS = 1_000

/** The part of a device context the refresh registration uses. */
export type TuyaRefreshContext = Pick<DeviceContext, 'registerNativeCap' | 'unregisterNativeCap'>

/**
 * One counter per account. The core compares an account's epoch against the
 * highest it saw, so every device of the account draws its bump from the same
 * counter: a reconnect of ANY device then reads the whole account.
 */
const epochs = new Map<string, number>()

function currentEpoch(integrationId: string): number {
  return epochs.get(integrationId) ?? 0
}

function nextEpoch(integrationId: string): number {
  const next = currentEpoch(integrationId) + 1
  epochs.set(integrationId, next)
  return next
}

export interface TuyaStateRefreshTarget {
  readonly ctx: TuyaRefreshContext
  readonly integrationId: string
  /** Query the device over the live client and fold the answer in; throws when there is no client. */
  readonly readDevice: () => Promise<void>
}

export function tuyaRefreshPolicy(integrationId: string, connectionEpoch = 0): StateRefreshPolicy {
  return {
    integrationId,
    connectionEpoch,
    minIntervalMs: TUYA_MIN_REFRESH_INTERVAL_MS,
    batch: false,
    push: 'full',
  }
}

/**
 * Register the device's refresh cap. The returned function is to be called when
 * the LAN client reconnected on its own: it publishes a higher connection epoch
 * so the core reads the account again (pushes lost while it was down).
 */
export function registerTuyaStateRefresh(target: TuyaStateRefreshTarget): () => void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      await target.readDevice()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  const register = (epoch: number): void => {
    target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
      stateRefresh: tuyaRefreshPolicy(target.integrationId, epoch),
    })
  }
  register(currentEpoch(target.integrationId))
  return () => {
    const unregister = target.ctx.unregisterNativeCap
    if (unregister === undefined) return
    unregister.call(target.ctx, deviceStateRefreshCapability.name)
    register(nextEpoch(target.integrationId))
  }
}
