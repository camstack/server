import type { StateRefreshReason } from '@dominevo/types'
import type { KiaDiscoverable } from './kia-discovery.js'
import type { KiaVehicleHandle } from './kia-device-handle.js'

/**
 * A live Kia connection's surface: the discovery rows of the account, a handle per vehicle
 * (owned and fed by the integration manager) and the scheduled read of the whole account.
 */
export interface KiaConnectionSurface {
  /** One row per vehicle on the account. */
  readonly infos: readonly KiaDiscoverable[]
  /** Live vehicle handles, keyed by the cloud vehicle id. */
  readonly handles: ReadonlyMap<string, KiaVehicleHandle>
  /** The core's read of the account: a cloud call only on the schedule (see the manager). */
  readonly refresh: (reason: StateRefreshReason) => Promise<void>
}

interface VehicleWatcher {
  readonly integrationId: string
  readonly vehicleId: string
  readonly listener: () => void
  unbind: (() => void) | null
}

/**
 * Per-integration registry the device classes use to reach a live vehicle handle (and the
 * discovery rows) of a given Kia account. Keyed by `integrationId`; device classes pass the
 * `brokerId` field of their persisted config, which holds it (the name predates integration
 * instances and stays, it is stored on adopted devices).
 */
export class KiaConnectionResolver {
  readonly #surfaces: Map<string, KiaConnectionSurface> = new Map()
  readonly #watchers = new Set<VehicleWatcher>()

  /** Publish or remove the connection surface for an integration id. `null` removes. */
  set(integrationId: string, surface: KiaConnectionSurface | null): void {
    if (surface === null) this.#surfaces.delete(integrationId)
    else this.#surfaces.set(integrationId, surface)
    for (const watcher of [...this.#watchers]) {
      if (watcher.integrationId !== integrationId) continue
      this.#bind(watcher)
      // A vehicle that now has a handle has a state its device has not folded in yet.
      if (watcher.unbind !== null) watcher.listener()
    }
  }

  /**
   * Follow a vehicle for as long as the device lives. The manager builds new handles on every
   * start, and a device is activated before the first sign-in may have succeeded, so a listener
   * bound to one handle would be orphaned: this one rebinds whenever the surface changes and
   * fires once when a handle appears, so the device folds the state in.
   */
  watchVehicle(integrationId: string, vehicleId: string, listener: () => void): () => void {
    const watcher: VehicleWatcher = { integrationId, vehicleId, listener, unbind: null }
    this.#watchers.add(watcher)
    this.#bind(watcher)
    return () => {
      this.#watchers.delete(watcher)
      watcher.unbind?.()
      watcher.unbind = null
    }
  }

  #bind(watcher: VehicleWatcher): void {
    watcher.unbind?.()
    watcher.unbind = null
    const handle = this.getVehicle(watcher.integrationId, watcher.vehicleId)
    if (handle !== null) watcher.unbind = handle.onChange(watcher.listener)
  }

  infos(integrationId: string): readonly KiaDiscoverable[] {
    return this.#surfaces.get(integrationId)?.infos ?? []
  }

  has(integrationId: string): boolean {
    return this.#surfaces.has(integrationId)
  }

  list(): readonly { readonly id: string }[] {
    return Array.from(this.#surfaces.keys()).map((id) => ({ id }))
  }

  /** The live handle for a `(integrationId, vehicleId)` pair, or null when unknown. */
  getVehicle(integrationId: string, vehicleId: string): KiaVehicleHandle | null {
    return this.#surfaces.get(integrationId)?.handles.get(vehicleId) ?? null
  }

  /** Read the account for the core; throws when the integration is not connected. */
  async refresh(integrationId: string, reason: StateRefreshReason): Promise<void> {
    const surface = this.#surfaces.get(integrationId)
    if (surface === undefined) {
      throw new Error(`Kia: cloud connection unavailable (integration=${integrationId})`)
    }
    await surface.refresh(reason)
  }

  clear(): void {
    this.#surfaces.clear()
  }
}

/** The single in-process connection resolver shared by the registry, the managers and the devices. */
export const kiaConnections = new KiaConnectionResolver()
