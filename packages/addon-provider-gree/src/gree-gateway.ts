import type { AcDevice, DiscoveredDevice } from '@apocaliss92/nodegree'

/**
 * A live Gree AC's connection surface: the bind-scan responder row(s) plus the
 * bound AC handle(s) (created via `Nodegree.createAc`) keyed by MAC. Unlike a
 * cloud library, Gree handles must be BOUND (a UDP AES handshake) before use, so
 * the per-device integration manager binds them and publishes them here keyed by
 * the device's `connectionKey`.
 */
export interface GreeConnectionSurface {
  /** Bind-scan responder rows (one per AC bound on this connection). */
  readonly discovered: readonly DiscoveredDevice[]
  /** Bound AC handles, keyed by MAC (lowercased). */
  readonly handles: ReadonlyMap<string, AcDevice>
}

/** Lowercase a MAC for stable map keying (Gree echoes mixed-case MACs). */
export function macKey(mac: string): string {
  return mac.toLowerCase()
}

/**
 * Per-connection registry that device classes use to reach a bound Gree AC handle
 * (and the bind-scan rows) for a given AC device (standalone mode — the
 * connection lives on the AC device, not a broker).
 *
 * The kernel constructs device classes with only a `DeviceContext` — it cannot
 * thread the handle in as a constructor arg. Like the Ecowitt / Dreame addon's
 * facade resolver, we keep it simple and in-process: the AC device's integration
 * manager owns the connection surface per `connectionKey` (the device's own
 * stableId) and publishes it here; the AC's accessory children resolve their live
 * `AcDevice` handle by `(connectionKey, mac)`.
 */
export class GreeConnectionResolver {
  readonly #surfaces: Map<string, GreeConnectionSurface> = new Map()
  /**
   * Per-connection "surface (re)published" subscribers. An AC accessory child
   * activates from `restoreDevices` BEFORE its parent's manager finishes the
   * async bind, so `getDevice` is null at `onActivate` time and its
   * `stateChanged` listener never attaches → the climate slice stays frozen at
   * cold-start (`lastFetchedAt: 0`, no temperature). Children subscribe here and
   * (re)attach + recompute once the handle is published. A plain `Set` has no
   * listener cap. Mirrors the Ecowitt facade-resolver fan-out.
   */
  readonly #subs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the connection surface for a connection key. `null` removes. */
  set(connectionKey: string, surface: GreeConnectionSurface | null): void {
    if (surface === null) {
      this.#surfaces.delete(connectionKey)
      return
    }
    this.#surfaces.set(connectionKey, surface)
    // Notify children that the bound handle is now available so they can
    // (re)attach their live listeners and seed their slices.
    const subs = this.#subs.get(connectionKey)
    if (subs) {
      for (const cb of subs) {
        try {
          cb()
        } catch {
          // best-effort — one bad subscriber must not starve the rest
        }
      }
    }
  }

  /** Subscribe to surface (re)publish for a connection key. Returns unsubscribe. */
  onSurface(connectionKey: string, cb: () => void): () => void {
    let set = this.#subs.get(connectionKey)
    if (!set) {
      set = new Set()
      this.#subs.set(connectionKey, set)
    }
    set.add(cb)
    return () => {
      const current = this.#subs.get(connectionKey)
      current?.delete(cb)
      if (current && current.size === 0) this.#subs.delete(connectionKey)
    }
  }

  /** The bind-scan rows for a connection key, or empty when unknown. */
  discovered(connectionKey: string): readonly DiscoveredDevice[] {
    return this.#surfaces.get(connectionKey)?.discovered ?? []
  }

  /** True when the connection has a published surface (i.e. it is bound). */
  has(connectionKey: string): boolean {
    return this.#surfaces.has(connectionKey)
  }

  /** The active connection keys (one entry per published surface). */
  list(): readonly { readonly id: string }[] {
    return Array.from(this.#surfaces.keys()).map((id) => ({ id }))
  }

  /**
   * Resolve the bound {@link AcDevice} handle for a `(connectionKey, mac)` pair,
   * or null when the connection is unknown or the AC has not been bound.
   */
  getDevice(connectionKey: string, mac: string): AcDevice | null {
    return this.#surfaces.get(connectionKey)?.handles.get(macKey(mac)) ?? null
  }

  /** Remove all registered surfaces (called on full shutdown). */
  clear(): void {
    this.#surfaces.clear()
    this.#subs.clear()
  }
}

/** The single in-process per-connection resolver shared between the AC device's
 *  manager and its accessory children. */
export const greeConnections = new GreeConnectionResolver()
