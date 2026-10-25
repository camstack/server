import type { BaseDevice as DreameBaseDevice, Nodreame } from '@apocaliss92/nodedreame'

/**
 * Per-broker registry that device classes use to reach the live
 * {@link Nodreame} facade (and its discovered device handles) for a given
 * Dreamehome account.
 *
 * The kernel constructs device classes with only a `DeviceContext` — it cannot
 * thread the facade in as a constructor arg. Like the Homematic addon's
 * `homematicFacades`, we keep it simple and in-process: the registry owns one
 * `Nodreame` facade per registered account and publishes it here; device
 * classes resolve their live `BaseDevice` handle by `(brokerId, deviceId)`.
 */
export class DreameFacadeResolver {
  readonly #facades: Map<string, Nodreame> = new Map()
  /**
   * Per-(broker, device) `stateChanged` fan-out. Accessory children subscribe
   * here instead of attaching directly to their device handle's EventEmitter —
   * a robot container with dozens of children would otherwise trip Node's
   * default MaxListeners cap (one listener per child on a single emitter). The
   * integration manager pumps this bus from its single facade subscription
   * (the facade re-emits every handle's `stateChanged` tagged with the
   * deviceId); a plain `Set` of callbacks has no listener limit.
   */
  readonly #stateSubs: Map<string, Map<string, Set<() => void>>> = new Map()

  /** Publish or remove the facade for a broker id. `null` removes the entry. */
  set(brokerId: string, facade: Nodreame | null): void {
    if (facade === null) {
      this.#facades.delete(brokerId)
      return
    }
    this.#facades.set(brokerId, facade)
  }

  /** Subscribe a child to its device's state pushes. Returns an unsubscribe fn. */
  onStateChanged(brokerId: string, dreameDeviceId: string, cb: () => void): () => void {
    let byDevice = this.#stateSubs.get(brokerId)
    if (!byDevice) {
      byDevice = new Map()
      this.#stateSubs.set(brokerId, byDevice)
    }
    let set = byDevice.get(dreameDeviceId)
    if (!set) {
      set = new Set()
      byDevice.set(dreameDeviceId, set)
    }
    set.add(cb)
    return () => {
      const devices = this.#stateSubs.get(brokerId)
      const current = devices?.get(dreameDeviceId)
      current?.delete(cb)
      if (devices && current && current.size === 0) {
        devices.delete(dreameDeviceId)
        if (devices.size === 0) this.#stateSubs.delete(brokerId)
      }
    }
  }

  /** Fan one device's state push out to every subscribed child. */
  emitStateChanged(brokerId: string, dreameDeviceId: string): void {
    const set = this.#stateSubs.get(brokerId)?.get(dreameDeviceId)
    if (!set) return
    for (const cb of set) {
      try {
        cb()
      } catch {
        // best-effort — one bad subscriber must not starve the others
      }
    }
  }

  /** The live facade for a broker id, or null when unknown / disconnected. */
  get(brokerId: string): Nodreame | null {
    return this.#facades.get(brokerId) ?? null
  }

  /**
   * Resolve the live {@link DreameBaseDevice} handle for a `(brokerId,
   * dreameDeviceId)` pair, or null when the broker is unknown or the device is
   * no longer present in the facade's discovered set.
   */
  getDevice(brokerId: string, dreameDeviceId: string): DreameBaseDevice | null {
    const facade = this.#facades.get(brokerId)
    if (!facade) return null
    return facade.devices.find((d) => d.deviceId === dreameDeviceId) ?? null
  }

  /** Remove all registered facades + subscriptions (called on full shutdown). */
  clear(): void {
    this.#facades.clear()
    this.#stateSubs.clear()
  }
}

/** The single in-process per-broker facade resolver shared between the registry
 *  and device instances. */
export const dreameFacades = new DreameFacadeResolver()
