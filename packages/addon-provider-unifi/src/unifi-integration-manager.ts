import { errMsg, type IntegrationInstanceStatus, type IScopedLogger } from '@camstack/types'
import type { UnifiConnectionConfig } from './config.js'
import { classifyUnifiError } from './unifi-connection-test.js'
import type {
  UnifiClientSnapshot,
  UnifiControllerClient,
  UnifiControllerClientFactory,
  UnifiInfraSnapshot,
} from './unifi-client-contract.js'

/** Status of a single UniFi controller connection. */
export type UnifiControllerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Constructor options for {@link UnifiIntegrationManager}. */
export interface UnifiIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: UnifiConnectionConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  /** Fired after every poll cycle so the controller device fans the fresh
   *  snapshot out to its infra + client children. */
  readonly onPolled: (integrationId: string) => void
  /** Builds the API-key client for the connection (`liveUnifiClientFactory` in production). */
  readonly makeClient: UnifiControllerClientFactory
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
  readonly #name: string
  #connection: UnifiConnectionConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #onPolled: (integrationId: string) => void
  readonly #makeClient: UnifiControllerClientFactory

  #client: UnifiControllerClient | null = null
  #infra: Map<string, UnifiInfraSnapshot> = new Map()
  #clients: Map<string, UnifiClientSnapshot> = new Map()
  #status: UnifiControllerStatus = 'disconnected'
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #error: string | null = null

  constructor(options: UnifiIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onPolled = options.onPolled
    this.#makeClient = options.makeClient
  }

  /** The controller id (= the integration id). */
  get id(): string {
    return this.#id
  }

  /** The integration's display name. */
  get name(): string {
    return this.#name
  }

  /** Current connection status. */
  get status(): UnifiControllerStatus {
    return this.#status
  }

  /** Last error surfaced from the client, or null. */
  get error(): string | null {
    return this.#error
  }

  /** Hold the integration offline for a reason found before any client was built. */
  markFailed(reason: string): void {
    this.#status = 'error'
    this.#error = reason
  }

  /** The integration's status word, from the live connection. */
  instanceStatus(): IntegrationInstanceStatus {
    if (this.#error !== null) return { state: 'error', label: 'Offline', detail: this.#error }
    switch (this.#status) {
      case 'connected':
        return { state: 'ok', label: 'Connected', detail: 'Signed in with the API key' }
      case 'connecting':
        return { state: 'unknown', label: 'Connecting' }
      case 'error':
      case 'disconnected':
        return { state: 'off', label: 'Disconnected' }
    }
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
        tags: { integrationId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null
    try {
      const client = this.#makeClient(this.#connection)
      this.#client = client
      await client.connect()
      this.#infra = indexBy(await client.listInfraDevices(), (d) => d.id)
      this.#clients = indexBy(await client.listClients(), (c) => c.mac)
    } catch (err) {
      // The reason stays on the manager (the integration's status word) after the caller stops it.
      this.#status = 'error'
      this.#error = classifyUnifiError(err).reason
      throw err
    }

    this.#status = 'connected'
    this.#onConnected(this.#id)
    this.#onPolled(this.#id)
    this.#startPollLoop()
    this.#logger.info('UnifiIntegrationManager: started', {
      tags: { integrationId: this.#id },
      meta: {
        infraCount: this.#infra.size,
        clientCount: this.#clients.size,
      },
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
    // A failed start keeps its 'error' status and reason: that is what the operator must see.
    if (this.#status !== 'error') this.#status = 'disconnected'
    if (client) {
      try {
        await client.disconnect()
      } catch (err) {
        this.#logger.warn('UnifiIntegrationManager: disconnect failed', {
          tags: { integrationId: this.#id },
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
      this.#error = classifyUnifiError(err).reason
      this.#logger.debug('UnifiIntegrationManager: poll failed', {
        tags: { integrationId: this.#id },
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
          tags: { integrationId: this.#id },
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
