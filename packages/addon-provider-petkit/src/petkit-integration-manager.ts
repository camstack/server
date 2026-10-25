import {
  deviceTypeForRoster,
  FeederDevice,
  Nodepetkit,
  PetkitAuthError,
  type BaseDevice as PetkitBaseDevice,
  type PetkitDeviceInfo,
} from '@apocaliss92/nodepetkit'
import { errMsg, type IScopedLogger } from '@camstack/types'
import { type PetkitConfig, toNodepetkitOptions, toPetkitCredentials } from './config.js'
import type { PetkitConnectionSurface, PetkitSurfaceSink } from './petkit-gateway.js'

/** Status of a single PetKit account connection. */
export type PetkitConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Immutable snapshot returned by {@link PetkitIntegrationManager.getInfo}. */
export interface PetkitConnectionInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'petkit'
  readonly status: PetkitConnectionStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/**
 * Minimal facade surface the manager needs from {@link Nodepetkit}. Both the
 * real class and test stubs satisfy this structurally — no cast required.
 * PetKit is a cloud REST client with no sockets, so there is no `close()`.
 */
export interface PetkitFacadeLike {
  login(): Promise<void>
  discoverDevices(): Promise<PetkitDeviceInfo[]>
  createDevice(info: PetkitDeviceInfo): Promise<PetkitBaseDevice>
}

/** Factory seam: build a {@link PetkitFacadeLike} from a config (tests inject a fake). */
export type PetkitFacadeFactory = (config: PetkitConfig) => PetkitFacadeLike

/** Constructor options for {@link PetkitIntegrationManager}. */
export interface PetkitIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: PetkitConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  readonly surfaceSink: PetkitSurfaceSink
  /** Factory seam for testing. When omitted, builds a real {@link Nodepetkit}. */
  readonly makeFacade?: PetkitFacadeFactory
}

function defaultFacade(config: PetkitConfig): PetkitFacadeLike {
  return new Nodepetkit(toPetkitCredentials(config), toNodepetkitOptions(config))
}

/** True when a roster row is a feeder (the only device family this addon adopts). */
export function isFeederInfo(info: PetkitDeviceInfo): boolean {
  return deviceTypeForRoster(info.deviceType, info.model) === 'feeder'
}

/**
 * Wraps exactly one `@apocaliss92/nodepetkit` client (= one PetKit account).
 * {@link start} authenticates, discovers the account's feeders, materialises a
 * live {@link FeederDevice} handle for each (the client seeds each with an
 * initial poll), and publishes the connection surface on the shared resolver
 * keyed by `integrationId`. {@link stop} drops the surface; {@link applyConnection}
 * does both atomically when the operator changes credentials.
 *
 * The library is a cloud REST client with no push channel and no sockets — the
 * per-feeder refresh cadence lives in the device class, not here.
 */
export class PetkitIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: PetkitConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #surfaceSink: PetkitSurfaceSink
  readonly #makeFacade: PetkitFacadeFactory

  #started = false
  #status: PetkitConnectionStatus = 'disconnected'
  #feederCount = 0
  #lastCheckedAt: number | null = null
  #error: string | null = null

  constructor(options: PetkitIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#surfaceSink = options.surfaceSink
    this.#makeFacade = options.makeFacade ?? defaultFacade
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): PetkitConfig {
    return this.#connection
  }

  /** Immutable snapshot of current manager state. */
  getInfo(): PetkitConnectionInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'petkit',
      status: this.#status,
      info: {
        region: this.#connection.region,
        feederCount: this.#feederCount,
      },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  /**
   * Build the client, authenticate, discover feeders, and publish the surface.
   * Sets `connected` on success. Surfaces a clear credential error on
   * {@link PetkitAuthError} without leaking the token.
   */
  async start(): Promise<void> {
    if (this.#started) {
      this.#logger.warn('PetkitIntegrationManager: start() called while running — stop first', {
        tags: { integrationId: this.#id },
      })
      return
    }
    this.#started = true
    this.#status = 'connecting'
    this.#error = null

    const facade = this.#makeFacade(this.#connection)
    try {
      await facade.login()
      const infos = await facade.discoverDevices()
      const feederInfos = infos.filter(isFeederInfo)
      const handles = new Map<string, FeederDevice>()

      for (const info of feederInfos) {
        try {
          const dev = await facade.createDevice(info)
          if (dev instanceof FeederDevice) handles.set(info.id, dev)
        } catch (err: unknown) {
          this.#logger.warn('PetkitIntegrationManager: feeder handle creation failed', {
            tags: { integrationId: this.#id },
            meta: { petkitDeviceId: info.id, error: errMsg(err) },
          })
        }
      }

      const surface: PetkitConnectionSurface = { infos: feederInfos, handles }
      this.#surfaceSink.set(this.#id, surface)

      this.#feederCount = handles.size
      this.#status = 'connected'
      this.#error = null
      this.#lastCheckedAt = Date.now()
      this.#onConnected(this.#id)
      this.#logger.info('PetkitIntegrationManager: connected', {
        tags: { integrationId: this.#id },
        meta: { region: this.#connection.region, feeders: handles.size },
      })
    } catch (err: unknown) {
      this.#started = false
      this.#status = 'error'
      this.#error =
        err instanceof PetkitAuthError
          ? 'authentication failed — check credentials / region'
          : errMsg(err)
      this.#lastCheckedAt = Date.now()
      this.#surfaceSink.set(this.#id, null)
      this.#onDisconnected(this.#id)
      this.#logger.warn('PetkitIntegrationManager: connect failed', {
        tags: { integrationId: this.#id },
        meta: { error: this.#error },
      })
      throw err
    }
  }

  /** Drop the published surface, mark disconnected. (No sockets to close.) */
  async stop(): Promise<void> {
    this.#started = false
    this.#status = 'disconnected'
    this.#surfaceSink.set(this.#id, null)
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, start fresh. */
  async applyConnection(conn: PetkitConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }
}
