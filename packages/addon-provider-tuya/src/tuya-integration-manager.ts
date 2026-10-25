import {
  type CloudDevice,
  type DiscoveredDevice,
  discoverDevices,
  TuyaCloud,
  TuyaCloudError,
} from '@apocaliss92/nodetuya'
import { errMsg, type IScopedLogger } from '@camstack/types'
import { settingsToTuyaConfig, toTuyaCloudOptions, type TuyaConfig } from './config.js'
import { type TuyaCatalogEntry, type TuyaConnectionResolver } from './tuya-gateway.js'

/** Status of a single Tuya cloud-account connection. */
export type TuyaConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Immutable snapshot returned by {@link TuyaIntegrationManager.getInfo}. */
export interface TuyaConnectionInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'tuya'
  readonly status: TuyaConnectionStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/**
 * Minimal cloud surface the manager needs from {@link TuyaCloud}. Both the real
 * class and test stubs satisfy this structurally — no cast required.
 */
export interface TuyaCloudLike {
  getDevices(): Promise<CloudDevice[]>
}

/** LAN discovery seam (tests inject a fake; default wraps the library sweep). */
export type TuyaDiscoverFn = (opts: { timeoutMs: number }) => Promise<DiscoveredDevice[]>

/** Factory seam: build a {@link TuyaCloudLike} from a config (tests inject a fake). */
export type TuyaCloudFactory = (config: TuyaConfig) => TuyaCloudLike

/** Constructor options for {@link TuyaIntegrationManager}. */
export interface TuyaIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: TuyaConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  readonly resolver: TuyaConnectionResolver
  /** Factory seam for testing. When omitted, builds a real {@link TuyaCloud}. */
  readonly makeCloud?: TuyaCloudFactory
  /** LAN discovery seam for testing. When omitted, uses the library sweep. */
  readonly discover?: TuyaDiscoverFn
}

function defaultCloud(config: TuyaConfig): TuyaCloudLike {
  return new TuyaCloud(toTuyaCloudOptions(config))
}

function defaultDiscover(opts: { timeoutMs: number }): Promise<DiscoveredDevice[]> {
  return discoverDevices({ timeoutMs: opts.timeoutMs })
}

/**
 * Merge the cloud device list (localKeys + provenance) with the LAN discovery
 * sweep (reachable IP + protocol version) into the connection catalog. Pure so
 * it is unit-testable: cloud wins for identity/localKey; discovery wins for the
 * reachable LAN address + version when the cloud omits them.
 */
export function buildCatalog(
  cloudDevices: readonly CloudDevice[],
  discovered: readonly DiscoveredDevice[],
): TuyaCatalogEntry[] {
  const byId = new Map<string, DiscoveredDevice>()
  for (const d of discovered) byId.set(d.id, d)
  return cloudDevices.map((c): TuyaCatalogEntry => {
    const lan = byId.get(c.id)
    return {
      deviceId: c.id,
      name: c.name,
      localKey: c.localKey,
      category: c.category,
      ip: (c.ip ?? '').length > 0 ? (c.ip ?? '') : (lan?.ip ?? ''),
      version: (c.version ?? '').length > 0 ? (c.version ?? '') : (lan?.version ?? ''),
      online: c.online,
    }
  })
}

/**
 * Wraps exactly one Tuya IoT-cloud account (`mode: account`). {@link start} logs
 * the cloud in (implicitly, via `getDevices`) and runs a best-effort LAN
 * discovery sweep, then publishes the merged CATALOG (device list + localKeys +
 * reachable IPs) on the shared resolver keyed by `integrationId`. The catalog is
 * the adoption source; ongoing device CONTROL is LOCAL and owned per-device by
 * the adopted device classes (single TCP client each). {@link stop} clears the
 * catalog; {@link applyConnection} does both atomically on a credentials change.
 *
 * Mirrors `DreameIntegrationManager` (cloud login → discovery → publish) minus
 * the persistent MQTT — Tuya control is local, so there is no account-level live
 * socket to keep open here.
 */
export class TuyaIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: TuyaConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #resolver: TuyaConnectionResolver
  readonly #makeCloud: TuyaCloudFactory
  readonly #discover: TuyaDiscoverFn

  #started = false
  #status: TuyaConnectionStatus = 'disconnected'
  #deviceCount = 0
  #lastCheckedAt: number | null = null
  #error: string | null = null

  constructor(options: TuyaIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#resolver = options.resolver
    this.#makeCloud = options.makeCloud ?? defaultCloud
    this.#discover = options.discover ?? defaultDiscover
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): TuyaConfig {
    return this.#connection
  }

  /** Immutable snapshot of current manager state. */
  getInfo(): TuyaConnectionInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'tuya',
      status: this.#status,
      info: { region: this.#connection.region, deviceCount: this.#deviceCount },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  /**
   * Fetch the account's cloud devices (localKeys) + a best-effort LAN discovery
   * sweep, publish the merged catalog. Sets `connected` on success. Surfaces a
   * clear credential error on {@link TuyaCloudError} without leaking the secret.
   */
  async start(): Promise<void> {
    if (this.#started) {
      this.#logger.warn('TuyaIntegrationManager: start() called while running — stop first', {
        tags: { integrationId: this.#id },
      })
      return
    }
    this.#started = true
    this.#status = 'connecting'
    this.#error = null

    try {
      const cloud = this.#makeCloud(this.#connection)
      const cloudDevices = await cloud.getDevices()
      // LAN discovery is best-effort: the cloud IP is often enough, and a device
      // on another subnet simply keeps its cloud IP (or blank → adopt still
      // works, host is completed at Phase-C onboarding).
      const discovered = await this.#discover({
        timeoutMs: this.#connection.discoveryTimeoutMs,
      }).catch((err: unknown): DiscoveredDevice[] => {
        this.#logger.debug('TuyaIntegrationManager: LAN discovery failed (using cloud IPs)', {
          tags: { integrationId: this.#id },
          meta: { error: errMsg(err) },
        })
        return []
      })

      const catalog = buildCatalog(cloudDevices, discovered)
      this.#resolver.setCatalog(this.#id, catalog)
      this.#deviceCount = catalog.length
      this.#status = 'connected'
      this.#error = null
      this.#lastCheckedAt = Date.now()
      this.#onConnected(this.#id)
      this.#logger.info('TuyaIntegrationManager: connected', {
        tags: { integrationId: this.#id },
        meta: {
          region: this.#connection.region,
          deviceCount: this.#deviceCount,
          discovered: discovered.length,
        },
      })
    } catch (err: unknown) {
      this.#started = false
      this.#status = 'error'
      this.#error =
        err instanceof TuyaCloudError
          ? 'authentication / cloud error — check the Access ID / Secret / region'
          : errMsg(err)
      this.#lastCheckedAt = Date.now()
      this.#resolver.setCatalog(this.#id, null)
      this.#onDisconnected(this.#id)
      this.#logger.warn('TuyaIntegrationManager: connect failed', {
        tags: { integrationId: this.#id },
        meta: { error: this.#error },
      })
      throw err
    }
  }

  /** Clear the catalog + mark disconnected. */
  async stop(): Promise<void> {
    this.#started = false
    this.#status = 'disconnected'
    this.#resolver.setCatalog(this.#id, null)
    this.#onDisconnected(this.#id)
    return Promise.resolve()
  }

  /** Atomically replace the connection: stop, swap config, start fresh. */
  async applyConnection(conn: TuyaConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }
}

/** Coerce a loose settings blob through the connection schema (re-export seam
 *  used by the registry). */
export function parseConnection(settings: unknown): TuyaConfig {
  return settingsToTuyaConfig(settings)
}
