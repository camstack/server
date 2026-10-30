import { errMsg, type IScopedLogger } from '@camstack/types'
import { type RademacherConnectionConfig, sameRademacherConnection } from './config.js'
import {
  type RademacherClientFactory,
  RademacherIntegrationManager,
} from './rademacher-integration-manager.js'
import { rademacherSessions } from './rademacher-session-resolver.js'

export interface RademacherClientRegistryDeps {
  readonly onConnected?: (integrationId: string) => void
  readonly onDisconnected?: (integrationId: string) => void
  readonly makeClient?: RademacherClientFactory
}

interface RademacherClientEntry {
  readonly name: string
  readonly manager: RademacherIntegrationManager
  readonly connection: RademacherConnectionConfig
}

/**
 * One live hub session per enabled integration. Every manager is published on
 * {@link rademacherSessions} while it is registered, so the devices of that
 * integration reach their covers and commands through the resolver.
 */
export class RademacherClientRegistry {
  readonly #logger: IScopedLogger
  #onConnected: (integrationId: string) => void
  #onDisconnected: (integrationId: string) => void
  readonly #makeClient: RademacherClientFactory | undefined
  readonly #entries: Map<string, RademacherClientEntry> = new Map()

  constructor(logger: IScopedLogger, deps: RademacherClientRegistryDeps = {}) {
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
    connection: RademacherConnectionConfig,
  ): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing) {
      if (sameRademacherConnection(existing.connection, connection)) {
        if (existing.name !== name) this.#entries.set(integrationId, { ...existing, name })
        return
      }
      try {
        await existing.manager.applyConnection(connection, name)
        this.#entries.set(integrationId, { name, manager: existing.manager, connection })
      } catch (err: unknown) {
        this.#logger.warn('RademacherClientRegistry: applyConnection failed', {
          tags: { integrationId },
          meta: { error: errMsg(err) },
        })
      }
      return
    }

    const manager = new RademacherIntegrationManager({
      id: integrationId,
      name,
      connection,
      logger: this.#logger,
      onConnected: (id) => this.#onConnected(id),
      onDisconnected: (id) => this.#onDisconnected(id),
      onPolled: (id) => rademacherSessions.emitSnapshot(id),
      ...(this.#makeClient === undefined ? {} : { makeClient: this.#makeClient }),
    })
    this.#entries.set(integrationId, { name, manager, connection })
    rademacherSessions.set(integrationId, manager)
    // start() never throws: a hub that is down is retried with backoff.
    await manager.start()
  }

  async remove(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (!entry) return
    this.#entries.delete(integrationId)
    rademacherSessions.set(integrationId, null)
    try {
      await entry.manager.stop()
    } catch (err: unknown) {
      this.#logger.warn('RademacherClientRegistry: remove stop failed', {
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
    rademacherSessions.clear()
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

  getManager(integrationId: string): RademacherIntegrationManager | null {
    return this.#entries.get(integrationId)?.manager ?? null
  }
}
