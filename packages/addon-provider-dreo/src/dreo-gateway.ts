import type { DreoDiscoverable } from './dreo-discovery.js'
import type { DreoDeviceHandle } from './dreo-device-handle.js'

/**
 * A live Dreo connection's surface: the discovery rows of the account, a handle per device
 * (owned and fed by the integration manager) and a way to read every device again from the
 * cloud. Device classes resolve their handle by `(integrationId, deviceId)`.
 */
export interface DreoConnectionSurface {
  /** One row per device on the account. */
  readonly infos: readonly DreoDiscoverable[]
  /** Live device handles, keyed by Dreo `deviceId`. */
  readonly handles: ReadonlyMap<string, DreoDeviceHandle>
  /** Read every device of the account from the cloud and fold it into the handles. */
  readonly refresh: () => Promise<void>
}

/**
 * Per-integration registry that device classes use to reach a live Dreo device handle (and
 * the discovery rows) for a given Dreo account.
 *
 * Keyed by `integrationId`. Device classes pass the `brokerId` field of their persisted
 * config, which holds the integrationId (the field name predates integration instances and
 * stays, it is stored on adopted devices).
 *
 * The kernel constructs device classes with only a `DeviceContext`, so the manager publishes
 * the surface here, in-process, and the classes look their handle up.
 */
export class DreoConnectionResolver {
  readonly #surfaces: Map<string, DreoConnectionSurface> = new Map()

  /** Publish or remove the connection surface for an integration id. `null` removes. */
  set(integrationId: string, surface: DreoConnectionSurface | null): void {
    if (surface === null) {
      this.#surfaces.delete(integrationId)
      return
    }
    this.#surfaces.set(integrationId, surface)
  }

  /** The discovery rows for an integration id, or empty when unknown. */
  infos(integrationId: string): readonly DreoDiscoverable[] {
    return this.#surfaces.get(integrationId)?.infos ?? []
  }

  /** True when the integration has a published surface (i.e. is connected). */
  has(integrationId: string): boolean {
    return this.#surfaces.has(integrationId)
  }

  /** The connected integration ids (one entry per published surface). The adoption
   *  provider walks this to total candidate counts across accounts. */
  list(): readonly { readonly id: string }[] {
    return Array.from(this.#surfaces.keys()).map((id) => ({ id }))
  }

  /** The live handle for a `(integrationId, deviceId)` pair, or null when the integration is
   *  unknown or the device is no longer present. */
  getDevice(integrationId: string, deviceId: string): DreoDeviceHandle | null {
    return this.#surfaces.get(integrationId)?.handles.get(deviceId) ?? null
  }

  /** Read the whole account again from the cloud; throws when the integration is not connected. */
  async refresh(integrationId: string): Promise<void> {
    const surface = this.#surfaces.get(integrationId)
    if (surface === undefined) {
      throw new Error(`Dreo: cloud connection unavailable (integration=${integrationId})`)
    }
    await surface.refresh()
  }

  /** Remove all registered surfaces (called on full shutdown). */
  clear(): void {
    this.#surfaces.clear()
  }
}

/** The single in-process per-integration connection resolver shared between the
 *  client registry/manager and device instances (keyed by integrationId). */
export const dreoConnections = new DreoConnectionResolver()
