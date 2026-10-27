import type { EnpalIntegrationManager } from './enpal-integration-manager.js'
import type { EnpalSnapshot } from './enpal-snapshot.js'

/**
 * Per-box registry that the adopted devices use to reach the live
 * {@link EnpalIntegrationManager}. Keyed on the box Hub device's `stableId`; the box
 * publishes a new manager here whenever its connection changes, and children read through
 * the resolver so they follow it.
 */
export class EnpalBoxResolver {
  readonly #managers = new Map<string, EnpalIntegrationManager>()
  readonly #subs = new Map<string, Set<() => void>>()

  set(boxId: string, manager: EnpalIntegrationManager | null): void {
    if (manager === null) {
      this.#managers.delete(boxId)
      return
    }
    this.#managers.set(boxId, manager)
  }

  getManager(boxId: string): EnpalIntegrationManager | null {
    return this.#managers.get(boxId) ?? null
  }

  /** The latest snapshot, or null when the box is unreachable (never stale readings). */
  getSnapshot(boxId: string): EnpalSnapshot | null {
    return this.#managers.get(boxId)?.getSnapshot() ?? null
  }

  /** Subscribe to poll ticks (successful or not). Returns an unsubscribe function. */
  onSnapshot(boxId: string, cb: () => void): () => void {
    let set = this.#subs.get(boxId)
    if (set === undefined) {
      set = new Set()
      this.#subs.set(boxId, set)
    }
    set.add(cb)
    return () => {
      const current = this.#subs.get(boxId)
      current?.delete(cb)
      if (current !== undefined && current.size === 0) this.#subs.delete(boxId)
    }
  }

  emitSnapshot(boxId: string): void {
    const set = this.#subs.get(boxId)
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

export const enpalBoxes = new EnpalBoxResolver()
