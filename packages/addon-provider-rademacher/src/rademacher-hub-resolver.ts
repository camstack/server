import type { CoverDevice } from '@apocaliss92/noderademacher'
import type { RademacherIntegrationManager } from './rademacher-integration-manager.js'

/**
 * Per-hub registry that device classes use to reach the live
 * {@link RademacherIntegrationManager} (and its cover handles) for a given hub.
 * Keyed on the hub {@link import('@camstack/types').DeviceType.Hub} device's
 * `stableId` (standalone mode — the connection lives on the hub device, not a
 * broker). Mirrors the Ecowitt `EcowittFacadeResolver`.
 *
 * The hub device recreates the manager on reconnect / settings change and
 * re-publishes it here; cover children always read through the resolver, so they
 * transparently pick up the new manager.
 */
export class RademacherHubResolver {
  readonly #managers: Map<string, RademacherIntegrationManager> = new Map()
  /**
   * Per-hub poll-tick fan-out. Cover children subscribe here instead of
   * attaching a listener per child — the hub device pumps this bus once per poll
   * cycle. A plain `Set` of callbacks has no listener limit.
   */
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the manager for a hub id. `null` removes the entry. */
  set(hubId: string, manager: RademacherIntegrationManager | null): void {
    if (manager === null) {
      this.#managers.delete(hubId)
      return
    }
    this.#managers.set(hubId, manager)
  }

  /** The live manager for a hub id, or null when unknown / stopped. */
  getManager(hubId: string): RademacherIntegrationManager | null {
    return this.#managers.get(hubId) ?? null
  }

  /** All cover handles for a hub id, or [] when unknown. */
  getCovers(hubId: string): readonly CoverDevice[] {
    return this.#managers.get(hubId)?.getCovers() ?? []
  }

  /** Resolve a single cover handle by HomePilot device id for a hub, or null. */
  getCover(hubId: string, did: string): CoverDevice | null {
    return this.#managers.get(hubId)?.getCover(did) ?? null
  }

  /** Subscribe a child to per-hub poll ticks. Returns an unsubscribe fn. */
  onSnapshot(hubId: string, cb: () => void): () => void {
    let set = this.#snapshotSubs.get(hubId)
    if (!set) {
      set = new Set()
      this.#snapshotSubs.set(hubId, set)
    }
    set.add(cb)
    return () => {
      const current = this.#snapshotSubs.get(hubId)
      current?.delete(cb)
      if (current && current.size === 0) this.#snapshotSubs.delete(hubId)
    }
  }

  /** Fan a single poll tick out to every subscribed child for a hub. */
  emitSnapshot(hubId: string): void {
    const set = this.#snapshotSubs.get(hubId)
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

/** The single in-process per-hub manager resolver shared between the hub device
 *  and its cover children. */
export const rademacherHubs = new RademacherHubResolver()
