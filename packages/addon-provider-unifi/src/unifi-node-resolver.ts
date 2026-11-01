import type { UnifiClientSnapshot, UnifiInfraSnapshot } from './unifi-client-contract.js'
import type { UnifiIntegrationManager } from './unifi-integration-manager.js'

/**
 * Per-controller registry that device classes use to reach the live
 * {@link UnifiIntegrationManager} (and its infra + client snapshots) for a given
 * controller. Keyed on the integration id
 * (`mode: account` — the connection lives on the integration, not on a device).
 * Mirrors the Velux `VeluxNodeResolver` / Ecowitt `EcowittFacadeResolver`.
 *
 * The client registry recreates the manager on reconnect / settings change and
 * re-publishes it here; infra + client children always read through the resolver,
 * so they transparently pick up the new manager.
 */
export class UnifiControllerResolver {
  readonly #managers: Map<string, UnifiIntegrationManager> = new Map()
  /**
   * Per-controller poll-tick fan-out. Children subscribe here instead of
   * attaching a listener per child — the controller device pumps this bus once
   * per poll cycle. A station with 100+ clients would otherwise trip Node's
   * default MaxListeners cap; a plain `Set` of callbacks has no listener limit.
   */
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the manager for a controller id. `null` removes the entry. */
  set(integrationId: string, manager: UnifiIntegrationManager | null): void {
    if (manager === null) {
      this.#managers.delete(integrationId)
      return
    }
    this.#managers.set(integrationId, manager)
  }

  /** The live manager for a controller id, or null when unknown / stopped. */
  getManager(integrationId: string): UnifiIntegrationManager | null {
    return this.#managers.get(integrationId) ?? null
  }

  /** All infra snapshots for a controller id, or [] when unknown. */
  getInfraList(integrationId: string): readonly UnifiInfraSnapshot[] {
    return this.#managers.get(integrationId)?.getInfraList() ?? []
  }

  /** Resolve a single infra snapshot for a controller, or null. */
  getInfra(integrationId: string, id: string): UnifiInfraSnapshot | null {
    return this.#managers.get(integrationId)?.getInfra(id) ?? null
  }

  /** All client snapshots for a controller id, or [] when unknown. */
  getClientList(integrationId: string): readonly UnifiClientSnapshot[] {
    return this.#managers.get(integrationId)?.getClientList() ?? []
  }

  /** Resolve a single client snapshot for a controller, or null. */
  getClient(integrationId: string, mac: string): UnifiClientSnapshot | null {
    return this.#managers.get(integrationId)?.getClient(mac) ?? null
  }

  /** Subscribe a child to per-controller poll ticks. Returns an unsubscribe fn. */
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

  /** Fan a single poll tick out to every subscribed child for a controller. */
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

/** The single in-process per-controller manager resolver shared between the
 *  controller device and its infra / client children. */
export const unifiControllers = new UnifiControllerResolver()
