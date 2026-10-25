import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  AlexaIntegrationManager,
  type AlexaBrokerInfo,
  type AlexaClientFactory,
} from './alexa-integration-manager.js'
import type { AlexaAppliance, AlexaCommand, AlexaStateValue } from './alexa-client.js'
import type { AlexaBrokerEntry, AlexaConnection } from './config.js'

/** Minimal manager surface the registry depends on. */
export type ManagerLike = Pick<
  AlexaIntegrationManager,
  | 'start'
  | 'stop'
  | 'applyConnection'
  | 'getInfo'
  | 'getConnection'
  | 'sendCommand'
  | 'poll'
  | 'refreshAppliances'
>

/** Factory for one manager — overridable in tests. */
export type ManagerFactory = (opts: {
  readonly id: string
  readonly name: string
  readonly connection: AlexaConnection
  readonly logger: IScopedLogger
  readonly onConnected: (id: string) => void
  readonly onDisconnected: (id: string) => void
  readonly onAuthFailed: (id: string, error: string) => void
  readonly onAppliancesChanged: (id: string, appliances: readonly AlexaAppliance[]) => void
  readonly onStatesPolled: (id: string, values: readonly AlexaStateValue[]) => void
}) => ManagerLike

export interface AlexaBrokerRegistryDeps {
  readonly onBrokerConnected?: (brokerId: string) => void
  readonly onBrokerDisconnected?: (brokerId: string) => void
  readonly onAuthFailed?: (brokerId: string, error: string) => void
  readonly onAppliancesChanged?: (brokerId: string, appliances: readonly AlexaAppliance[]) => void
  readonly onStatesPolled?: (brokerId: string, values: readonly AlexaStateValue[]) => void
  readonly makeManager?: ManagerFactory
  /** Client factory passed through to each manager (tests inject a fake). */
  readonly makeClient?: AlexaClientFactory
  /** Addon data dir for the live client's session persistence (optional). */
  readonly dataDir?: string
}

export type AlexaBrokerListItem = AlexaBrokerInfo

/**
 * Manages N live Alexa account connections ("brokers"), each backed by an
 * {@link AlexaIntegrationManager}. Allocates stable ids (`alexa_001`, …), CRUD,
 * an integration FK index, lifecycle helpers. Mirrors the Ecowitt / Matter
 * registry.
 */
export class AlexaBrokerRegistry {
  readonly #logger: IScopedLogger
  #onBrokerConnected: (id: string) => void
  #onBrokerDisconnected: (id: string) => void
  #onAuthFailed: (id: string, error: string) => void
  #onAppliancesChanged: (id: string, appliances: readonly AlexaAppliance[]) => void
  #onStatesPolled: (id: string, values: readonly AlexaStateValue[]) => void
  readonly #makeManager: ManagerFactory

  readonly #managers: Map<string, ManagerLike> = new Map()
  readonly #integrationToBroker: Map<string, string> = new Map()
  #nextId = 1

  constructor(logger: IScopedLogger, deps: AlexaBrokerRegistryDeps = {}) {
    this.#logger = logger
    this.#onBrokerConnected = deps.onBrokerConnected ?? (() => undefined)
    this.#onBrokerDisconnected = deps.onBrokerDisconnected ?? (() => undefined)
    this.#onAuthFailed = deps.onAuthFailed ?? (() => undefined)
    this.#onAppliancesChanged = deps.onAppliancesChanged ?? (() => undefined)
    this.#onStatesPolled = deps.onStatesPolled ?? (() => undefined)
    this.#makeManager =
      deps.makeManager ??
      ((opts) =>
        new AlexaIntegrationManager({
          id: opts.id,
          name: opts.name,
          connection: opts.connection,
          logger: opts.logger,
          onConnected: opts.onConnected,
          onDisconnected: opts.onDisconnected,
          onAuthFailed: opts.onAuthFailed,
          onAppliancesChanged: opts.onAppliancesChanged,
          onStatesPolled: opts.onStatesPolled,
          ...(deps.makeClient !== undefined ? { makeClient: deps.makeClient } : {}),
          ...(deps.dataDir !== undefined ? { dataDir: deps.dataDir } : {}),
        }))
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async restore(entries: readonly AlexaBrokerEntry[]): Promise<void> {
    for (const entry of entries) this.#seedCounter(entry.id)
    for (const entry of entries) {
      try {
        await this.#startManager(entry)
      } catch (err: unknown) {
        this.#logger.warn('AlexaBrokerRegistry: failed to restore manager', {
          tags: { brokerId: entry.id },
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  async shutdown(): Promise<void> {
    const ids = Array.from(this.#managers.keys())
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.#managers.get(id)?.stop()
        } catch (err: unknown) {
          this.#logger.warn('AlexaBrokerRegistry: shutdown stop failed', {
            tags: { brokerId: id },
            meta: { error: errMsg(err) },
          })
        }
      }),
    )
    this.#managers.clear()
    this.#integrationToBroker.clear()
  }

  setOnBrokerConnected(cb: (brokerId: string) => void): void {
    this.#onBrokerConnected = cb
  }
  setOnBrokerDisconnected(cb: (brokerId: string) => void): void {
    this.#onBrokerDisconnected = cb
  }
  setOnAuthFailed(cb: (brokerId: string, error: string) => void): void {
    this.#onAuthFailed = cb
  }
  setOnAppliancesChanged(
    cb: (brokerId: string, appliances: readonly AlexaAppliance[]) => void,
  ): void {
    this.#onAppliancesChanged = cb
  }
  setOnStatesPolled(cb: (brokerId: string, values: readonly AlexaStateValue[]) => void): void {
    this.#onStatesPolled = cb
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async createEntry(
    name: string,
    connection: AlexaConnection,
    opts: { readonly integrationId?: string } = {},
  ): Promise<AlexaBrokerEntry> {
    const id = this.#allocateId()
    const entry: AlexaBrokerEntry = {
      id,
      name,
      connection,
      ...(opts.integrationId !== undefined ? { integrationId: opts.integrationId } : {}),
    }
    await this.#startManager(entry)
    if (opts.integrationId !== undefined) this.#integrationToBroker.set(opts.integrationId, id)
    return entry
  }

  async removeEntry(id: string): Promise<void> {
    const mgr = this.#managers.get(id)
    if (!mgr) throw new Error(`AlexaBrokerRegistry: unknown broker id "${id}"`)
    for (const [integrationId, brokerId] of this.#integrationToBroker.entries()) {
      if (brokerId === id) this.#integrationToBroker.delete(integrationId)
    }
    this.#managers.delete(id)
    try {
      await mgr.stop()
    } catch (err: unknown) {
      this.#logger.warn('AlexaBrokerRegistry: removeEntry stop failed', {
        tags: { brokerId: id },
        meta: { error: errMsg(err) },
      })
    }
  }

  async updateEntry(id: string, connection: AlexaConnection): Promise<AlexaBrokerEntry> {
    const mgr = this.#managers.get(id)
    if (!mgr) throw new Error(`AlexaBrokerRegistry: unknown broker id "${id}"`)
    await mgr.applyConnection(connection)
    const info = mgr.getInfo()
    return { id, name: info.name, connection }
  }

  // ── Command passthrough ────────────────────────────────────────────────

  async sendCommand(brokerId: string, command: AlexaCommand): Promise<void> {
    const mgr = this.#managers.get(brokerId)
    if (!mgr) throw new Error(`AlexaBrokerRegistry: unknown broker id "${brokerId}"`)
    await mgr.sendCommand(command)
  }

  // ── Integration index ─────────────────────────────────────────────────────

  linkIntegration(integrationId: string, brokerId: string): void {
    this.#integrationToBroker.set(integrationId, brokerId)
  }

  // ── Read helpers ──────────────────────────────────────────────────────────

  list(): AlexaBrokerListItem[] {
    return Array.from(this.#managers.values()).map((m) => m.getInfo())
  }

  get(id: string): AlexaBrokerListItem | null {
    return this.#managers.get(id)?.getInfo() ?? null
  }

  getConnection(id: string): AlexaConnection | null {
    return this.#managers.get(id)?.getConnection() ?? null
  }

  size(): number {
    return this.#managers.size
  }

  connectedCount(): number {
    let count = 0
    for (const mgr of this.#managers.values()) {
      if (mgr.getInfo().status === 'connected') count++
    }
    return count
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  async #startManager(entry: AlexaBrokerEntry): Promise<void> {
    if (this.#managers.has(entry.id)) {
      if (entry.integrationId !== undefined) {
        this.#integrationToBroker.set(entry.integrationId, entry.id)
      }
      return
    }
    const mgr = this.#makeManager({
      id: entry.id,
      name: entry.name,
      connection: entry.connection,
      logger: this.#logger,
      onConnected: (id: string) => this.#onBrokerConnected(id),
      onDisconnected: (id: string) => this.#onBrokerDisconnected(id),
      onAuthFailed: (id: string, error: string) => this.#onAuthFailed(id, error),
      onAppliancesChanged: (id: string, appliances: readonly AlexaAppliance[]) =>
        this.#onAppliancesChanged(id, appliances),
      onStatesPolled: (id: string, values: readonly AlexaStateValue[]) =>
        this.#onStatesPolled(id, values),
    })
    this.#managers.set(entry.id, mgr)
    if (entry.integrationId !== undefined) {
      this.#integrationToBroker.set(entry.integrationId, entry.id)
    }
    await mgr.start()
  }

  #allocateId(): string {
    const id = `alexa_${String(this.#nextId).padStart(3, '0')}`
    this.#nextId++
    return id
  }

  #seedCounter(id: string): void {
    const match = /^alexa_(\d+)$/.exec(id)
    if (match === null || match[1] === undefined) return
    const n = parseInt(match[1], 10)
    if (!isNaN(n)) this.#nextId = Math.max(this.#nextId, n + 1)
  }
}
