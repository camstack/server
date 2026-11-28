/**
 * Dreame's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * A robot's state arrives by MQTT push (`push: 'partial'`); the reads the push
 * does not carry — the tank status, the consumables, the Wi-Fi signal, a mower's
 * cloud shadow — used to run on timers inside the devices. The device now
 * registers `device-state-refresh` and answers each core read from
 * the sources that are DUE: a source keeps its own age (`isDue`), the core only
 * calls at its cadence, so a slow source is not read at the fast source's pace.
 */
import {
  type DeviceContext,
  deviceStateRefreshCapability,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@dominevo/types'

/** The part of a device context the refresh registration uses. */
export type DreameRefreshContext = Pick<DeviceContext, 'registerNativeCap' | 'unregisterNativeCap'>

/** The account's operator interval: its value and its changes. */
export interface DreamePollIntervals {
  pollIntervalOf(brokerId: string): number | undefined
  onPollInterval(brokerId: string, cb: () => void): () => void
}

export interface DreameStateRefreshTarget {
  readonly ctx: DreameRefreshContext
  readonly brokerId: string
  /** The fastest cadence any source of this device needs. */
  readonly minIntervalMs: number
  /** Where the account's `pollIntervalMs` comes from. */
  readonly intervals: DreamePollIntervals
  /** Read every source that is due; throws when a read was refused. */
  readonly read: () => Promise<void>
}

export function dreameRefreshPolicy(
  brokerId: string,
  minIntervalMs: number,
  intervalMs?: number,
): StateRefreshPolicy {
  return {
    integrationId: brokerId,
    minIntervalMs,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    batch: false,
    push: 'partial',
  }
}

/**
 * Register the refresh with the account's operator interval, and register again
 * when that interval changes (the policy is static per registration). Returns
 * the cleanup.
 */
export function registerDreameStateRefresh(target: DreameStateRefreshTarget): () => void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      await target.read()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  let registered = target.intervals.pollIntervalOf(target.brokerId)
  const register = (): void => {
    target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
      stateRefresh: dreameRefreshPolicy(target.brokerId, target.minIntervalMs, registered),
    })
  }
  register()
  return target.intervals.onPollInterval(target.brokerId, () => {
    const now = target.intervals.pollIntervalOf(target.brokerId)
    if (now === registered || target.ctx.unregisterNativeCap === undefined) return
    registered = now
    target.ctx.unregisterNativeCap(deviceStateRefreshCapability.name)
    register()
  })
}

/** True when a source last read at `lastAt` (0 = never) is older than `everyMs`. */
export function isDue(lastAt: number, everyMs: number, now: number): boolean {
  return now - lastAt >= everyMs
}
