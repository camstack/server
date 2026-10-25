/**
 * The settings-view and sync-store contracts `ConfigManager` serves. Split out
 * of `config-manager.ts` (D675) so that file stays one class; every name is
 * re-exported from there, so importers are unchanged.
 */
import type { AddonStoreRead, StoredKeyRead } from '@camstack/types'

export interface AddonSettingsView {
  readAddonStore(): Promise<Record<string, unknown>>
  /** See `IAddonContext['settings'].readAddonStoreResult` (D651). */
  readAddonStoreResult?(): Promise<AddonStoreRead>
  /** See `IAddonContext['settings'].readAddonStoreKeyResult` (D675). */
  readAddonStoreKeyResult?(key: string): Promise<StoredKeyRead>
  writeAddonStore(patch: Record<string, unknown>): Promise<void>
  readDeviceStore(deviceId: number): Promise<Record<string, unknown>>
  /** See `IAddonContext['settings'].readDeviceStoreBatch`. */
  readDeviceStoreBatch(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, Record<string, unknown>>>
  /** See `IAddonContext['settings'].listDeviceStoreIds`. */
  listDeviceStoreIds(): Promise<readonly number[]>
  writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
  clearDeviceStore(deviceId: number): Promise<void>
  getSection(section: string): Promise<Record<string, unknown>>
  setSection(section: string, patch: Record<string, unknown>): Promise<void>
  /**
   * Per-device runtime state — separate namespace from
   * `readDeviceStore` / `writeDeviceStore` (which is the addon's
   * config blob: host, password, deviceCache, …). Holds mutable
   * runtime signals discovered after boot: battery snapshot, sleep
   * flag, last-seen timestamps. Stored under a kernel-internal
   * `__device-state` namespace so the device's config schema
   * never has to know about it (clean separation of operator
   * intent from runtime telemetry).
   *
   * Patch semantics: shallow merge. Pass the FULL persistent slice
   * each call (the kernel doesn't try to compute deltas) — concrete
   * implementations of `DeviceRuntimeState` already coalesce in
   * memory, so the kernel just persists the latest blob.
   */
  readDeviceRuntimeState(deviceId: number): Promise<Record<string, unknown>>
  writeDeviceRuntimeState(deviceId: number, data: Record<string, unknown>): Promise<void>
  clearDeviceRuntimeState(deviceId: number): Promise<void>
}

/**
 * A CONCRETE backend behind {@link ConfigManager.createSettingsView} — the
 * sync-`ISettingsStore` one or the async-door one.
 */
export interface SettingsViewBackend extends AddonSettingsView {
  readAddonStoreKeyResult(key: string): Promise<StoredKeyRead>
}

export interface ISettingsStore {
  getSystem(key: string): unknown
  setSystem(key: string, value: unknown): void
  getAllSystem(): Record<string, unknown>

  /** Addon-level global settings (apply to every device unless overridden). */
  getAllAddon(addonId: string): Record<string, unknown>
  setAllAddon(addonId: string, config: Record<string, unknown>): void

  /**
   * Per-device runtime state — the whole cap-slice map as ONE row in the
   * `device-runtime-state` collection.
   *
   * Runtime state is not an addon's config: it belongs to the device, it is replaced
   * wholesale on every flush, and it is written orders of magnitude more often.
   * It USED to share that keyspace under a synthetic `__device-state` addonId,
   * which cost one row (and one INSERT) per cap slice per flush and left the
   * collection it is named for empty on every installation. The backend keeps
   * reading the legacy prefix; see `SqliteSettingsBackend.getDeviceRuntimeState`.
   */
  getDeviceRuntimeState(deviceId: string): Record<string, unknown>
  setDeviceRuntimeState(deviceId: string, blob: Record<string, unknown>): void
  clearDeviceRuntimeState(deviceId: string): void
}

/**
 * The settings view `ConfigManager.createSettingsView` returns. Its three-way
 * reads are REQUIRED here (optional on the public {@link AddonSettingsView}
 * only for a forked runner's UDS view), so a caller holding a `ConfigManager`
 * never has to decide whether they exist.
 */
export interface KernelAddonSettingsView extends AddonSettingsView {
  readAddonStoreResult(): Promise<AddonStoreRead>
  readAddonStoreKeyResult(key: string): Promise<StoredKeyRead>
}
