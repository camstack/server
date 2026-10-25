import { Ecowitt, type Sensor } from '@apocaliss92/nodewitt'
import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  type EcowittConfig,
  type EcowittListenerConfig,
  type EcowittLocalConfig,
} from './config.js'

/** Status of a single Ecowitt gateway connection. */
export type EcowittBrokerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Immutable snapshot returned by {@link EcowittIntegrationManager.getInfo}. */
export interface EcowittBrokerInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'ecowitt'
  readonly status: EcowittBrokerStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/** Factory seam: build a fresh {@link Ecowitt} from a config (tests inject a fake). */
export type EcowittFacadeFactory = (config: EcowittConfig) => Ecowitt

/** Build the real nodewitt facade for a transport. Pure. */
export function defaultEcowittFacadeFactory(config: EcowittConfig): Ecowitt {
  if (config.transport === 'local') {
    return buildLocalFacade(config)
  }
  return buildListenerFacade(config)
}

function buildLocalFacade(config: EcowittLocalConfig): Ecowitt {
  return Ecowitt.createLocal({
    host: config.host,
    port: config.port,
    ...(config.password.length > 0 ? { password: config.password } : {}),
    pollIntervalMs: config.pollIntervalMs,
    mappingIntervalMs: config.mappingIntervalMs,
  })
}

function buildListenerFacade(config: EcowittListenerConfig): Ecowitt {
  return Ecowitt.createListener({
    port: config.listenPort,
    ...(config.listenHost.length > 0 ? { host: config.listenHost } : {}),
  })
}

/** Constructor options for {@link EcowittIntegrationManager}. */
export interface EcowittIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: EcowittConfig
  readonly logger: IScopedLogger
  readonly onConnected: (brokerId: string) => void
  readonly onDisconnected: (brokerId: string) => void
  /** Fired (debounced by the library's own emit cadence) when the gateway's
   *  sensor set changes — the addon re-derives the container's children. */
  readonly onSensorsChanged: (brokerId: string, sensors: readonly Sensor[]) => void
  /** Called whenever a fresh facade is built, so the registry can re-publish it
   *  on the in-process resolver (the previous facade was terminal-stopped). */
  readonly onFacadeBuilt: (brokerId: string, facade: Ecowitt) => void
  /** Factory seam for testing. */
  readonly makeFacade?: EcowittFacadeFactory
}

/**
 * Wraps exactly one `@apocaliss92/nodewitt` facade (= one gateway). Because the
 * facade's `stop()` is TERMINAL, this manager always BUILDS A FRESH FACADE on
 * `start()` and `applyConnection()` and never reuses a stopped one. Mirrors the
 * Homematic / Dreame integration manager, with the terminal-stop discipline.
 *
 * The library never throws transport errors into the consumer — it surfaces them
 * as `error` events. The manager logs them + flags `lastError` but keeps the
 * broker "connected" (the poll keeps retrying; the listener stays bound).
 */
export class EcowittIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: EcowittConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (brokerId: string) => void
  readonly #onDisconnected: (brokerId: string) => void
  readonly #onSensorsChanged: (brokerId: string, sensors: readonly Sensor[]) => void
  readonly #onFacadeBuilt: (brokerId: string, facade: Ecowitt) => void
  readonly #makeFacade: EcowittFacadeFactory

  #facade: Ecowitt | null = null
  #status: EcowittBrokerStatus = 'disconnected'
  #sensorCount = 0
  #lastCheckedAt: number | null = null
  #error: string | null = null

  constructor(options: EcowittIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onSensorsChanged = options.onSensorsChanged
    this.#onFacadeBuilt = options.onFacadeBuilt
    this.#makeFacade = options.makeFacade ?? defaultEcowittFacadeFactory
  }

  /** The live facade, or null when stopped. */
  get facade(): Ecowitt | null {
    return this.#facade
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): EcowittConfig {
    return this.#connection
  }

  /** Immutable snapshot of current manager state. */
  getInfo(): EcowittBrokerInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'ecowitt',
      status: this.#status,
      info: {
        transport: this.#connection.transport,
        sensorCount: this.#sensorCount,
      },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  /**
   * Build a FRESH facade, wire its events, and start it. Local poll: `start()`
   * begins polling; listener: `start()` binds the upload server. Marks
   * `connected` once started (the first poll / push then drives the sensor set).
   */
  async start(): Promise<void> {
    if (this.#facade !== null) {
      this.#logger.warn('EcowittIntegrationManager: start() called while running — stop first', {
        tags: { brokerId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const facade = this.#makeFacade(this.#connection)
    this.#facade = facade
    this.#onFacadeBuilt(this.#id, facade)

    facade.on('error', (err: Error) => {
      this.#error = errMsg(err)
      this.#lastCheckedAt = Date.now()
      this.#logger.warn('EcowittIntegrationManager: facade error', {
        tags: { brokerId: this.#id },
        meta: { error: errMsg(err) },
      })
    })
    facade.on('snapshot', (snapshot) => {
      this.#sensorCount = snapshot.sensors.length
      this.#lastCheckedAt = Date.now()
      this.#onSensorsChanged(this.#id, snapshot.sensors)
    })

    await facade.start()
    this.#status = 'connected'
    this.#lastCheckedAt = Date.now()
    this.#onConnected(this.#id)
    this.#logger.info('EcowittIntegrationManager: started', {
      tags: { brokerId: this.#id },
      meta: { transport: this.#connection.transport },
    })
  }

  /** Stop the facade (TERMINAL — the instance can't restart), null it, disconnect. */
  async stop(): Promise<void> {
    const facade = this.#facade
    this.#facade = null
    this.#status = 'disconnected'
    if (facade) {
      try {
        await facade.stop()
      } catch (err: unknown) {
        this.#logger.warn('EcowittIntegrationManager: facade stop failed', {
          tags: { brokerId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop the terminal facade, swap config,
   *  build + start a FRESH one. */
  async applyConnection(conn: EcowittConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }
}
