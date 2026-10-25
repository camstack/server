import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  MatterIntegrationManager,
  type MatterBrokerInfo,
  type MatterControllerFactory,
} from './matter-integration-manager.js'
import type {
  MatterAttributeReport,
  MatterCommandInvocation,
  MatterNodeSnapshot,
} from './matter-controller.js'
import type { MatterBrokerEntry, MatterConnection } from './config.js'

/** Minimal manager surface the registry depends on. */
export type ManagerLike = Pick<
  MatterIntegrationManager,
  | 'start'
  | 'stop'
  | 'applyConnection'
  | 'getInfo'
  | 'getConnection'
  | 'commissionNode'
  | 'removeNode'
  | 'reconcile'
  | 'invokeCommand'
>

/** Factory for one manager — overridable in tests. */
export type ManagerFactory = (opts: {
  readonly id: string
  readonly name: string
  readonly connection: MatterConnection
  readonly dataDir: string
  readonly logger: IScopedLogger
  readonly onConnected: (id: string) => void
  readonly onDisconnected: (id: string) => void
  readonly onNodesChanged: (id: string, nodes: readonly MatterNodeSnapshot[]) => void
  readonly onAttributeReport: (id: string, report: MatterAttributeReport) => void
}) => ManagerLike

export interface MatterBrokerRegistryDeps {
  readonly dataDir: string
  readonly onBrokerConnected?: (brokerId: string) => void
  readonly onBrokerDisconnected?: (brokerId: string) => void
  readonly onNodesChanged?: (brokerId: string, nodes: readonly MatterNodeSnapshot[]) => void
  readonly onAttributeReport?: (brokerId: string, report: MatterAttributeReport) => void
  readonly makeManager?: ManagerFactory
  /** Controller factory passed through to each manager (tests inject a fake). */
  readonly makeController?: MatterControllerFactory
}

export type MatterBrokerListItem = MatterBrokerInfo

/**
 * Manages N live Matter fabric connections ("brokers"), each backed by a
 * {@link MatterIntegrationManager}. Allocates stable ids (`matter_001`, …), CRUD,
 * an integration FK index, lifecycle helpers. Mirrors the Ecowitt / Dreame
 * registry. Because `instanceMode` is `unique`, the common case is exactly one
 * fabric, but the namespace tolerates multiple.
 */
export class MatterBrokerRegistry {
  readonly #logger: IScopedLogger
  readonly #dataDir: string
  #onBrokerConnected: (id: string) => void
  #onBrokerDisconnected: (id: string) => void
  #onNodesChanged: (id: string, nodes: readonly MatterNodeSnapshot[]) => void
  #onAttributeReport: (id: string, report: MatterAttributeReport) => void
  readonly #makeManager: ManagerFactory

  readonly #managers: Map<string, ManagerLike> = new Map()
  readonly #integrationToBroker: Map<string, string> = new Map()
  #nextId = 1

  constructor(logger: IScopedLogger, deps: MatterBrokerRegistryDeps) {
    this.#logger = logger
    this.#dataDir = deps.dataDir
    this.#onBrokerConnected = deps.onBrokerConnected ?? (() => undefined)
    this.#onBrokerDisconnected = deps.onBrokerDisconnected ?? (() => undefined)
    this.#onNodesChanged = deps.onNodesChanged ?? (() => undefined)
    this.#onAttributeReport = deps.onAttributeReport ?? (() => undefined)
    this.#makeManager =
      deps.makeManager ??
      ((opts) =>
        new MatterIntegrationManager({
          id: opts.id,
          name: opts.name,
          connection: opts.connection,
          dataDir: opts.dataDir,
          logger: opts.logger,
          onConnected: opts.onConnected,
          onDisconnected: opts.onDisconnected,
          onNodesChanged: opts.onNodesChanged,
          onAttributeReport: opts.onAttributeReport,
          ...(deps.makeController !== undefined ? { makeController: deps.makeController } : {}),
        }))
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async restore(entries: readonly MatterBrokerEntry[]): Promise<void> {
    for (const entry of entries) this.#seedCounter(entry.id)
    for (const entry of entries) {
      try {
        await this.#startManager(entry)
      } catch (err: unknown) {
        this.#logger.warn('MatterBrokerRegistry: failed to restore manager', {
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
          this.#logger.warn('MatterBrokerRegistry: shutdown stop failed', {
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
  setOnNodesChanged(cb: (brokerId: string, nodes: readonly MatterNodeSnapshot[]) => void): void {
    this.#onNodesChanged = cb
  }
  setOnAttributeReport(cb: (brokerId: string, report: MatterAttributeReport) => void): void {
    this.#onAttributeReport = cb
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async createEntry(
    name: string,
    connection: MatterConnection,
    opts: { readonly integrationId?: string } = {},
  ): Promise<MatterBrokerEntry> {
    const id = this.#allocateId()
    const entry: MatterBrokerEntry = {
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
    if (!mgr) throw new Error(`MatterBrokerRegistry: unknown broker id "${id}"`)
    for (const [integrationId, brokerId] of this.#integrationToBroker.entries()) {
      if (brokerId === id) this.#integrationToBroker.delete(integrationId)
    }
    this.#managers.delete(id)
    try {
      await mgr.stop()
    } catch (err: unknown) {
      this.#logger.warn('MatterBrokerRegistry: removeEntry stop failed', {
        tags: { brokerId: id },
        meta: { error: errMsg(err) },
      })
    }
  }

  async updateEntry(id: string, connection: MatterConnection): Promise<MatterBrokerEntry> {
    const mgr = this.#managers.get(id)
    if (!mgr) throw new Error(`MatterBrokerRegistry: unknown broker id "${id}"`)
    await mgr.applyConnection(connection)
    const info = mgr.getInfo()
    return { id, name: info.name, connection }
  }

  // ── Commissioning passthrough ──────────────────────────────────────────

  async commissionNode(brokerId: string, pairingCode: string): Promise<{ nodeId: string }> {
    const mgr = this.#managers.get(brokerId)
    if (!mgr) throw new Error(`MatterBrokerRegistry: unknown broker id "${brokerId}"`)
    return mgr.commissionNode(pairingCode)
  }

  async removeNode(brokerId: string, nodeId: string): Promise<void> {
    const mgr = this.#managers.get(brokerId)
    if (!mgr) throw new Error(`MatterBrokerRegistry: unknown broker id "${brokerId}"`)
    await mgr.removeNode(nodeId)
  }

  /** Route an outbound cluster command to the broker's live controller. */
  async invokeCommand(brokerId: string, invocation: MatterCommandInvocation): Promise<void> {
    const mgr = this.#managers.get(brokerId)
    if (!mgr) throw new Error(`MatterBrokerRegistry: unknown broker id "${brokerId}"`)
    await mgr.invokeCommand(invocation)
  }

  // ── Integration index ─────────────────────────────────────────────────────

  linkIntegration(integrationId: string, brokerId: string): void {
    this.#integrationToBroker.set(integrationId, brokerId)
  }

  // ── Read helpers ──────────────────────────────────────────────────────────

  list(): MatterBrokerListItem[] {
    return Array.from(this.#managers.values()).map((m) => m.getInfo())
  }

  get(id: string): MatterBrokerListItem | null {
    return this.#managers.get(id)?.getInfo() ?? null
  }

  getConnection(id: string): MatterConnection | null {
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

  async #startManager(entry: MatterBrokerEntry): Promise<void> {
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
      dataDir: this.#dataDir,
      logger: this.#logger,
      onConnected: (id: string) => this.#onBrokerConnected(id),
      onDisconnected: (id: string) => this.#onBrokerDisconnected(id),
      onNodesChanged: (id: string, nodes: readonly MatterNodeSnapshot[]) =>
        this.#onNodesChanged(id, nodes),
      onAttributeReport: (id: string, report: MatterAttributeReport) =>
        this.#onAttributeReport(id, report),
    })
    this.#managers.set(entry.id, mgr)
    if (entry.integrationId !== undefined) {
      this.#integrationToBroker.set(entry.integrationId, entry.id)
    }
    await mgr.start()
  }

  #allocateId(): string {
    const id = `matter_${String(this.#nextId).padStart(3, '0')}`
    this.#nextId++
    return id
  }

  #seedCounter(id: string): void {
    const match = /^matter_(\d+)$/.exec(id)
    if (match === null || match[1] === undefined) return
    const n = parseInt(match[1], 10)
    if (!isNaN(n)) this.#nextId = Math.max(this.#nextId, n + 1)
  }
}
