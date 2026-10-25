import type { VeSyncPurifierSnapshot } from './vesync-client-contract.js'
import type { VeSyncIntegrationManager } from './vesync-integration-manager.js'

/**
 * Per-account registry that device classes use to reach the live
 * {@link VeSyncIntegrationManager} (and its purifier snapshots) for a given
 * account. Keyed on the account {@link import('@camstack/types').DeviceType.Hub}
 * device's `stableId` (standalone mode — the credentials live on the account
 * device, not a broker). Mirrors the Velux `VeluxNodeResolver`.
 *
 * The account device recreates the manager on reconnect / settings change and
 * re-publishes it here; purifier children (and their accessory grandchildren)
 * always read through the resolver, so they transparently pick up the new
 * manager.
 */
export class VeSyncAccountResolver {
  readonly #managers: Map<string, VeSyncIntegrationManager> = new Map()
  /**
   * Per-account poll-tick fan-out. Purifier children (and their accessory
   * children) subscribe here instead of attaching a listener per child — the
   * account device pumps this bus once per poll cycle. A plain `Set` of
   * callbacks has no listener limit.
   */
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the manager for an account id. `null` removes the entry. */
  set(accountId: string, manager: VeSyncIntegrationManager | null): void {
    if (manager === null) {
      this.#managers.delete(accountId)
      return
    }
    this.#managers.set(accountId, manager)
  }

  /** The live manager for an account id, or null when unknown / stopped. */
  getManager(accountId: string): VeSyncIntegrationManager | null {
    return this.#managers.get(accountId) ?? null
  }

  /** All purifier snapshots for an account id, or [] when unknown. */
  getPurifiers(accountId: string): readonly VeSyncPurifierSnapshot[] {
    return this.#managers.get(accountId)?.getPurifiers() ?? []
  }

  /** Resolve a single purifier snapshot by native id for an account, or null. */
  getPurifier(accountId: string, nativeId: string): VeSyncPurifierSnapshot | null {
    return this.#managers.get(accountId)?.getPurifier(nativeId) ?? null
  }

  /** Subscribe a child to per-account poll ticks. Returns an unsubscribe fn. */
  onSnapshot(accountId: string, cb: () => void): () => void {
    let set = this.#snapshotSubs.get(accountId)
    if (!set) {
      set = new Set()
      this.#snapshotSubs.set(accountId, set)
    }
    set.add(cb)
    return () => {
      const current = this.#snapshotSubs.get(accountId)
      current?.delete(cb)
      if (current && current.size === 0) this.#snapshotSubs.delete(accountId)
    }
  }

  /** Fan a single poll tick out to every subscribed child for an account. */
  emitSnapshot(accountId: string): void {
    const set = this.#snapshotSubs.get(accountId)
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

/** The single in-process per-account manager resolver shared between the account
 *  device and its purifier children. */
export const vesyncAccounts = new VeSyncAccountResolver()
