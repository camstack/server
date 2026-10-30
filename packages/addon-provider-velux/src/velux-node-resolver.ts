import type { VeluxConnectionConfig } from './config.js'
import type { VeluxGatewayClient, VeluxNode } from './velux-client-contract.js'

/** Status of one gateway session. */
export type VeluxGatewayStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** What the resolver needs from a gateway manager. */
export type VeluxNodeSource = {
  getNodes(): readonly VeluxNode[]
  getNode(nodeId: number): VeluxNode | null
  /** The connection the manager runs on (the gateway device reads the host from it). */
  getConnection(): VeluxConnectionConfig
  readonly status: VeluxGatewayStatus
  /** Firmware the gateway reported on its last connect, or null while unknown. */
  readonly firmware: string | null
  readonly client: VeluxGatewayClient | null
}

/** How a child names its node: the serial when the gateway reported one, else the node id. */
export interface VeluxNodeRef {
  readonly serial: string
  readonly nodeId: number
}

/**
 * Per-integration registry that device classes use to reach the live
 * {@link VeluxIntegrationManager} (and its node handles). Keyed on the
 * INTEGRATION id: the connection lives on the integration, and every device of a
 * gateway (the gateway box, covers, rain sensors) carries that id in its config.
 *
 * The client registry publishes a manager here when an integration starts and
 * removes it when the integration goes; devices always read through the
 * resolver, so they transparently pick up a replaced manager.
 */
export class VeluxNodeResolver {
  readonly #managers: Map<string, VeluxNodeSource> = new Map()
  /**
   * Per-integration change fan-out. Devices subscribe here instead of attaching a
   * listener per device — the manager pumps this bus on every node push,
   * (re)connect and drop. A plain `Set` of callbacks has no listener limit.
   */
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the manager for an integration id. `null` removes the entry. */
  set(integrationId: string, manager: VeluxNodeSource | null): void {
    if (manager === null) {
      this.#managers.delete(integrationId)
      return
    }
    this.#managers.set(integrationId, manager)
  }

  /** The live manager for an integration id, or null when unknown / stopped. */
  getManager(integrationId: string): VeluxNodeSource | null {
    return this.#managers.get(integrationId) ?? null
  }

  /** All node handles for an integration id, or [] when unknown. */
  getNodes(integrationId: string): readonly VeluxNode[] {
    return this.#managers.get(integrationId)?.getNodes() ?? []
  }

  /** Resolve a single node handle by node id for an integration, or null. */
  getNode(integrationId: string, nodeId: number): VeluxNode | null {
    return this.#managers.get(integrationId)?.getNode(nodeId) ?? null
  }

  /**
   * Resolve a child's node. The serial is the identity (a node id is a reusable
   * index), so a renumbered node is still found; the node id only serves nodes
   * the gateway reported no serial for.
   */
  findNode(integrationId: string, ref: VeluxNodeRef): VeluxNode | null {
    const nodes = this.getNodes(integrationId)
    if (ref.serial.length > 0) return nodes.find((n) => n.serial === ref.serial) ?? null
    return nodes.find((n) => n.serial.length === 0 && n.nodeId === ref.nodeId) ?? null
  }

  /** Subscribe a child to the integration's change ticks. Returns an unsubscribe fn. */
  onSnapshot(integrationId: string, cb: () => void): () => void {
    let set = this.#snapshotSubs.get(integrationId)
    if (!set) {
      set = new Set()
      this.#snapshotSubs.set(integrationId, set)
    }
    set.add(cb)
    return () => {
      const current = this.#snapshotSubs.get(integrationId)
      current?.delete(cb)
      if (current && current.size === 0) this.#snapshotSubs.delete(integrationId)
    }
  }

  /** Fan a change tick out to every subscribed device of an integration. */
  emitSnapshot(integrationId: string): void {
    const set = this.#snapshotSubs.get(integrationId)
    if (!set) return
    for (const cb of set) {
      try {
        cb()
      } catch {
        // best-effort — one bad subscriber must not starve the others
      }
    }
  }

  /** Remove all registered managers (called on full shutdown). */
  clear(): void {
    this.#managers.clear()
    this.#snapshotSubs.clear()
  }
}

/** The single in-process per-integration manager resolver shared by the devices of a gateway. */
export const veluxGateways = new VeluxNodeResolver()
