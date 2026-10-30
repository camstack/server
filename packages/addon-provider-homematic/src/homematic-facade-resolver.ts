import type { Homematic } from 'nodehomematic'
import type { HmIntegrationManager } from './homematic-integration-manager.js'

/**
 * The part of a session the devices read: its state and the connection it runs
 * with. Both the real {@link HmIntegrationManager} and test fakes satisfy it.
 */
export type HmSessionView = Pick<HmIntegrationManager, 'getInfo' | 'getConnection'>

/**
 * Per-integration registry that device classes use to reach the live
 * `Homematic` facade (and the session state) of their CCU.
 *
 * The kernel constructs device classes through the `deviceClasses` map with
 * only a `DeviceContext` — it cannot thread the facade in as a constructor
 * arg. The connection lives on the INTEGRATION, so the CCU box and every device
 * adopted from it resolve the same session by `integrationId`. A device
 * persisted without an `integrationId` cannot be attributed to a CCU and
 * resolves nothing.
 */
export class HmFacadeResolver {
  readonly #facades: Map<string, Homematic> = new Map()
  readonly #sessions: Map<string, HmSessionView> = new Map()
  /** Per-integration state-change fan-out (connect, disconnect, error). */
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the facade for an integration id. `null` removes the entry. */
  set(integrationId: string, facade: Homematic | null): void {
    if (facade === null) {
      this.#facades.delete(integrationId)
      return
    }
    this.#facades.set(integrationId, facade)
  }

  /** The live facade for an integration id, or null when unknown / absent / not running. */
  get(integrationId?: string | null): Homematic | null {
    if (integrationId === undefined || integrationId === null) return null
    return this.#facades.get(integrationId) ?? null
  }

  /** Publish or remove the session (state + connection) for an integration id. */
  setSession(integrationId: string, session: HmSessionView | null): void {
    if (session === null) {
      this.#sessions.delete(integrationId)
      return
    }
    this.#sessions.set(integrationId, session)
  }

  /** The session of an integration, or null when it is not registered. */
  getSession(integrationId?: string | null): HmSessionView | null {
    if (integrationId === undefined || integrationId === null) return null
    return this.#sessions.get(integrationId) ?? null
  }

  /** Subscribe a device to the state changes of one integration. Returns an unsubscribe fn. */
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

  /** Fan one state change out to every subscribed device of an integration. */
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

  /** Remove everything (called on full shutdown). */
  clear(): void {
    this.#facades.clear()
    this.#sessions.clear()
    this.#snapshotSubs.clear()
  }
}

/** The single in-process resolver shared between the integration and its devices. */
export const homematicFacades = new HmFacadeResolver()
