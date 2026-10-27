import type { EnpalIntegrationManager } from './enpal-integration-manager.js'
import type { EnpalSnapshot } from './enpal-snapshot.js'

/**
 * Per-integration registry that the adopted devices use to reach the live
 * {@link EnpalIntegrationManager}. Keyed on the integration id; the client registry publishes
 * a new manager here whenever the connection changes, and the sensors read through the
 * resolver so they follow it.
 */
export class EnpalConnectionResolver {
  readonly #managers = new Map<string, EnpalIntegrationManager>()
  readonly #subs = new Map<string, Set<() => void>>()

  set(integrationId: string, manager: EnpalIntegrationManager | null): void {
    if (manager === null) {
      this.#managers.delete(integrationId)
      return
    }
    this.#managers.set(integrationId, manager)
  }

  getManager(integrationId: string): EnpalIntegrationManager | null {
    return this.#managers.get(integrationId) ?? null
  }

  /** The latest snapshot, or null when the box is unreachable (never stale readings). */
  getSnapshot(integrationId: string): EnpalSnapshot | null {
    return this.#managers.get(integrationId)?.getSnapshot() ?? null
  }

  /** Subscribe to poll ticks (successful or not). Returns an unsubscribe function. */
  onSnapshot(integrationId: string, cb: () => void): () => void {
    let set = this.#subs.get(integrationId)
    if (set === undefined) {
      set = new Set()
      this.#subs.set(integrationId, set)
    }
    set.add(cb)
    return () => {
      const current = this.#subs.get(integrationId)
      current?.delete(cb)
      if (current !== undefined && current.size === 0) this.#subs.delete(integrationId)
    }
  }

  emitSnapshot(integrationId: string): void {
    const set = this.#subs.get(integrationId)
    if (set === undefined) return
    for (const cb of set) {
      try {
        cb()
      } catch {
        // one bad subscriber must not starve the others
      }
    }
  }

  clear(): void {
    this.#managers.clear()
    this.#subs.clear()
  }
}

export const enpalConnections = new EnpalConnectionResolver()
