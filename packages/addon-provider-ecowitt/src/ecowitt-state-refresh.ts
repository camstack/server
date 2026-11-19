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
  type IScopedLogger,
  type StateRefreshPolicy,
} from '@camstack/types'
import type { EcowittConfig } from './config.js'
import type { EcowittFacadeResolver } from './ecowitt-gateway.js'

/** The core's own floor for this provider; the operator's poll interval rides on top. */
export const ECOWITT_MIN_REFRESH_INTERVAL_MS = 1_000

/** The library's own live-data interval: the cadence when no connection is known (yet). */
export const ECOWITT_DEFAULT_POLL_INTERVAL_MS = 60_000

/** The policy for a gateway; an unknown connection reads at the library default, never at the floor. */
export function ecowittRefreshPolicy(
  integrationId: string,
  connection: EcowittConfig | null,
): StateRefreshPolicy {
  const operatorMs =
    connection === null
      ? ECOWITT_DEFAULT_POLL_INTERVAL_MS
      : connection.transport === 'local'
        ? connection.pollIntervalMs
        : undefined
  return {
    integrationId,
    minIntervalMs: ECOWITT_MIN_REFRESH_INTERVAL_MS,
    ...(operatorMs !== undefined ? { intervalMs: operatorMs } : {}),
    batch: true,
    push: 'none',
  }
}

/** Where the integration's running connection is read, and when it changes. */
export interface EcowittConnectionSource {
  get(integrationId: string): EcowittConfig | null
  onChange(integrationId: string, cb: () => void): () => void
}

export interface EcowittStateRefreshTarget {
  readonly ctx: Pick<DeviceContext, 'registerNativeCap' | 'unregisterNativeCap'>
  readonly logger: Pick<IScopedLogger, 'info'>
  readonly deviceId: number
  readonly integrationId: string
  readonly gatewayId: string
  readonly facades: Pick<EcowittFacadeResolver, 'get'>
  readonly connections: EcowittConnectionSource
}

/**
 * Register the gateway refresh. The policy is static per registration, so it is registered
 * again when the integration's connection changes (a new poll interval, a rebuilt client).
 * Returns the cleanup.
 */
export function registerEcowittStateRefresh(target: EcowittStateRefreshTarget): () => void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      const facade = target.facades.get(target.gatewayId)
      if (facade === null) throw new Error(`ecowitt: gateway ${target.gatewayId} is not connected`)
      await facade.refresh()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  let registered: StateRefreshPolicy | null = null
  const register = (): void => {
    const connection = target.connections.get(target.integrationId)
    const policy = ecowittRefreshPolicy(target.integrationId, connection)
    if (connection === null) {
      target.logger.info(
        'ecowitt: no connection known, refreshing at the library default interval',
        {
          tags: { deviceId: target.deviceId },
          meta: { intervalMs: ECOWITT_DEFAULT_POLL_INTERVAL_MS },
        },
      )
    }
    if (registered !== null && registered.intervalMs === policy.intervalMs) return
    if (registered !== null) target.ctx.unregisterNativeCap?.(deviceStateRefreshCapability.name)
    registered = policy
    target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, { stateRefresh: policy })
  }
  register()
  return target.connections.onChange(target.integrationId, register)
}
