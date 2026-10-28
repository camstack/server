import type { FeederDevice, PetkitDeviceInfo } from '@apocaliss92/nodepetkit'

/**
 * A live PetKit account's connection surface: the discovered feeder roster
 * plus the materialised {@link FeederDevice} handles (each already refreshed
 * once by the client) keyed by PetKit device id.
 */
export interface PetkitConnectionSurface {
  /** Discovered feeder roster rows (one per feeder on the account). */
  readonly infos: readonly PetkitDeviceInfo[]
  /** Live feeder handles, keyed by PetKit device id. */
  readonly handles: ReadonlyMap<string, FeederDevice>
}

/** Sink the integration manager publishes its live surface to (the resolver). */
export interface PetkitSurfaceSink {
  set(integrationId: string, surface: PetkitConnectionSurface | null): void
  /** Register (or clear, with `null`) the integration's session-loss recovery entry. */
  setRecovery?(integrationId: string, recover: ((err: unknown) => void) | null): void
}

/**
 * Per-integration registry that device classes + the adoption provider use to
 * reach a live PetKit `FeederDevice` handle (and the discovered roster) for a
 * given account (account mode — one integration per account).
 *
 * The kernel constructs device classes with only a `DeviceContext` — it cannot
 * thread the handle in as a constructor arg. Like the Dreame / Gree addons, the
 * per-account integration manager owns the connection surface per
 * `integrationId` and publishes it here; a feeder device resolves its live
 * handle by `(integrationId, petkitDeviceId)`.
 */
export class PetkitFacadeResolver {
  readonly #surfaces: Map<string, PetkitConnectionSurface> = new Map()
  /**
   * Per-integration "surface (re)published" subscribers. A feeder device may
   * activate from restore BEFORE its integration finishes the async login, so
   * `getDevice` is null at `onActivate` time. Devices subscribe here and
   * re-poll once the handle is published. A plain `Set` has no listener cap.
   * Mirrors the Gree facade-resolver fan-out.
   */
  readonly #subs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the connection surface for an integration. `null` removes. */
  set(integrationId: string, surface: PetkitConnectionSurface | null): void {
    if (surface === null) {
      this.#surfaces.delete(integrationId)
    } else {
      this.#surfaces.set(integrationId, surface)
    }
    const subs = this.#subs.get(integrationId)
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

  readonly #recovery: Map<string, (err: unknown) => void> = new Map()

  /** The manager's session-loss recovery entry; `null` clears it. */
  setRecovery(integrationId: string, recover: ((err: unknown) => void) | null): void {
    if (recover === null) this.#recovery.delete(integrationId)
    else this.#recovery.set(integrationId, recover)
  }

  /** A device saw a failed call: let the account's manager decide on a re-login. */
  reportFailure(integrationId: string, err: unknown): void {
    this.#recovery.get(integrationId)?.(err)
  }

  /** Subscribe to surface (re)publish for an integration. Returns unsubscribe. */
  onSurface(integrationId: string, cb: () => void): () => void {
    let set = this.#subs.get(integrationId)
    if (!set) {
      set = new Set()
      this.#subs.set(integrationId, set)
    }
    set.add(cb)
    return () => {
      const current = this.#subs.get(integrationId)
      current?.delete(cb)
      if (current && current.size === 0) this.#subs.delete(integrationId)
    }
  }

  /** The discovered feeder roster for an integration, or empty when unknown. */
  getInfos(integrationId: string): readonly PetkitDeviceInfo[] {
    return this.#surfaces.get(integrationId)?.infos ?? []
  }

  /** True when the integration has a published surface (i.e. it is connected). */
  has(integrationId: string): boolean {
    return this.#surfaces.has(integrationId)
  }

  /** The active integration ids (one per published surface). */
  list(): readonly string[] {
    return [...this.#surfaces.keys()]
  }

  /**
   * Resolve the live {@link FeederDevice} handle for an
   * `(integrationId, petkitDeviceId)` pair, or null when the integration is
   * unknown or the feeder is not present.
   */
  getDevice(integrationId: string, petkitDeviceId: string): FeederDevice | null {
    return this.#surfaces.get(integrationId)?.handles.get(petkitDeviceId) ?? null
  }

  /** Remove all registered surfaces + subscriptions (called on full shutdown). */
  clear(): void {
    this.#surfaces.clear()
    this.#subs.clear()
    this.#recovery.clear()
  }
}

/** The single in-process per-integration facade resolver shared between the
 *  registry, the adoption provider, and the feeder device instances. */
export const petkitConnections = new PetkitFacadeResolver()
