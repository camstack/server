/**
 * Meta persistence layer for the device-manager addon.
 *
 * `DeviceMetaStore` bundles what the provider modules need to reach persisted
 * device state: the row store (`device-manager:devices`, one row per device —
 * see `device-row-store.ts` for why), the single-writer mutex
 * (`withMetaWriteLock`), id allocation (`allocateNextDeviceId`) and the
 * ownership/child resolvers.
 *
 * **The three fleet blobs are gone.** `deviceMeta`, `deviceMetadata` and
 * `deviceIndex` used to live on this addon's `addon-settings` row set, and every
 * projection read all three: `readAddonStore` → `getAllAddon`, 625 KB read and
 * `JSON.parse`d synchronously on hub-main's event loop, per question. There is
 * no `readAll` / `readMeta` / `readIndex` / `readMetadataMap` any more because
 * there is no blob to project — a per-device question is a primary-key lookup
 * and a fleet question is one indexed scan.
 *
 * What remains on the addon store are the SIBLING keys this class never owned:
 * `nextDeviceId` (read + bumped by {@link allocateNextDeviceId}),
 * `roleDisplayDefaults`, `locations` and `deviceBindings`. That row set is now
 * under a kilobyte.
 */
import type { AddonContext, IDeviceRegistry } from '@camstack/types'
import type { AddonStore, PersistedDeviceMeta } from './device-meta-types.js'
import { decodeAddonStore } from './device-meta-types.js'
import type { DeviceRow, DeviceRowStore } from './device-row-store.js'
import { createWriteLock, type WriteLock } from './write-lock.js'

/** The settings surface the meta store uses (`ctx.settings`, narrowed non-null). */
export type DeviceManagerSettings = NonNullable<AddonContext['settings']>

export class DeviceMetaStore {
  /** Synchronous ownership cache, keyed by NUMERIC deviceId → owning addonId.
   *  The persisted row store is authoritative but reads are async; hub-side
   *  callers (e.g. `CapabilityRegistry.getNativeProvider` fallback) need
   *  ownership without awaiting. Kept in sync with every register/remove and
   *  warmed from persistence on boot. */
  readonly idToAddonId: Map<number, string> = new Map()

  constructor(
    private readonly settings: DeviceManagerSettings,
    /** Hub-process device registry (null when this node owns no registry). */
    readonly registry: IDeviceRegistry | null,
    /** Row access for `device-manager:devices`. */
    readonly rows: DeviceRowStore,
    /**
     * The addon's OWN settings row set lock, shared with every other writer of
     * it (`setWrapperActive`, `removeDevice`'s bindings purge, `addLocation`,
     * `removeLocation`, `setRoleDisplayDefaults`) — see
     * {@link BindingsDeps.addonStoreLock}. Owned by the addon, not by this
     * class, because those writers do not all go through it.
     */
    readonly withAddonStoreWriteLock: WriteLock = createWriteLock(),
  ) {}

  /** The read currently in flight, or null. Never a settled value — see
   *  {@link readStore}. */
  private inFlightRead: Promise<AddonStore> | null = null

  /**
   * The addon's own settings row set — `nextDeviceId`, `roleDisplayDefaults`,
   * `locations`. NOT the fleet: no device has lived here since the flatten.
   *
   * **Concurrent callers join the read already in flight.** This is not a
   * cache and nothing survives settlement: a caller that awaited the running
   * promise could not have observed anything older than its result, so the
   * only thing that changes is cost.
   *
   * A rejection is NOT latched: the slot is cleared before the promise
   * settles either way, so a failed read costs the joiners that one failure
   * and the next caller reaches the store again.
   */
  readStore = async (): Promise<AddonStore> => {
    const existing = this.inFlightRead
    if (existing !== null) return existing
    const read = (async (): Promise<AddonStore> => {
      try {
        return decodeAddonStore(await this.settings.readAddonStore())
      } finally {
        this.inFlightRead = null
      }
    })()
    this.inFlightRead = read
    return read
  }

  // Serialize every read-modify-write of a device ROW through a single
  // promise chain. Without this, concurrent setMetadata / setName /
  // setLocation / setDisabled callers race: each reads the row, computes a
  // merged value, then writes it back — last writer wins for the fields it
  // computed. Column-scoped writes removed the CROSS-FIELD clobber (a writer
  // that never names a column cannot destroy it), but a same-field
  // read-modify-write — `setMetadata`'s shallow merge, `setName`'s cascade,
  // `registerDevice`'s preserve-or-adopt reconcile — still needs ordering.
  //
  // This lock and {@link withAddonStoreWriteLock} guard DIFFERENT storage:
  // device rows here, this addon's `addon-settings` key range there. The only
  // place both are held is `allocateNextDeviceId`, and the order is always
  // meta ⊃ addon-store — never the reverse, or the two would deadlock.
  withMetaWriteLock: WriteLock = createWriteLock()

  /** The whole persisted row for one device, or `null`. */
  getRow = async (deviceId: number): Promise<DeviceRow | null> => this.rows.get(deviceId)

  /**
   * Resolve a numeric deviceId to the owning `(addonId, stableId)` pair.
   * Reads the device's own row — live IDevice lookup (hub registry) is handled
   * separately per call site so callers can decide whether to route to
   * an in-process driver or to the cross-process `device-ops` bridge.
   * Returns null when no device with that id is known to the hub.
   */
  resolvePersistedById = async (
    deviceId: number,
  ): Promise<{ addonId: string; stableId: string; meta: PersistedDeviceMeta } | null> => {
    const row = await this.rows.get(deviceId)
    if (row === null) return null
    return { addonId: row.meta.addonId, stableId: row.meta.stableId, meta: row.meta }
  }

  /** The device's hardware-identity metadata blob, or `null`. */
  readMetadata = async (deviceId: number): Promise<Record<string, unknown> | null> => {
    const row = await this.rows.get(deviceId)
    return row?.metadata ?? null
  }

  /** Direct children of a device: the union of the live registry's children
   *  and the persisted rows whose `parentDeviceId` is `parentId`, deduplicated
   *  and excluding self. Shared by the `remove` cascade and the `resetToSource`
   *  resync purge (#19). */
  directChildIds = async (parentId: number): Promise<readonly number[]> => {
    const ids = new Set<number>()
    if (this.registry) {
      for (const c of this.registry.getChildren(parentId)) ids.add(c.id)
    }
    for (const row of await this.rows.listByParent(parentId)) ids.add(row.meta.id)
    ids.delete(parentId)
    return [...ids]
  }

  /**
   * Mint the next numeric device id.
   *
   * A read-modify-write of `nextDeviceId`, and it must hold the addon-store
   * lock for the whole of it. Serialising the WRITES is not enough and never
   * was: two callers that both read `N` both write `N + 1` and both return
   * `N`, so two devices receive the same id. (`writeAddonStore` is itself
   * read-modify-write over the addon's whole key range, so an unlocked bump
   * can also be reverted wholesale by a concurrent `setWrapperActive`.)
   *
   * Callers hold {@link withMetaWriteLock} — this is the one nesting, and it
   * only ever goes meta ⊃ addon-store.
   */
  allocateNextDeviceId = async (): Promise<number> =>
    this.withAddonStoreWriteLock(async () => {
      const store = await this.readStore()
      const current = store.nextDeviceId ?? 1
      await this.settings.writeAddonStore({ nextDeviceId: current + 1 })
      return current
    })
}
