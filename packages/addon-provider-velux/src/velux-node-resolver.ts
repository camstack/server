import type { VeluxNode } from './velux-client-contract.js'
import type { VeluxIntegrationManager } from './velux-integration-manager.js'

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
  readonly #managers: Map<string, VeluxIntegrationManager> = new Map()
  /**
   * Per-gateway poll-tick fan-out. Cover children subscribe here instead of
   * attaching a listener per child — the gateway device pumps this bus once per
   * poll cycle. A plain `Set` of callbacks has no listener limit.
   */
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the manager for a gateway id. `null` removes the entry. */
  set(gatewayId: string, manager: VeluxIntegrationManager | null): void {
    if (manager === null) {
      this.#managers.delete(gatewayId)
      return
    }
    this.#managers.set(gatewayId, manager)
  }

  /** The live manager for a gateway id, or null when unknown / stopped. */
  getManager(gatewayId: string): VeluxIntegrationManager | null {
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
