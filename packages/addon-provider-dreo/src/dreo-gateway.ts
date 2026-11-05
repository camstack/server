import type { BaseDevice as DreoBaseDevice, DreoDeviceInfo } from '@apocaliss92/nodedreo'

/**
 * A live Dreo connection's discovered surface: the per-account device handles
 * (created via `Nodedreo.createDevice`) plus the raw discovery info rows. Unlike
 * the Dreame library, `Nodedreo` keeps its handle set private and requires an
 * explicit `createDevice(info)` per device — so the integration manager builds
 * + owns the handles and publishes them here keyed by `(integrationId, deviceId)`.
 */
export interface DreoConnectionSurface {
  /** Discovery info rows (one per device on the account). */
  readonly infos: readonly DreoDeviceInfo[]
  /** Live device handles, keyed by Dreo `deviceId`. */
  readonly handles: ReadonlyMap<string, DreoBaseDevice>
}

/**
 * Per-integration registry that device classes use to reach a live Dreo device
 * handle (and the discovery info) for a given Dreo account.
 *
 * Keyed by `integrationId`. Device classes pass the `brokerId` field of their
 * persisted config, which holds the integrationId (the field name predates
 * integration instances and stays, it is stored on adopted devices).
 *
 * The kernel constructs device classes with only a `DeviceContext` — it cannot
 * thread the handle in as a constructor arg. Like the Dreame addon's
 * `dreameFacades`, we keep it simple and in-process: the integration manager
 * owns the connection surface per registered account and publishes it here;
 * device classes resolve their live `BaseDevice` handle by `(integrationId,
 * deviceId)`.
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

  /** The discovery info rows for an integration id, or empty when unknown. */
  infos(integrationId: string): readonly DreoDeviceInfo[] {
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

  /**
   * Resolve the live {@link DreoBaseDevice} handle for a `(integrationId, deviceId)`
   * pair, or null when the integration is unknown or the device is no longer present.
   */
  getDevice(integrationId: string, deviceId: string): DreoBaseDevice | null {
    return this.#surfaces.get(integrationId)?.handles.get(deviceId) ?? null
  }

  /** Remove all registered surfaces (called on full shutdown). */
  clear(): void {
    this.#surfaces.clear()
  }
}

/** The single in-process per-integration connection resolver shared between the
 *  client registry/manager and device instances (keyed by integrationId). */
export const dreoConnections = new DreoConnectionResolver()
