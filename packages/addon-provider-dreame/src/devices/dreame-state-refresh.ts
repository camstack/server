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
} from '@camstack/types'

/** The part of a device context the refresh registration uses. */
export type DreameRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface DreameStateRefreshTarget {
  readonly ctx: DreameRefreshContext
  readonly brokerId: string
  /** The fastest cadence any source of this device needs. */
  readonly minIntervalMs: number
  /** Read every source that is due; throws when a read was refused. */
  readonly read: () => Promise<void>
}

export function dreameRefreshPolicy(brokerId: string, minIntervalMs: number): StateRefreshPolicy {
  return { integrationId: brokerId, minIntervalMs, batch: false, push: 'partial' }
}

export function registerDreameStateRefresh(target: DreameStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      await target.read()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: dreameRefreshPolicy(target.brokerId, target.minIntervalMs),
  })
}

/** True when a source last read at `lastAt` (0 = never) is older than `everyMs`. */
export function isDue(lastAt: number, everyMs: number, now: number): boolean {
  return now - lastAt >= everyMs
}
