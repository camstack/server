import type { VeluxGatewayClient, VeluxNode } from './velux-client-contract.js'

/** What the resolver needs from a gateway manager. */
export type VeluxNodeSource = {
  getNodes(): readonly VeluxNode[]
  getNode(nodeId: number): VeluxNode | null
  readonly client: VeluxGatewayClient | null
}

/** How a child names its node: the serial when the gateway reported one, else the node id. */
export interface VeluxNodeRef {
  readonly serial: string
  readonly nodeId: number
}

/**
 * Per-gateway registry that device classes use to reach the live
 * {@link VeluxIntegrationManager} (and its node handles) for a given gateway.
 * Keyed on the gateway {@link import('@camstack/types').DeviceType.Hub} device's
 * `stableId` (standalone mode — the connection lives on the gateway device, not a
 * broker). Mirrors the Rademacher `RademacherHubResolver`.
 *
 * The gateway device recreates the manager on reconnect / settings change and
 * re-publishes it here; cover children always read through the resolver, so they
 * transparently pick up the new manager.
 */
export class VeluxNodeResolver {
  readonly #managers: Map<string, VeluxNodeSource> = new Map()
  /**
   * Per-gateway poll-tick fan-out. Cover children subscribe here instead of
   * attaching a listener per child — the gateway device pumps this bus once per
   * poll cycle. A plain `Set` of callbacks has no listener limit.
   */
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the manager for a gateway id. `null` removes the entry. */
  set(gatewayId: string, manager: VeluxNodeSource | null): void {
    if (manager === null) {
      this.#managers.delete(gatewayId)
      return
    }
    this.#managers.set(gatewayId, manager)
  }

  /** The live manager for a gateway id, or null when unknown / stopped. */
  getManager(gatewayId: string): VeluxNodeSource | null {
    return this.#managers.get(gatewayId) ?? null
  }

  /** All node handles for a gateway id, or [] when unknown. */
  getNodes(gatewayId: string): readonly VeluxNode[] {
    return this.#managers.get(gatewayId)?.getNodes() ?? []
  }

  /** Resolve a single node handle by node id for a gateway, or null. */
  getNode(gatewayId: string, nodeId: number): VeluxNode | null {
    return this.#managers.get(gatewayId)?.getNode(nodeId) ?? null
  }

  /**
   * Resolve a child's node. The serial is the identity (a node id is a reusable
   * index), so a renumbered node is still found; the node id only serves nodes
   * the gateway reported no serial for.
   */
  findNode(gatewayId: string, ref: VeluxNodeRef): VeluxNode | null {
    const nodes = this.getNodes(gatewayId)
    if (ref.serial.length > 0) return nodes.find((n) => n.serial === ref.serial) ?? null
    return nodes.find((n) => n.serial.length === 0 && n.nodeId === ref.nodeId) ?? null
  }

  /** Subscribe a child to per-gateway poll ticks. Returns an unsubscribe fn. */
  onSnapshot(gatewayId: string, cb: () => void): () => void {
    let set = this.#snapshotSubs.get(gatewayId)
    if (!set) {
      set = new Set()
      this.#snapshotSubs.set(gatewayId, set)
    }
    set.add(cb)
    return () => {
      const current = this.#snapshotSubs.get(gatewayId)
      current?.delete(cb)
      if (current && current.size === 0) this.#snapshotSubs.delete(gatewayId)
    }
  }

  /** Fan a single poll tick out to every subscribed child for a gateway. */
  emitSnapshot(gatewayId: string): void {
    const set = this.#snapshotSubs.get(gatewayId)
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

/** The single in-process per-gateway manager resolver shared between the gateway
 *  device and its cover children. */
export const veluxGateways = new VeluxNodeResolver()
