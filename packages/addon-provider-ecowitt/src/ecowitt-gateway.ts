import type { Ecowitt, Sensor } from '@apocaliss92/nodewitt'

/**
 * Per-gateway registry that device classes use to reach the live {@link Ecowitt}
 * client (and its current sensor snapshot) for a given gateway. Keyed on the
 * gateway {@link import('@camstack/types').DeviceType.Hub} device's `stableId`
 * (standalone mode — the connection lives on the gateway device, not a broker).
 *
 * Because the nodewitt client's `stop()` is TERMINAL, the gateway device
 * recreates the client on reconnect / settings change and re-publishes it here.
 * Container + sensor children always read through the resolver, so they
 * transparently pick up the new client. Mirrors the Homematic / Dreame in-process
 * facade resolver.
 */
export class EcowittFacadeResolver {
  readonly #facades: Map<string, Ecowitt> = new Map()
  /**
   * Per-gateway snapshot fan-out. Container + sensor children subscribe here
   * instead of attaching directly to the nodewitt facade's EventEmitter — a
   * station with >10 sensors would otherwise trip Node's default MaxListeners
   * cap (one listener per child on a single emitter). The gateway device pumps
   * this bus once per snapshot from its single facade subscription; a plain
   * `Set` of callbacks has no listener limit.
   */
  readonly #snapshotSubs: Map<string, Set<() => void>> = new Map()

  /** Publish or remove the client for a gateway id. `null` removes the entry. */
  set(gatewayId: string, facade: Ecowitt | null): void {
    if (facade === null) {
      this.#facades.delete(gatewayId)
      return
    }
    this.#facades.set(gatewayId, facade)
  }

  /** Subscribe a child to per-gateway snapshot ticks. Returns an unsubscribe fn. */
  onSnapshot(gatewayId: string, cb: () => void): () => void {
    let set = this.#snapshotSubs.get(gatewayId)
    if (!set) {
      set = new Set()
      this.#snapshotSubs.set(gatewayId, set)
    }
    set.add(cb)
    return () => {
      const current = this.#snapshotSubs.get(gatewayId)
      current?.delete(cb)
      if (current && current.size === 0) this.#snapshotSubs.delete(gatewayId)
    }
  }

  /** Fan a single facade snapshot out to every subscribed child for a gateway. */
  emitSnapshot(gatewayId: string): void {
    const set = this.#snapshotSubs.get(gatewayId)
    if (!set) return
    for (const cb of set) {
      try {
        cb()
      } catch {
        // best-effort — one bad subscriber must not starve the others
      }
    }
  }

  /** The live client for a gateway id, or null when unknown / stopped. */
  get(gatewayId: string): Ecowitt | null {
    return this.#facades.get(gatewayId) ?? null
  }

  /** All current sensors for a gateway, or [] when unknown. */
  getSensors(gatewayId: string): readonly Sensor[] {
    return this.#facades.get(gatewayId)?.getSensors() ?? []
  }

  /** Resolve a single sensor by its stable id for a gateway, or null. */
  getSensor(gatewayId: string, sensorId: string): Sensor | null {
    return this.getSensors(gatewayId).find((s) => s.id === sensorId) ?? null
  }

  /** Remove all registered clients (called on full shutdown). */
  clear(): void {
    this.#facades.clear()
    this.#snapshotSubs.clear()
  }
}

/** The single in-process per-gateway client resolver shared between the gateway
 *  device and its container / sensor children. */
export const ecowittFacades = new EcowittFacadeResolver()
