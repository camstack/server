import type { CoverDevice } from '@apocaliss92/noderademacher'
import type { RademacherIntegrationManager } from './rademacher-integration-manager.js'

/**
 * Per-integration registry that device classes use to reach the live
 * {@link RademacherIntegrationManager} (and its cover handles) of their
 * integration. Keyed on the integration id: the connection lives on the
 * integration, so the gateway box and every cover of one integration read the
 * same session.
 *
 * The client registry publishes the manager here while the integration is
 * enabled and removes it when it goes away; devices always read through the
 * resolver, so they transparently pick up a rebuilt manager.
 */
export class RademacherSessionResolver {
  readonly #managers: Map<string, RademacherIntegrationManager> = new Map()
  /**
   * Per-integration poll-tick fan-out. Devices subscribe here instead of
   * attaching a listener per device — the manager pumps this once per poll
   * cycle. A plain `Set` of callbacks has no listener limit.
   */
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the manager for an integration id. `null` removes the entry. */
  set(integrationId: string, manager: RademacherIntegrationManager | null): void {
    if (manager === null) {
      this.#managers.delete(integrationId)
      return
    }
    this.#managers.set(integrationId, manager)
  }

  /** The live manager for an integration id, or null when unknown / stopped. */
  getManager(integrationId: string): RademacherIntegrationManager | null {
    return this.#managers.get(integrationId) ?? null
  }

  /** All cover handles of an integration, or [] when unknown. */
  getCovers(integrationId: string): readonly CoverDevice[] {
    return this.#managers.get(integrationId)?.getCovers() ?? []
  }

  /** Resolve a single cover handle by HomePilot device id, or null. */
  getCover(integrationId: string, did: string): CoverDevice | null {
    return this.#managers.get(integrationId)?.getCover(did) ?? null
  }

  /** Subscribe a device to per-integration poll ticks. Returns an unsubscribe fn. */
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

  /** Fan a single poll tick out to every subscribed device of an integration. */
  emitSnapshot(integrationId: string): void {
    const set = this.#snapshotSubs.get(integrationId)
    if (!set) return
    for (const cb of [...set]) {
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

/** The single in-process resolver shared between the integration and its devices. */
export const rademacherSessions = new RademacherSessionResolver()
