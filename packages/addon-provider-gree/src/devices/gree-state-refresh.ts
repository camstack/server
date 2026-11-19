/**
 * Gree's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * Every AC is its own LAN conversation, so it is read on its own
 * (`batch: false`), polled (`push: 'none'`), no faster than
 * {@link GREE_MIN_REFRESH_INTERVAL_MS}. The AC device registers
 * `device-state-refresh`; the read goes through the connection manager, which
 * reads the state and the extra columns and counts a dead AC toward re-binding.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@camstack/types'
import { greeConnections } from '../gree-gateway.js'

/** The cadence the library's own poll ran at before the core took over. */
export const GREE_MIN_REFRESH_INTERVAL_MS = 10_000

/** The part of a device context the refresh registration uses. */
export type GreeRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface GreeStateRefreshTarget {
  readonly ctx: GreeRefreshContext
  readonly connectionKey: string
  readonly mac: string
}

export function greeRefreshPolicy(connectionKey: string): StateRefreshPolicy {
  return {
    integrationId: connectionKey,
    minIntervalMs: GREE_MIN_REFRESH_INTERVAL_MS,
    batch: false,
    push: 'none',
  }
}

export function registerGreeStateRefresh(target: GreeStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      const refresh = greeConnections.getRefresh(target.connectionKey)
      if (refresh === null) {
        throw new Error(`gree: connection ${target.connectionKey} is not bound — no refresh`)
      }
      await refresh(target.mac)
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: greeRefreshPolicy(target.connectionKey),
  })
}
