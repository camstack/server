/**
 * Ecowitt's side of the core state refresh (D1062): HOW to read a gateway, never WHEN.
 *
 * The `local` transport has no push — the gateway is polled — so the core owns that cadence
 * and calls `Ecowitt.refresh()` (one live-data read, plus the sensor map once it is older
 * than `mappingIntervalMs`). The library arms no timer of its own (`pollIntervalMs: 0`).
 * The `listener` transport is pushed to the hub; a refresh there is a no-op in the library.
 *
 * One schedule per gateway (`batch`), however many devices the gateway has; the operator's
 * poll interval only SLOWS the core's floor.
 */
import {
  type DeviceContext,
  deviceStateRefreshCapability,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@camstack/types'
import type { EcowittConfig } from './config.js'
import type { EcowittFacadeResolver } from './ecowitt-gateway.js'

/** The core's own floor for this provider; the operator's poll interval rides on top. */
export const ECOWITT_MIN_REFRESH_INTERVAL_MS = 1_000

export function ecowittRefreshPolicy(
  integrationId: string,
  connection: EcowittConfig | null,
): StateRefreshPolicy {
  const operatorMs = connection?.transport === 'local' ? connection.pollIntervalMs : undefined
  return {
    integrationId,
    minIntervalMs: ECOWITT_MIN_REFRESH_INTERVAL_MS,
    ...(operatorMs !== undefined ? { intervalMs: operatorMs } : {}),
    batch: true,
    push: 'none',
  }
}

export interface EcowittStateRefreshTarget {
  readonly ctx: Pick<DeviceContext, 'registerNativeCap'>
  readonly integrationId: string
  readonly gatewayId: string
  readonly facades: Pick<EcowittFacadeResolver, 'get'>
  readonly connection: EcowittConfig | null
}

export function registerEcowittStateRefresh(target: EcowittStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      const facade = target.facades.get(target.gatewayId)
      if (facade === null) throw new Error(`ecowitt: gateway ${target.gatewayId} is not connected`)
      await facade.refresh()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: ecowittRefreshPolicy(target.integrationId, target.connection),
  })
}
