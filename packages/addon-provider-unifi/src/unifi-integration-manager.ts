import { errMsg, type IntegrationInstanceStatus, type IScopedLogger } from '@camstack/types'
import type { UnifiConnectionConfig } from './config.js'
import { unifiCredentialOf } from './unifi-client-factory.js'
import { classifyUnifiError } from './unifi-connection-test.js'
import type {
  UnifiClientSnapshot,
  UnifiControllerClient,
  UnifiControllerClientFactory,
  UnifiInfraSnapshot,
  UnifiLiveChange,
} from './unifi-client-contract.js'

/**
 * While the client's event stream is up, the poll only reconciles what a lost frame could have
 * missed: at most every this many ms (never faster than the configured interval).
 */
export const UNIFI_RECONCILE_POLL_MS = 300_000

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
  /** Builds the client for the connection (`makeUnifiClientFactory` in production). */
  readonly makeClient: UnifiControllerClientFactory
}

/**
 * Wraps exactly one {@link UnifiControllerClient} (= one UniFi Network
 * controller). On `start()` it connects and lists infra + clients once; the
 * core's state refresh decides when they are re-listed (D1062), so it owns no
 * timer. `poll` re-lists them, firing `onPolled` after every cycle. A client with
 * an event stream (a local account: the aiounifi websocket) pushes its tables
 * between polls — `onPolled` fires for those too — and while that stream is up
 * the refresh slows to a reconcile ({@link UNIFI_RECONCILE_POLL_MS}). Mirrors the Velux / Rademacher
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
  #streamUp = false
  #unsubscribeLive: (() => void) | null = null
  /** The last failure of the client's secondary half (the local account), logged on change. */
  #degraded: string | null = null
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
        return { state: 'ok', label: 'Connected', detail: this.#signedInWith() }
      case 'connecting':
        return { state: 'unknown', label: 'Connecting' }
      case 'error':
      case 'disconnected':
        return { state: 'off', label: 'Disconnected' }
    }
  }

  /** Which credential signed in; a local account that stopped answering is named as such. */
  #signedInWith(): string {
    switch (unifiCredentialOf(this.#connection)) {
      case 'local-account':
        return 'Signed in with the local account'
      case 'both':
        return this.#degraded === null
          ? 'Signed in with the API key and the local account'
          : 'Signed in with the API key; the local account does not answer (PoE on/off unavailable)'
      case 'api-key':
      case null:
        return 'Signed in with the API key'
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
   * Connect the client, list infra + clients once. A
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
      this.#unsubscribeLive = client.onLiveChange((change) => this.#onLiveChange(client, change))
      await client.connect()
      this.#infra = indexBy(await client.listInfraDevices(), (d) => d.id)
      this.#clients = indexBy(await client.listClients(), (c) => c.mac)
      this.#noteDegraded(client)
    } catch (err) {
      // The reason stays on the manager (the integration's status word) after the caller stops it.
      this.#status = 'error'
      this.#error = classifyUnifiError(err).reason
      throw err
    }

    this.#status = 'connected'
    this.#onConnected(this.#id)
    this.#onPolled(this.#id)
    this.#logger.info('UnifiIntegrationManager: started', {
      tags: { integrationId: this.#id },
      meta: {
        infraCount: this.#infra.size,
        clientCount: this.#clients.size,
      },
    })
  }

  /** Drop the client + snapshots. */
  async stop(): Promise<void> {
    this.#unsubscribeLive?.()
    this.#unsubscribeLive = null
    this.#streamUp = false
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
      this.#noteDegraded(client)
    } catch (err) {
      this.#error = classifyUnifiError(err).reason
      this.#logger.debug('UnifiIntegrationManager: poll failed', {
        tags: { integrationId: this.#id },
        meta: { error: this.#error },
      })
    }
    this.#onPolled(this.#id)
  }

  /**
   * Log when the local account of a two-credential client stops (or starts again) answering: the
   * API key keeps the integration online, so without this line PoE on/off would fail silently.
   */
  #noteDegraded(client: UnifiControllerClient): void {
    const err = client.degradedError()
    const reason = err === null ? null : classifyUnifiError(err).reason
    if (reason === this.#degraded) return
    this.#degraded = reason
    if (reason === null) {
      this.#logger.info('UniFi: the local account answers again — PoE on/off available', {
        tags: { integrationId: this.#id },
      })
      return
    }
    this.#logger.warn(
      'UniFi: the local account does not answer — PoE on/off unavailable: ' + reason,
      {
        tags: { integrationId: this.#id },
      },
    )
  }

  /** Whether the live event stream is up (changes arrive by push; the poll is a reconcile). */
  get streamUp(): boolean {
    return this.#streamUp
  }

  /** The interval between reads: a reconcile while the event stream is up. */
  pollDelayMs(): number {
    const configured = this.#connection.pollIntervalMs
    return this.#streamUp ? Math.max(configured, UNIFI_RECONCILE_POLL_MS) : configured
  }

  #onLiveChange(client: UnifiControllerClient, change: UnifiLiveChange): void {
    if (this.#client !== client) return
    if (change.kind === 'stream') {
      if (change.up === this.#streamUp) return
      this.#streamUp = change.up
      this.#logger.info(
        change.up
          ? 'UniFi: the event stream is up — live changes, reconcile poll'
          : 'UniFi: the event stream is down — polling at the configured interval',
        { tags: { integrationId: this.#id }, meta: { reason: change.reason } },
      )
      // Tell the devices: the refresh policy (push level, cadence) follows the stream (D1062).
      this.#onPolled(this.#id)
      return
    }
    this.#infra = indexBy(change.infra, (d) => d.id)
    this.#clients = indexBy(change.clients, (c) => c.mac)
    this.#error = null
    this.#onPolled(this.#id)
  }
}

/** Index a list by a derived key. */
function indexBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) map.set(keyOf(item), item)
  return map
}
