import type { UnraidSnapshot } from './unraid-client-contract.js'
import type { UnraidIntegrationManager } from './unraid-integration-manager.js'

/**
 * Per-instance registry that device classes use to reach the live
 * {@link UnraidIntegrationManager} (and its latest snapshot) for a given Unraid
 * instance. Keyed on the instance {@link import('@camstack/types').DeviceType.Hub}
 * device's `stableId` (standalone mode — the connection lives on the Hub device,
 * not a broker). Mirrors the Velux `VeluxNodeResolver` / Ecowitt `ecowittFacades`.
 *
 * The Hub recreates the manager on reconnect / settings change and re-publishes
 * it here; entity children always read through the resolver, so they
 * transparently pick up the new manager + fresh snapshot.
 */
export class UnraidNodeResolver {
  readonly #managers: Map<string, UnraidIntegrationManager> = new Map()
  /**
   * Per-instance poll-tick fan-out. Entity children subscribe here instead of
   * attaching a listener per child — the Hub pumps this bus once per poll cycle.
   * A plain `Set` of callbacks has no listener limit.
   */
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the manager for an instance id. `null` removes the entry. */
  set(instanceId: string, manager: UnraidIntegrationManager | null): void {
    if (manager === null) {
      this.#managers.delete(instanceId)
      return
    }
    this.#managers.set(instanceId, manager)
  }

  /** The live manager for an instance id, or null when unknown / stopped. */
  getManager(instanceId: string): UnraidIntegrationManager | null {
    return this.#managers.get(instanceId) ?? null
  }

  /** The most-recent snapshot for an instance id, or null. */
  getSnapshot(instanceId: string): UnraidSnapshot | null {
    return this.#managers.get(instanceId)?.getSnapshot() ?? null
  }

  /** Subscribe a child to per-instance poll ticks. Returns an unsubscribe fn. */
  onSnapshot(instanceId: string, cb: () => void): () => void {
    let set = this.#snapshotSubs.get(instanceId)
    if (!set) {
      set = new Set()
      this.#snapshotSubs.set(instanceId, set)
    }
    set.add(cb)
    return () => {
      const current = this.#snapshotSubs.get(instanceId)
      current?.delete(cb)
      if (current && current.size === 0) this.#snapshotSubs.delete(instanceId)
    }
  }

  /** Fan a single poll tick out to every subscribed child for an instance. */
  emitSnapshot(instanceId: string): void {
    const set = this.#snapshotSubs.get(instanceId)
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

/** The single in-process per-instance manager resolver shared between the Hub
 *  device and its entity children. */
export const unraidInstances = new UnraidNodeResolver()
