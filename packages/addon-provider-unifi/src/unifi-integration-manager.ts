import { errMsg, type IScopedLogger } from '@camstack/types'
import type { UnifiConnectionConfig } from './config.js'
import type {
  UnifiClientSnapshot,
  UnifiControllerClient,
  UnifiControllerClientFactory,
  UnifiInfraSnapshot,
} from './unifi-client-contract.js'

/** Status of a single UniFi controller connection. */
export type UnifiControllerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/**
 * Default client factory — INTENTIONALLY unimplemented. No UniFi controller-API
 * client library is wired into this addon yet (see `plan-unifi.md`). Wiring one
 * is the single remaining step to make UniFi live: replace this factory with a
 * real {@link UnifiControllerClient} implementation. Until then the addon
 * installs and type-checks, but a created controller stays offline and logs this
 * error.
 */
export const defaultUnifiClientFactory: UnifiControllerClientFactory = () => {
  throw new Error(
    'unifi: no UniFi controller-API client library is wired yet — implement ' +
      'UnifiControllerClient (see plan-unifi.md) and pass a makeClient factory.',
  )
}

/** Constructor options for {@link UnifiIntegrationManager}. */
export interface UnifiIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: UnifiConnectionConfig
  readonly logger: IScopedLogger
  readonly onConnected: (controllerId: string) => void
  readonly onDisconnected: (controllerId: string) => void
  /** Fired after every poll cycle so the controller device fans the fresh
   *  snapshot out to its infra + client children. */
  readonly onPolled: (controllerId: string) => void
  /** Factory seam — defaults to the "not wired" factory above. */
  readonly makeClient?: UnifiControllerClientFactory
}

/**
 * Wraps exactly one {@link UnifiControllerClient} (= one UniFi Network
 * controller). The controller is POLLED (no push channel targeted): on `start()`
 * it connects, lists infra + clients once, and then periodically re-lists them,
 * firing `onPolled` after every cycle. Mirrors the Velux / Rademacher
 * integration manager, with the same fresh-client-on-reconnect discipline.
 */
export class UnifiIntegrationManager {
  readonly #id: string
  #connection: UnifiConnectionConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (controllerId: string) => void
  readonly #onDisconnected: (controllerId: string) => void
  readonly #onPolled: (controllerId: string) => void
  readonly #makeClient: UnifiControllerClientFactory

  #client: UnifiControllerClient | null = null
  #infra: Map<string, UnifiInfraSnapshot> = new Map()
  #clients: Map<string, UnifiClientSnapshot> = new Map()
  #status: UnifiControllerStatus = 'disconnected'
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #error: string | null = null

  constructor(options: UnifiIntegrationManagerOptions) {
    this.#id = options.id
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onPolled = options.onPolled
    this.#makeClient = options.makeClient ?? defaultUnifiClientFactory
  }

  /** The controller id (= Hub device stableId). */
  get id(): string {
    return this.#id
  }

  /** Current connection status. */
  get status(): UnifiControllerStatus {
    return this.#status
  }

  /** Last error surfaced from the client, or null. */
  get error(): string | null {
    return this.#error
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): UnifiConnectionConfig {
    return this.#connection
  }

  /** All infra snapshots known to this controller. */
  getInfraList(): readonly UnifiInfraSnapshot[] {
    return [...this.#infra.values()]
  }

  /** Resolve a single infra snapshot by its id, or null. */
  getInfra(id: string): UnifiInfraSnapshot | null {
    return this.#infra.get(id) ?? null
  }

  /** All client snapshots known to this controller. */
  getClientList(): readonly UnifiClientSnapshot[] {
    return [...this.#clients.values()]
  }

  /** Resolve a single client snapshot by MAC, or null. */
  getClient(mac: string): UnifiClientSnapshot | null {
    return this.#clients.get(mac) ?? null
  }

  /** The live client, or null when stopped. Feature children drive commands here. */
  get client(): UnifiControllerClient | null {
    return this.#client
  }

  /**
   * Connect the client, list infra + clients once, and start the poll loop. A
   * failed connect throws (the caller logs and keeps the device — a later
   * `applyConnection` / restart retries).
   */
  async start(): Promise<void> {
    if (this.#client !== null) {
      this.#logger.warn('UnifiIntegrationManager: start() called while running — stop first', {
        tags: { controllerId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const client = this.#makeClient({
      host: this.#connection.host,
      port: this.#connection.port,
      apiKey: this.#connection.apiKey,
      username: this.#connection.username,
      password: this.#connection.password,
      site: this.#connection.site,
    })
    this.#client = client

    await client.connect()
    this.#infra = indexBy(await client.listInfraDevices(), (d) => d.id)
    this.#clients = indexBy(await client.listClients(), (c) => c.mac)

    this.#status = 'connected'
    this.#onConnected(this.#id)
    this.#onPolled(this.#id)
    this.#startPollLoop()
    this.#logger.info('UnifiIntegrationManager: started', {
      tags: { controllerId: this.#id },
      meta: { infraCount: this.#infra.size, clientCount: this.#clients.size },
    })
  }

  /** Stop the poll loop and drop the client + snapshots. */
  async stop(): Promise<void> {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    const client = this.#client
    this.#client = null
    this.#infra = new Map()
    this.#clients = new Map()
    this.#status = 'disconnected'
    if (client) {
      try {
        await client.disconnect()
      } catch (err) {
        this.#logger.warn('UnifiIntegrationManager: disconnect failed', {
          tags: { controllerId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, reconnect. */
  async applyConnection(connection: UnifiConnectionConfig): Promise<void> {
    await this.stop()
    this.#connection = connection
    await this.start()
  }

  /** Re-list infra + clients once, then fan the snapshot out. Best-effort. */
  async poll(): Promise<void> {
    const client = this.#client
    if (client === null) return
    try {
      this.#infra = indexBy(await client.listInfraDevices(), (d) => d.id)
      this.#clients = indexBy(await client.listClients(), (c) => c.mac)
      this.#error = null
    } catch (err) {
      this.#error = errMsg(err)
      this.#logger.debug('UnifiIntegrationManager: poll failed', {
        tags: { controllerId: this.#id },
        meta: { error: this.#error },
      })
    }
    this.#onPolled(this.#id)
  }

  #startPollLoop(): void {
    if (this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      void this.poll().catch((err) => {
        this.#logger.warn('UnifiIntegrationManager: poll cycle failed', {
          tags: { controllerId: this.#id },
          meta: { error: errMsg(err) },
        })
      })
    }, this.#connection.pollIntervalMs)
    // Do not keep the event loop alive solely for polling.
    this.#pollTimer.unref?.()
  }
}

/** Index a list by a derived key. */
function indexBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) map.set(keyOf(item), item)
  return map
}
