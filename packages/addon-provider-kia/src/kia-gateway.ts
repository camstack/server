import type { StateRefreshReason } from '@camstack/types'
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

/**
 * Per-integration registry the device classes use to reach a live vehicle handle (and the
 * discovery rows) of a given Kia account. Keyed by `integrationId`; device classes pass the
 * `brokerId` field of their persisted config, which holds it (the name predates integration
 * instances and stays, it is stored on adopted devices).
 */
export class KiaConnectionResolver {
  readonly #surfaces: Map<string, KiaConnectionSurface> = new Map()

  /** Publish or remove the connection surface for an integration id. `null` removes. */
  set(integrationId: string, surface: KiaConnectionSurface | null): void {
    if (surface === null) {
      this.#surfaces.delete(integrationId)
      return
    }
    this.#surfaces.set(integrationId, surface)
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
