import type { BaseDevice as DreoBaseDevice, DreoDeviceInfo } from '@apocaliss92/nodedreo'

/**
 * A live Dreo connection's discovered surface: the per-account device handles
 * (created via `Nodedreo.createDevice`) plus the raw discovery info rows. Unlike
 * the Dreame library, `Nodedreo` keeps its handle set private and requires an
 * explicit `createDevice(info)` per device — so the integration manager builds
 * + owns the handles and publishes them here keyed by `(brokerId, deviceId)`.
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
 * `mode: account`: keyed by `integrationId`. The string key is generically named
 * `brokerId` in the method signatures below because the device classes pass their
 * persisted `brokerId` config field — which now holds the integrationId
 * (unchanged device-side code, see the addon migration note).
 *
 * The kernel constructs device classes with only a `DeviceContext` — it cannot
 * thread the handle in as a constructor arg. Like the Dreame addon's
 * `dreameFacades`, we keep it simple and in-process: the integration manager
 * owns the connection surface per registered account and publishes it here;
 * device classes resolve their live `BaseDevice` handle by `(brokerId,
 * deviceId)` where `brokerId` = integrationId.
 */
export class DreoConnectionResolver {
  readonly #surfaces: Map<string, DreoConnectionSurface> = new Map()

  /** Publish or remove the connection surface for a broker id. `null` removes. */
  set(brokerId: string, surface: DreoConnectionSurface | null): void {
    if (surface === null) {
      this.#surfaces.delete(brokerId)
      return
    }
    this.#surfaces.set(brokerId, surface)
  }

  /** The discovery info rows for a broker id, or empty when unknown. */
  infos(brokerId: string): readonly DreoDeviceInfo[] {
    return this.#surfaces.get(brokerId)?.infos ?? []
  }

  /** True when the broker has a published surface (i.e. is connected). */
  has(brokerId: string): boolean {
    return this.#surfaces.has(brokerId)
  }

  /** The connected broker ids (one entry per published surface). The adoption
   *  provider walks this to total candidate counts across accounts. */
  list(): readonly { readonly id: string }[] {
    return Array.from(this.#surfaces.keys()).map((id) => ({ id }))
  }

  /**
   * Resolve the live {@link DreoBaseDevice} handle for a `(brokerId, deviceId)`
   * pair, or null when the broker is unknown or the device is no longer present.
   */
  getDevice(brokerId: string, deviceId: string): DreoBaseDevice | null {
    return this.#surfaces.get(brokerId)?.handles.get(deviceId) ?? null
  }

  /** Remove all registered surfaces (called on full shutdown). */
  clear(): void {
    this.#surfaces.clear()
  }
}

/** The single in-process per-integration connection resolver shared between the
 *  client registry/manager and device instances (keyed by integrationId). */
export const dreoConnections = new DreoConnectionResolver()
