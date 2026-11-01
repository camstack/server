import { errMsg, type IScopedLogger } from '@camstack/types'
import { sameConnection, type UnifiConnectionConfig } from './config.js'
import type { UnifiControllerClientFactory } from './unifi-client-contract.js'
import { UnifiIntegrationManager } from './unifi-integration-manager.js'
import { unifiControllers } from './unifi-node-resolver.js'

export interface UnifiClientRegistryDeps {
  /** First good poll after a failure (or after start). */
  readonly onConnected: (integrationId: string) => void
  /** The controller stopped answering, or never did. */
  readonly onDisconnected: (integrationId: string) => void
  /** Fired after every poll cycle: fan the snapshot out and reconcile the infra features. */
  readonly onPolled: (integrationId: string) => void
  readonly makeClient?: UnifiControllerClientFactory
}

interface UnifiClientEntry {
  readonly manager: UnifiIntegrationManager
  readonly connection: UnifiConnectionConfig
  readonly credentialsLocked: boolean
}

/**
 * Owns one client per UniFi integration (`Map<integrationId, manager>`) and publishes each
 * on {@link unifiControllers} so the devices follow it. The caller reconciles it against the
 * live integration list at boot and on every integration lifecycle event.
 */
export class UnifiClientRegistry {
  readonly #logger: IScopedLogger
  readonly #deps: UnifiClientRegistryDeps
  readonly #entries = new Map<string, UnifiClientEntry>()

  constructor(logger: IScopedLogger, deps: UnifiClientRegistryDeps) {
    this.#logger = logger
    this.#deps = deps
  }

  /**
   * Ensure a client runs for `integrationId` with this connection. An unchanged connection
   * keeps the running client; a changed one replaces it. Never throws: a controller that is
   * off, or a credential the keychain cannot serve right now, leaves the integration offline.
   */
  async upsert(
    integrationId: string,
    name: string,
    connection: UnifiConnectionConfig,
    credentialsLocked: boolean,
  ): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing !== undefined) {
      if (
        existing.credentialsLocked === credentialsLocked &&
        sameConnection(existing.connection, connection)
      ) {
        return
      }
      await this.remove(integrationId)
    }
    const manager = new UnifiIntegrationManager({
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
        unifiControllers.emitSnapshot(integrationId)
      },
      onPolled: () => {
        this.#deps.onPolled(integrationId)
      },
    })
    this.#entries.set(integrationId, { manager, connection, credentialsLocked })
    unifiControllers.set(integrationId, manager)
    if (credentialsLocked) {
      // Locked is never empty: do not connect with a blank credential, run offline until it reads.
      this.#logger.warn(
        'UniFi integration credentials are stored but unreadable — staying offline',
        {
          meta: { integrationId },
        },
      )
      this.#deps.onDisconnected(integrationId)
      return
    }
    try {
      await manager.start()
    } catch (err) {
      this.#logger.warn('UniFi integration connect failed — offline', {
        meta: { integrationId, error: errMsg(err) },
      })
      await manager.stop()
    }
  }

  async remove(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (entry === undefined) return
    this.#entries.delete(integrationId)
    unifiControllers.set(integrationId, null)
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
