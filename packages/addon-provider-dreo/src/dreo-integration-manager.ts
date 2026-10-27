import {
  DreoAuthError,
  type BaseDevice as DreoBaseDevice,
  type DreoDeviceInfo,
  Nodedreo,
} from '@apocaliss92/nodedreo'
import { errMsg, type IntegrationSessionSink, type IScopedLogger } from '@camstack/types'
import { type DreoConfig, toDreoConstructorArgs } from './config.js'
import type { DreoConnectionSurface } from './dreo-gateway.js'
import { dreoSession } from './dreo-session.js'

/** Status of a single Dreo account connection. */
export type DreoBrokerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Immutable snapshot returned by {@link DreoIntegrationManager.getInfo}. */
export interface DreoBrokerInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'dreo'
  readonly status: DreoBrokerStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/**
 * Minimal facade surface the manager needs from {@link Nodedreo}. Both the real
 * class and test stubs satisfy this structurally — no cast required.
 */
export interface DreoFacadeLike {
  login(): Promise<void>
  discoverDevices(): Promise<DreoDeviceInfo[]>
  connect(): Promise<void>
  createDevice(info: DreoDeviceInfo): Promise<DreoBaseDevice>
  close(): void
}

/** Factory seam: build a {@link DreoFacadeLike} from a config (tests inject a fake). */
export type DreoFacadeFactory = (config: DreoConfig) => DreoFacadeLike

/** Sink the manager publishes its live connection surface to (the resolver). */
export interface DreoSurfaceSink {
  set(brokerId: string, surface: DreoConnectionSurface | null): void
}

/** Constructor options for {@link DreoIntegrationManager}. */
export interface DreoIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: DreoConfig
  readonly logger: IScopedLogger
  readonly onConnected: (brokerId: string) => void
  readonly onDisconnected: (brokerId: string) => void
  readonly surfaceSink: DreoSurfaceSink
  /** Factory seam for testing. When omitted, builds a real {@link Nodedreo}. */
  readonly makeFacade?: DreoFacadeFactory
  /** Session-health sink (the standard cloud-connection-lost alert). Defaults to the addon's. */
  readonly session?: IntegrationSessionSink
}

/**
 * Build a real {@link Nodedreo} facade from a config. Exported so the
 * pre-creation `connection-test` provider signs in through EXACTLY the same
 * client the live integration will use — a test that authenticated some other
 * way would be validating a different thing from the one that then fails.
 */
export function defaultFacade(config: DreoConfig): DreoFacadeLike {
  const { creds, opts } = toDreoConstructorArgs(config)
  return new Nodedreo(creds, opts)
}

/**
 * Wraps exactly one `@apocaliss92/nodedreo` facade (= one Dreo account) with
 * observable status + lifecycle. {@link start} logs in, discovers devices, opens
 * the WebSocket push channel, and creates a typed handle per device (publishing
 * the connection surface on the shared resolver). {@link stop} closes the facade;
 * {@link applyConnection} does both atomically when the operator changes
 * credentials.
 *
 * Mirrors `DreameIntegrationManager`. The library owns the WebSocket reconnect,
 * so the manager does not retry.
 */
export class DreoIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: DreoConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (brokerId: string) => void
  readonly #onDisconnected: (brokerId: string) => void
  readonly #surfaceSink: DreoSurfaceSink
  readonly #makeFacade: DreoFacadeFactory

  readonly #session: IntegrationSessionSink
  #facade: DreoFacadeLike | null = null
  #status: DreoBrokerStatus = 'disconnected'
  #deviceCount = 0
  #lastCheckedAt: number | null = null
  #error: string | null = null

  constructor(options: DreoIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#surfaceSink = options.surfaceSink
    this.#makeFacade = options.makeFacade ?? defaultFacade
    this.#session = options.session ?? dreoSession
  }

  /** The live facade, or null when stopped. */
  get facade(): DreoFacadeLike | null {
    return this.#facade
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): DreoConfig {
    return this.#connection
  }

  /** Immutable snapshot of current manager state. */
  getInfo(): DreoBrokerInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'dreo',
      status: this.#status,
      info: {
        region: this.#connection.region,
        deviceCount: this.#deviceCount,
      },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  /**
   * Build the facade, authenticate, discover devices, open the WebSocket push,
   * create one typed handle per device, and publish the connection surface.
   * Sets `connected` on success. Surfaces a clear credential error on
   * {@link DreoAuthError} without leaking the token.
   */
  async start(): Promise<void> {
    if (this.#facade !== null) {
      this.#logger.warn('DreoIntegrationManager: start() called while running — stop first', {
        tags: { brokerId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null
    this.#session.register(this.#id, this.#name)

    const facade = this.#makeFacade(this.#connection)
    this.#facade = facade

    try {
      await facade.login()
      const infos = await facade.discoverDevices()
      await facade.connect()

      const handles = new Map<string, DreoBaseDevice>()
      for (const info of infos) {
        try {
          const handle = await facade.createDevice(info)
          handles.set(info.deviceId, handle)
        } catch (err: unknown) {
          // A single un-instantiable device must not fail the whole account.
          this.#logger.warn('DreoIntegrationManager: createDevice failed', {
            tags: { brokerId: this.#id },
            meta: { deviceId: info.deviceId, model: info.model, error: errMsg(err) },
          })
        }
      }

      const surface: DreoConnectionSurface = { infos, handles }
      this.#surfaceSink.set(this.#id, surface)

      this.#deviceCount = handles.size
      this.#status = 'connected'
      this.#error = null
      this.#lastCheckedAt = Date.now()
      void this.#session.ok(this.#id)
      this.#onConnected(this.#id)
      this.#logger.info('DreoIntegrationManager: connected', {
        tags: { brokerId: this.#id },
        meta: { region: this.#connection.region, deviceCount: this.#deviceCount },
      })
    } catch (err: unknown) {
      this.#status = 'error'
      this.#error =
        err instanceof DreoAuthError
          ? 'authentication failed — check credentials / region'
          : errMsg(err)
      this.#lastCheckedAt = Date.now()
      this.#surfaceSink.set(this.#id, null)
      this.#session.failure(this.#id, err)
      this.#onDisconnected(this.#id)
      this.#logger.warn('DreoIntegrationManager: connect failed', {
        tags: { brokerId: this.#id },
        meta: { error: this.#error },
      })
      throw err
    }
  }

  /** Close the facade (tears down the WebSocket push), null it, set disconnected. */
  async stop(): Promise<void> {
    const facade = this.#facade
    this.#facade = null
    this.#status = 'disconnected'
    this.#surfaceSink.set(this.#id, null)
    if (facade) {
      try {
        facade.close()
      } catch (err: unknown) {
        this.#logger.warn('DreoIntegrationManager: facade close failed', {
          tags: { brokerId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, start fresh. */
  async applyConnection(conn: DreoConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }
}

/** True when two configs are the "same connection" (no facade rebuild needed). */
export function sameConnection(a: DreoConfig | null, b: DreoConfig | null): boolean {
  if (a === null || b === null) return false
  return a.email === b.email && a.password === b.password && a.region === b.region
}
