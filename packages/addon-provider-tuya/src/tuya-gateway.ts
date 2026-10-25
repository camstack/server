/**
 * In-process per-integration registry the Tuya device classes use to reach (a)
 * the cloud CATALOG for an account (device list + localKeys — the adoption
 * source) and (b) the single live LOCAL {@link TuyaDeviceHandle} that an adopted
 * device owns (so a kettle Container's per-DP accessory children read/write
 * through the ONE TCP connection their parent holds — Tuya permits only one LAN
 * client per device).
 *
 * The kernel constructs device classes with only a `DeviceContext`, so it cannot
 * thread the handle/catalog in as a constructor arg. Mirrors the Gree
 * `greeConnections` + Dreame `dreameFacades` resolvers: the integration manager
 * publishes the catalog keyed by `integrationId`; an adopted parent device
 * publishes its live handle keyed by `(integrationId, deviceId)` and pumps its
 * `dps` pushes through the shared fan-out bus so all its children recompute
 * without each attaching a listener to the socket emitter.
 */

/** Minimal live-handle surface a device/child needs to read + write DPs. The
 *  concrete `TuyaDevice` from `@apocaliss92/nodetuya` satisfies it structurally. */
export interface TuyaDeviceHandle {
  readonly id: string
  /** Latest datapoint map (updated by the owner on each `dps` push / `get`). */
  readonly dps: Readonly<Record<string, unknown>>
  /** Write one or more datapoints. */
  set(dps: Record<string, unknown>): Promise<void>
}

/**
 * One cloud device as merged from the Tuya IoT cloud (localKey + provenance) and
 * the LAN discovery sweep (reachable `ip` + protocol `version`). The adoption
 * candidate list + the per-device persisted control config are both built from
 * this — so an adopted device carries its own localKey/host/version (a setting,
 * never hard-coded) and needs no live catalog to reconnect.
 */
export interface TuyaCatalogEntry {
  readonly deviceId: string
  readonly name: string
  readonly localKey: string
  readonly category: string | undefined
  /** LAN IP resolved from cloud or discovery; empty when unknown. */
  readonly ip: string
  /** Protocol version (`3.1`–`3.5`); empty when unknown (defaults to `3.3`). */
  readonly version: string
  readonly online: boolean | undefined
}

/** Compose the `(integrationId, deviceId)` map key. */
function handleKey(integrationId: string, deviceId: string): string {
  return `${integrationId}:${deviceId}`
}

export class TuyaConnectionResolver {
  readonly #catalog: Map<string, readonly TuyaCatalogEntry[]> = new Map()
  readonly #handles: Map<string, TuyaDeviceHandle> = new Map()
  readonly #stateSubs: Map<string, Set<() => void>> = new Map()

  // ── Cloud catalog (per integration) ──────────────────────────────────────

  /** Publish or remove an integration's cloud catalog. `null` removes it. */
  setCatalog(integrationId: string, entries: readonly TuyaCatalogEntry[] | null): void {
    if (entries === null) {
      this.#catalog.delete(integrationId)
      return
    }
    this.#catalog.set(integrationId, entries)
  }

  /** The cloud catalog for an integration, or empty when unknown. */
  catalog(integrationId: string): readonly TuyaCatalogEntry[] {
    return this.#catalog.get(integrationId) ?? []
  }

  /** Resolve one catalog entry by `(integrationId, deviceId)`, or null. */
  catalogEntry(integrationId: string, deviceId: string): TuyaCatalogEntry | null {
    return this.#catalog.get(integrationId)?.find((e) => e.deviceId === deviceId) ?? null
  }

  // ── Live local handles (per adopted device) ──────────────────────────────

  /** Publish or remove the live handle an adopted device owns. `null` removes. */
  setHandle(integrationId: string, deviceId: string, handle: TuyaDeviceHandle | null): void {
    const key = handleKey(integrationId, deviceId)
    if (handle === null) {
      this.#handles.delete(key)
      return
    }
    this.#handles.set(key, handle)
  }

  /** Resolve the live handle for `(integrationId, deviceId)`, or null. */
  getHandle(integrationId: string, deviceId: string): TuyaDeviceHandle | null {
    return this.#handles.get(handleKey(integrationId, deviceId)) ?? null
  }

  // ── Per-device `dps` fan-out (owner → children) ──────────────────────────

  /** Subscribe a child to its device's `dps` pushes. Returns an unsubscribe fn. */
  onDps(integrationId: string, deviceId: string, cb: () => void): () => void {
    const key = handleKey(integrationId, deviceId)
    let set = this.#stateSubs.get(key)
    if (!set) {
      set = new Set()
      this.#stateSubs.set(key, set)
    }
    set.add(cb)
    return () => {
      const current = this.#stateSubs.get(key)
      current?.delete(cb)
      if (current && current.size === 0) this.#stateSubs.delete(key)
    }
  }

  /** Fan one device's `dps` push out to every subscribed child. */
  emitDps(integrationId: string, deviceId: string): void {
    const set = this.#stateSubs.get(handleKey(integrationId, deviceId))
    if (!set) return
    for (const cb of set) {
      try {
        cb()
      } catch {
        // best-effort — one bad subscriber must not starve the others
      }
    }
  }

  /** Remove everything (called on full shutdown). */
  clear(): void {
    this.#catalog.clear()
    this.#handles.clear()
    this.#stateSubs.clear()
  }
}

/** The single in-process resolver shared between the integration managers, the
 *  adoption provider, and the device instances. */
export const tuyaConnections = new TuyaConnectionResolver()
