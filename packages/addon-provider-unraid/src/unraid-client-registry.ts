import { errMsg, type IScopedLogger } from '@camstack/types'
import { sameConnection, type UnraidConnectionConfig } from './config.js'
import { UnraidIntegrationManager } from './unraid-integration-manager.js'
import type { UnraidClientFactory } from './unraid-client-contract.js'
import { unraidInstances } from './unraid-node-resolver.js'

export interface UnraidClientRegistryDeps {
  /** First good poll after a failure (or after start). */
  readonly onConnected: (integrationId: string) => void
  /** The server stopped answering, or never did. */
  readonly onDisconnected: (integrationId: string) => void
  /** Fired after every poll cycle: fan the snapshot out and reconcile the entities. */
  readonly onPolled: (integrationId: string) => void
  readonly makeClient?: UnraidClientFactory
}

interface UnraidClientEntry {
  readonly manager: UnraidIntegrationManager
  readonly connection: UnraidConnectionConfig
  readonly apiKeyLocked: boolean
}

/**
 * Owns one client per Unraid integration (`Map<integrationId, manager>`) and publishes each
 * on {@link unraidInstances} so the devices follow it. The caller reconciles it against the
 * live integration list at boot and on every integration lifecycle event.
 */
export class UnraidClientRegistry {
  readonly #logger: IScopedLogger
  readonly #deps: UnraidClientRegistryDeps
  readonly #entries = new Map<string, UnraidClientEntry>()

  constructor(logger: IScopedLogger, deps: UnraidClientRegistryDeps) {
    this.#logger = logger
    this.#deps = deps
  }

  /**
   * Ensure a client runs for `integrationId` with this connection. An unchanged connection
   * keeps the running client; a changed one replaces it. Never throws: a server that is off,
   * or an API key the keychain cannot serve right now, leaves the integration offline.
   */
  async upsert(
    integrationId: string,
    name: string,
    connection: UnraidConnectionConfig,
    apiKeyLocked: boolean,
  ): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing !== undefined) {
      if (
        existing.apiKeyLocked === apiKeyLocked &&
        sameConnection(existing.connection, connection)
      ) {
        return
      }
      await this.remove(integrationId)
    }
    const manager = new UnraidIntegrationManager({
      id: integrationId,
      name,
      connection,
      logger: this.#logger.withTags({ integrationId }),
      makeClient: this.#deps.makeClient,
      onConnected: () => {
        this.#deps.onConnected(integrationId)
      },
      onDisconnected: () => {
        this.#deps.onDisconnected(integrationId)
        unraidInstances.emitSnapshot(integrationId)
      },
      onPolled: () => {
        this.#deps.onPolled(integrationId)
      },
    })
    this.#entries.set(integrationId, { manager, connection, apiKeyLocked })
    unraidInstances.set(integrationId, manager)
    if (apiKeyLocked) {
      // Locked is never empty: do not connect with a blank key, run offline until it reads.
      this.#logger.warn('Unraid integration API key is stored but unreadable — staying offline', {
        meta: { integrationId },
      })
      this.#deps.onDisconnected(integrationId)
      return
    }
    try {
      await manager.start()
    } catch (err) {
      this.#logger.warn('Unraid integration connect failed — offline', {
        meta: { integrationId, error: errMsg(err) },
      })
      await manager.stop()
    }
  }

  async remove(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (entry === undefined) return
    this.#entries.delete(integrationId)
    unraidInstances.set(integrationId, null)
    await entry.manager.stop()
  }

  /** Stop every client whose integration is not in `keep`. */
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
