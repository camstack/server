import { errMsg, type IScopedLogger } from '@camstack/types'
import type { UnraidConnectionConfig } from './config.js'
import type {
  UnraidClientFactory,
  UnraidClientLike,
  UnraidSnapshot,
} from './unraid-client-contract.js'

/** Status of a single Unraid instance connection. */
export type UnraidInstanceStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/**
 * Default client factory — INTENTIONALLY unimplemented. The real
 * `@apocaliss92/node-unraid` library EXISTS and is ready, but is not wired here
 * yet (see `plan-unraid.md`). Wiring it is the single remaining code step:
 * replace this factory with one that builds a real {@link UnraidClientLike} over
 * the published client. Until then the addon installs and type-checks, but a
 * created instance stays offline and logs this error.
 */
export const defaultUnraidClientFactory: UnraidClientFactory = () => {
  throw new Error(
    'unraid: @apocaliss92/node-unraid is not wired yet — install & wire it ' +
      '(implement UnraidClientLike over UnraidClient, see plan-unraid.md) and ' +
      'pass a makeClient factory.',
  )
}

/** Constructor options for {@link UnraidIntegrationManager}. */
export interface UnraidIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: UnraidConnectionConfig
  readonly logger: IScopedLogger
  readonly onConnected: (instanceId: string) => void
  readonly onDisconnected: (instanceId: string) => void
  /** Fired after every poll cycle so the Hub fans the fresh snapshot out. */
  readonly onPolled: (instanceId: string) => void
  /** Factory seam — defaults to the "not wired" factory above. */
  readonly makeClient?: UnraidClientFactory
}

/**
 * Wraps exactly one {@link UnraidClientLike} (= one Unraid server). Owns a poll
 * loop: on `start()` it connects, fetches the first snapshot, and then
 * periodically re-fetches, firing `onPolled` after every cycle. Mirrors the
 * Velux / Ecowitt integration managers, with the same fresh-client-on-reconnect
 * discipline.
 */
export class UnraidIntegrationManager {
  readonly #id: string
  #connection: UnraidConnectionConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (instanceId: string) => void
  readonly #onDisconnected: (instanceId: string) => void
  readonly #onPolled: (instanceId: string) => void
  readonly #makeClient: UnraidClientFactory

  #client: UnraidClientLike | null = null
  #snapshot: UnraidSnapshot | null = null
  #status: UnraidInstanceStatus = 'disconnected'
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #error: string | null = null

  constructor(options: UnraidIntegrationManagerOptions) {
    this.#id = options.id
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onPolled = options.onPolled
    this.#makeClient = options.makeClient ?? defaultUnraidClientFactory
  }

  /** The instance id (= Hub device stableId). */
  get id(): string {
    return this.#id
  }

  /** Current connection status. */
  get status(): UnraidInstanceStatus {
    return this.#status
  }

  /** The last error surfaced from the source, or null. */
  get error(): string | null {
    return this.#error
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): UnraidConnectionConfig {
    return this.#connection
  }

  /** The most-recent poll snapshot, or null before the first poll. */
  getSnapshot(): UnraidSnapshot | null {
    return this.#snapshot
  }

  /** The live client, or null when stopped. Entity children drive commands here. */
  get client(): UnraidClientLike | null {
    return this.#client
  }

  /**
   * Connect the client, fetch the first snapshot, and start the poll loop. A
   * failed connect throws (the caller logs and keeps the device — a later
   * `applyConnection` / restart retries).
   */
  async start(): Promise<void> {
    if (this.#client !== null) {
      this.#logger.warn('UnraidIntegrationManager: start() called while running — stop first', {
        tags: { instanceId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const client = this.#makeClient({
      host: this.#connection.host,
      port: this.#connection.port,
      https: this.#connection.https,
      apiKey: this.#connection.apiKey,
    })
    this.#client = client

    await client.connect()
    this.#snapshot = await fetchSnapshot(client)

    this.#status = 'connected'
    this.#onConnected(this.#id)
    this.#onPolled(this.#id)
    this.#startPollLoop()
    this.#logger.info('UnraidIntegrationManager: started', {
      tags: { instanceId: this.#id },
      meta: { dockerCount: this.#snapshot.dockers.length, diskCount: this.#snapshot.disks.length },
    })
  }

  /** Stop the poll loop and drop the client + snapshot. */
  async stop(): Promise<void> {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    const client = this.#client
    this.#client = null
    this.#snapshot = null
    this.#status = 'disconnected'
    if (client) {
      try {
        await client.disconnect()
      } catch (err) {
        this.#logger.warn('UnraidIntegrationManager: disconnect failed', {
          tags: { instanceId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, reconnect. */
  async applyConnection(connection: UnraidConnectionConfig): Promise<void> {
    await this.stop()
    this.#connection = connection
    await this.start()
  }

  /** Re-fetch the snapshot once, then fan it out. Best-effort. */
  async poll(): Promise<void> {
    const client = this.#client
    if (client === null) return
    try {
      this.#snapshot = await fetchSnapshot(client)
      this.#error = null
    } catch (err) {
      this.#error = errMsg(err)
      this.#logger.debug('UnraidIntegrationManager: snapshot poll failed', {
        tags: { instanceId: this.#id },
        meta: { error: this.#error },
      })
    }
    this.#onPolled(this.#id)
  }

  #startPollLoop(): void {
    if (this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      void this.poll().catch((err) => {
        this.#logger.warn('UnraidIntegrationManager: poll cycle failed', {
          tags: { instanceId: this.#id },
          meta: { error: errMsg(err) },
        })
      })
    }, this.#connection.pollIntervalMs)
    // Do not keep the event loop alive solely for polling.
    this.#pollTimer.unref?.()
  }
}

/** Aggregate one snapshot from the client's domain namespaces. */
async function fetchSnapshot(client: UnraidClientLike): Promise<UnraidSnapshot> {
  const [array, cpu, dockers, notifications] = await Promise.all([
    client.array.get(),
    client.system.cpu(),
    client.docker.list(),
    client.notifications.active(),
  ])
  return {
    array,
    cpu,
    disks: array.disks,
    dockers,
    notifications,
  }
}
