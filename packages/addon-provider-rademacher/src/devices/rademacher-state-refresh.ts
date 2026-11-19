/**
 * HomePilot's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * The hub has no push channel, so it is polled (`push: 'none'`); one read of the
 * hub answers every cover (`batch: true`). The gateway and every cover register
 * `device-state-refresh`: a scheduled tick polls the whole hub, a command or
 * burst read polls only the covers named. The cadence is the connection's
 * `pollIntervalMs` (the form's floor is {@link RADEMACHER_MIN_REFRESH_INTERVAL_MS});
 * when it changes the cap is registered again with the new interval.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@camstack/types'
import { rademacherSessions } from '../rademacher-session-resolver.js'

/** The fastest a HomePilot hub is read: the connection form's lower bound. */
export const RADEMACHER_MIN_REFRESH_INTERVAL_MS = 2_000

/** Every registered cover's did by device id, so a command read can name the cover it is for. */
const didOfDevice = new Map<number, string>()

/** The part of a device context the refresh registration uses. */
export type RademacherRefreshContext = Pick<
  DeviceContext,
  'registerNativeCap' | 'unregisterNativeCap'
>

export interface RademacherStateRefreshTarget {
  readonly ctx: RademacherRefreshContext
  readonly deviceId: number
  readonly integrationId: string
  /** The cover's HomePilot did; absent for the gateway. */
  readonly did?: string
}

export function rademacherRefreshPolicy(
  integrationId: string,
  pollIntervalMs: number | undefined,
): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: RADEMACHER_MIN_REFRESH_INTERVAL_MS,
    ...(pollIntervalMs !== undefined ? { intervalMs: pollIntervalMs } : {}),
    batch: true,
    push: 'none',
  }
}

/** Register the device's refresh cap; returns the cleanup. */
export function registerRademacherStateRefresh(target: RademacherStateRefreshTarget): () => void {
  if (target.did !== undefined) didOfDevice.set(target.deviceId, target.did)
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async ({ deviceIds, reason }) => {
      const manager = rademacherSessions.getManager(target.integrationId)
      if (manager === null) {
        throw new Error(
          `rademacher: integration ${target.integrationId} is not available — no refresh`,
        )
      }
      const dids = deviceIds.flatMap((id) => {
        const did = didOfDevice.get(id)
        return did === undefined ? [] : [did]
      })
      await manager.refresh(reason, dids)
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  const intervalOf = (): number | undefined =>
    rademacherSessions.getManager(target.integrationId)?.getConnection().pollIntervalMs
  let registeredInterval = intervalOf()
  const register = (): void => {
    target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
      stateRefresh: rademacherRefreshPolicy(target.integrationId, registeredInterval),
    })
  }
  register()
  const unsubscribe = rademacherSessions.onSnapshot(target.integrationId, () => {
    const now = intervalOf()
    const unregister = target.ctx.unregisterNativeCap
    if (now === undefined || now === registeredInterval || unregister === undefined) return
    registeredInterval = now
    unregister.call(target.ctx, deviceStateRefreshCapability.name)
    register()
  })
  return () => {
    unsubscribe()
    didOfDevice.delete(target.deviceId)
  }
}
