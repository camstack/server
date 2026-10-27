import type { IScopedLogger } from '@camstack/types'
import { sameConnection, type EnpalConnection } from './config.js'
import type { FetchLike } from './enpal-client.js'
import { EnpalIntegrationManager } from './enpal-integration-manager.js'
import { enpalConnections } from './enpal-resolver.js'

export interface EnpalClientRegistryDeps {
  /** First good poll after a failure (or after start). */
  readonly onConnected: (integrationId: string) => void
  /** The box stopped answering, or never did. */
  readonly onDisconnected: (integrationId: string) => void
  readonly fetch?: FetchLike
  readonly now?: () => number
}

interface EnpalClientEntry {
  readonly manager: EnpalIntegrationManager
  readonly connection: EnpalConnection
  readonly tokenLocked: boolean
}

/**
 * Owns one poller per Enpal integration (`Map<integrationId, manager>`) and publishes each on
 * {@link enpalConnections} so the devices follow it. The caller reconciles it against the
 * live integration list at boot and on every integration lifecycle event.
 */
export class EnpalClientRegistry {
  readonly #logger: IScopedLogger
  readonly #deps: EnpalClientRegistryDeps
  readonly #entries = new Map<string, EnpalClientEntry>()

  constructor(logger: IScopedLogger, deps: EnpalClientRegistryDeps) {
    this.#logger = logger
    this.#deps = deps
  }

  /**
   * Ensure a poller runs for `integrationId` with this connection. An unchanged connection
   * keeps the running poller; a changed one replaces it. Never throws: a box that is off is
   * an `error` status, polled again later.
   */
  async upsert(
    integrationId: string,
    name: string,
    connection: EnpalConnection,
    tokenLocked: boolean,
  ): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing !== undefined) {
      if (existing.tokenLocked === tokenLocked && sameConnection(existing.connection, connection)) {
        return
      }
      await this.remove(integrationId)
    }
    const manager = new EnpalIntegrationManager({
      id: integrationId,
      name,
      connection,
      tokenLocked,
      logger: this.#logger.withTags({ integrationId }),
      fetch: this.#deps.fetch,
      now: this.#deps.now,
      onConnected: () => {
        this.#deps.onConnected(integrationId)
      },
      onDisconnected: () => {
        this.#deps.onDisconnected(integrationId)
        enpalConnections.emitSnapshot(integrationId)
      },
      onPolled: () => {
        enpalConnections.emitSnapshot(integrationId)
      },
    })
    this.#entries.set(integrationId, { manager, connection, tokenLocked })
    enpalConnections.set(integrationId, manager)
    await manager.start()
    // A box that never answered has no good poll to lose, so nothing fired `onDisconnected`.
    if (manager.status === 'error') {
      this.#deps.onDisconnected(integrationId)
      enpalConnections.emitSnapshot(integrationId)
    }
  }

  async remove(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (entry === undefined) return
    this.#entries.delete(integrationId)
    enpalConnections.set(integrationId, null)
    await entry.manager.stop()
  }

  /** Stop every poller whose integration is not in `keep`. */
  async retain(keep: ReadonlySet<string>): Promise<void> {
    for (const id of [...this.#entries.keys()]) {
      if (!keep.has(id)) await this.remove(id)
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.#entries.keys()]) await this.remove(id)
  }

  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  list(): readonly string[] {
    return [...this.#entries.keys()]
  }
}
