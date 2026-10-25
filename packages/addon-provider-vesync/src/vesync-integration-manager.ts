import { errMsg, type IScopedLogger } from '@camstack/types'
import type { VeSyncConnectionConfig } from './config.js'
import type {
  VeSyncClient,
  VeSyncClientFactory,
  VeSyncPurifierSnapshot,
} from './vesync-client-contract.js'

/** Status of a single VeSync account connection. */
export type VeSyncAccountStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/**
 * Default client factory — INTENTIONALLY unimplemented. No VeSync client library
 * is wired into this addon yet (see `plan-vesync.md`). Wiring one is the single
 * remaining step to make VeSync live: replace this factory with a real
 * {@link VeSyncClient} implementation. Until then the addon installs and
 * type-checks, but a created account stays offline and logs this error.
 */
export const defaultVeSyncClientFactory: VeSyncClientFactory = () => {
  throw new Error(
    'vesync: no VeSync client library is wired yet — implement VeSyncClient ' +
      '(see plan-vesync.md) and pass a makeClient factory.',
  )
}

/** Constructor options for {@link VeSyncIntegrationManager}. */
export interface VeSyncIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: VeSyncConnectionConfig
  readonly logger: IScopedLogger
  readonly onConnected: (accountId: string) => void
  readonly onDisconnected: (accountId: string) => void
  /** Fired after every poll cycle so the account device fans the fresh snapshot
   *  out to its purifier children. */
  readonly onPolled: (accountId: string) => void
  /** Factory seam — defaults to the "not wired" factory above. */
  readonly makeClient?: VeSyncClientFactory
}

/**
 * Wraps exactly one {@link VeSyncClient} (= one VeSync account). VeSync exposes
 * no push channel via the wrapper we target, so the manager owns a poll loop: on
 * `start()` it logs in, lists devices once, and then periodically re-lists them,
 * firing `onPolled` after every cycle. Mirrors the Velux / Rademacher integration
 * manager, with the same fresh-client-on-reconnect discipline.
 */
export class VeSyncIntegrationManager {
  readonly #id: string
  #connection: VeSyncConnectionConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (accountId: string) => void
  readonly #onDisconnected: (accountId: string) => void
  readonly #onPolled: (accountId: string) => void
  readonly #makeClient: VeSyncClientFactory

  #client: VeSyncClient | null = null
  #purifiers: Map<string, VeSyncPurifierSnapshot> = new Map()
  #status: VeSyncAccountStatus = 'disconnected'
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #error: string | null = null

  constructor(options: VeSyncIntegrationManagerOptions) {
    this.#id = options.id
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onPolled = options.onPolled
    this.#makeClient = options.makeClient ?? defaultVeSyncClientFactory
  }

  /** The account id (= Hub device stableId). */
  get id(): string {
    return this.#id
  }

  /** Current connection status. */
  get status(): VeSyncAccountStatus {
    return this.#status
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): VeSyncConnectionConfig {
    return this.#connection
  }

  /** All purifier snapshots known to this account. */
  getPurifiers(): readonly VeSyncPurifierSnapshot[] {
    return [...this.#purifiers.values()]
  }

  /** Resolve a single purifier snapshot by its native id, or null. */
  getPurifier(nativeId: string): VeSyncPurifierSnapshot | null {
    return this.#purifiers.get(nativeId) ?? null
  }

  /** The live client, or null when stopped. Purifier children drive commands here. */
  get client(): VeSyncClient | null {
    return this.#client
  }

  /**
   * Log in, list devices once, and start the poll loop. A failed login throws
   * (the caller logs and keeps the device — a later `applyConnection` / restart
   * retries).
   */
  async start(): Promise<void> {
    if (this.#client !== null) {
      this.#logger.warn('VeSyncIntegrationManager: start() called while running — stop first', {
        tags: { accountId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const client = this.#makeClient({
      email: this.#connection.email,
      password: this.#connection.password,
      region: this.#connection.region,
    })
    this.#client = client

    await client.login()
    this.#purifiers = indexPurifiers(await client.listDevices())

    this.#status = 'connected'
    this.#onConnected(this.#id)
    this.#onPolled(this.#id)
    this.#startPollLoop()
    this.#logger.info('VeSyncIntegrationManager: started', {
      tags: { accountId: this.#id },
      meta: { purifierCount: this.#purifiers.size },
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
    this.#purifiers = new Map()
    this.#status = 'disconnected'
    if (client) {
      try {
        await client.logout()
      } catch (err) {
        this.#logger.warn('VeSyncIntegrationManager: logout failed', {
          tags: { accountId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, reconnect. */
  async applyConnection(connection: VeSyncConnectionConfig): Promise<void> {
    await this.stop()
    this.#connection = connection
    await this.start()
  }

  /** Re-list devices once, then fan the snapshot out. Best-effort. */
  async poll(): Promise<void> {
    const client = this.#client
    if (client === null) return
    try {
      this.#purifiers = indexPurifiers(await client.listDevices())
    } catch (err) {
      this.#error = errMsg(err)
      this.#logger.debug('VeSyncIntegrationManager: device poll failed', {
        tags: { accountId: this.#id },
        meta: { error: this.#error },
      })
    }
    this.#onPolled(this.#id)
  }

  #startPollLoop(): void {
    if (this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      void this.poll().catch((err) => {
        this.#logger.warn('VeSyncIntegrationManager: poll cycle failed', {
          tags: { accountId: this.#id },
          meta: { error: errMsg(err) },
        })
      })
    }, this.#connection.pollIntervalMs)
    // Do not keep the event loop alive solely for polling.
    this.#pollTimer.unref?.()
  }
}

/** Index a purifier snapshot list by native id. */
function indexPurifiers(
  purifiers: readonly VeSyncPurifierSnapshot[],
): Map<string, VeSyncPurifierSnapshot> {
  const map = new Map<string, VeSyncPurifierSnapshot>()
  for (const purifier of purifiers) map.set(purifier.nativeId, purifier)
  return map
}
