/**
 * PetKit's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * PetKit's REST API has no usable push channel, so every feeder is polled
 * (`push: 'none'`) with one cloud call per device (no batch). The core reads at
 * {@link PETKIT_MIN_REFRESH_INTERVAL_MS}, slowed by the integration's
 * `pollIntervalMs`, and once more after each command.
 *
 * When the integration's `pollIntervalMs` changes the cap is registered again
 * with the new policy (checked on every surface publish).
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@dominevo/types'

/** The fastest cadence the core reads a feeder at (the old idle cadence; a 429 must not be hammered). */
export const PETKIT_MIN_REFRESH_INTERVAL_MS = 30_000

/** The part of a device context the refresh registration uses. */
export type PetkitRefreshContext = Pick<DeviceContext, 'registerNativeCap' | 'unregisterNativeCap'>

export interface PetkitStateRefreshTarget {
  readonly ctx: PetkitRefreshContext
  readonly integrationId: string
  /** The integration's current `pollIntervalMs` (0 or unknown: no slowing). */
  readonly intervalOf: () => number | undefined
  /** Poll the cloud once and fold the answer in; throws when it cannot. */
  readonly readDevice: () => Promise<void>
}

/** The policy for an integration polled every `pollIntervalMs` (0 or unknown: the minimum). */
export function petkitRefreshPolicy(
  integrationId: string,
  pollIntervalMs: number | undefined,
): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: PETKIT_MIN_REFRESH_INTERVAL_MS,
    ...(pollIntervalMs !== undefined && pollIntervalMs > 0 ? { intervalMs: pollIntervalMs } : {}),
    batch: false,
    push: 'none',
  }
}

/** Register the device's refresh cap; `onSurface` is the hook to call when the surface is republished. */
export function registerPetkitStateRefresh(target: PetkitStateRefreshTarget): () => void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      await target.readDevice()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  let registeredInterval = target.intervalOf()
  const register = (): void => {
    target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
      stateRefresh: petkitRefreshPolicy(target.integrationId, registeredInterval),
    })
  }
  register()
  return () => {
    const now = target.intervalOf()
    const unregister = target.ctx.unregisterNativeCap
    if (now === registeredInterval || unregister === undefined) return
    registeredInterval = now
    unregister.call(target.ctx, deviceStateRefreshCapability.name)
    register()
  }
}
