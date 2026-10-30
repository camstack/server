import { errMsg, type IScopedLogger } from '@camstack/types'
import { sameVeluxConnection, type VeluxConnectionConfig } from './config.js'
import type { VeluxGatewayClientFactory } from './velux-client-contract.js'
import { VeluxIntegrationManager } from './velux-integration-manager.js'
import { veluxGateways } from './velux-node-resolver.js'

export interface VeluxClientRegistryDeps {
  readonly onConnected?: (integrationId: string) => void
  readonly onDisconnected?: (integrationId: string) => void
  readonly makeClient?: VeluxGatewayClientFactory
}

interface VeluxClientEntry {
  readonly name: string
  readonly manager: VeluxIntegrationManager
  readonly connection: VeluxConnectionConfig
}

/**
 * One live gateway session per enabled integration. Every manager is published
 * on {@link veluxGateways} while it is registered, so the devices of that
 * integration reach their nodes and commands through the resolver.
 */
export class VeluxClientRegistry {
  readonly #logger: IScopedLogger
  #onConnected: (integrationId: string) => void
  #onDisconnected: (integrationId: string) => void
  readonly #makeClient: VeluxGatewayClientFactory | undefined
  readonly #entries: Map<string, VeluxClientEntry> = new Map()

  constructor(logger: IScopedLogger, deps: VeluxClientRegistryDeps = {}) {
    this.#logger = logger
    this.#makeClient = deps.makeClient
    this.#onConnected = deps.onConnected ?? (() => undefined)
    this.#onDisconnected = deps.onDisconnected ?? (() => undefined)
  }

  setOnConnected(cb: (integrationId: string) => void): void {
    this.#onConnected = cb
  }

  setOnDisconnected(cb: (integrationId: string) => void): void {
    this.#onDisconnected = cb
  }

  async upsert(
    integrationId: string,
    name: string,
    connection: VeluxConnectionConfig,
  ): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing) {
      if (sameVeluxConnection(existing.connection, connection)) return
      try {
        await existing.manager.applyConnection(connection)
        this.#entries.set(integrationId, { name, manager: existing.manager, connection })
      } catch (err: unknown) {
        this.#logger.warn('VeluxClientRegistry: applyConnection failed', {
          tags: { integrationId },
          meta: { error: errMsg(err) },
        })
      }
      return
    }

    const manager = new VeluxIntegrationManager({
      id: integrationId,
      name,
      connection,
      logger: this.#logger,
      onConnected: (id) => this.#onConnected(id),
      onDisconnected: (id) => this.#onDisconnected(id),
      onNodesChanged: (id) => veluxGateways.emitSnapshot(id),
      ...(this.#makeClient === undefined ? {} : { makeClient: this.#makeClient }),
    })
    this.#entries.set(integrationId, { name, manager, connection })
    veluxGateways.set(integrationId, manager)
    // start() never throws: a gateway that is down is retried with backoff.
    await manager.start()
  }

  async remove(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (!entry) return
    this.#entries.delete(integrationId)
    veluxGateways.set(integrationId, null)
    try {
      await entry.manager.stop()
    } catch (err: unknown) {
      this.#logger.warn('VeluxClientRegistry: remove stop failed', {
        tags: { integrationId },
        meta: { error: errMsg(err) },
      })
    }
  }

  async retain(keep: ReadonlySet<string>): Promise<void> {
    const stale = [...this.#entries.keys()].filter((id) => !keep.has(id))
    for (const id of stale) await this.remove(id)
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.#entries.keys()]) await this.remove(id)
    veluxGateways.clear()
  }

  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  list(): readonly string[] {
    return [...this.#entries.keys()]
  }

  /** The operator's name for the integration, as last seen. */
  getName(integrationId: string): string | null {
    return this.#entries.get(integrationId)?.name ?? null
  }

  getManager(integrationId: string): VeluxIntegrationManager | null {
    return this.#entries.get(integrationId)?.manager ?? null
  }

  /**
   * Sessions this addon holds, or is opening, on `host`. The gateway accepts two
   * in total, so the connection test refuses to add a third.
   */
  liveSessions(host: string): number {
    let count = 0
    for (const { manager, connection } of this.#entries.values()) {
      if (connection.host !== host) continue
      if (manager.status === 'connected' || manager.status === 'connecting') count += 1
    }
    return count
  }
}
