/**
 * The sync-`ISettingsStore` backend of `ConfigManager.createSettingsView`.
 * Split out of `config-manager.ts` (D675) so that file stays one class.
 */
import type { StoredKeyRead } from '@camstack/types'
import { asJsonObject } from '@camstack/types/addon'
import type { SettingsViewBackend } from './settings-view-types.js'

/** The `ConfigManager` surface this backend reads and writes through. */
export interface StoreViewHost {
  hasSyncStore(): boolean
  getBootstrap(configPath: string): unknown
  getAddonConfig(addonId: string): Record<string, unknown>
  setAddonConfig(addonId: string, config: Record<string, unknown>): void
  getDeviceRuntimeState(deviceId: string): Record<string, unknown>
  setDeviceRuntimeState(deviceId: string, blob: Record<string, unknown>): void
  clearDeviceRuntimeState(deviceId: string): void
  getSection(section: string): Record<string, unknown>
  setSection(section: string, data: Record<string, unknown>): void
}

export function createStoreSettingsView(addonId: string, cm: StoreViewHost): SettingsViewBackend {
  const refuseDeviceSettings = async (): Promise<never> => {
    throw new Error(
      `device settings of addon "${addonId}" are served by the settings-store door only`,
    )
  }
  // This backend serves the sync store AND the D294 window before any
  // backend is wired. In that window the public sync readers refuse
  // (D675), so the view reads through `viewAddonConfig` /
  // `viewAddonDevice`, which keep the pre-wiring answer (`{}`, the bootstrap
  // file holds no addon key). Its three-way read reports that window as
  // `failed` (D651), so no caller learns "never written" from it.
  const viewAddonConfig = (): Record<string, unknown> =>
    !cm.hasSyncStore()
      ? (asJsonObject(cm.getBootstrap(`addons.${addonId}`)) ?? {})
      : cm.getAddonConfig(addonId)
  return {
    async readAddonStore(): Promise<Record<string, unknown>> {
      return viewAddonConfig()
    },
    async readAddonStoreKeyResult(key: string): Promise<StoredKeyRead> {
      if (!cm.hasSyncStore()) {
        return {
          kind: 'unreadable',
          reason: 'store-read-failed',
          error: 'settings store not wired',
        }
      }
      try {
        const all = cm.getAddonConfig(addonId)
        return key in all ? { kind: 'present', value: all[key] } : { kind: 'absent' }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err)
        return { kind: 'unreadable', reason: 'store-read-failed', error }
      }
    },
    async writeAddonStore(patch: Record<string, unknown>): Promise<void> {
      const existing = viewAddonConfig()
      cm.setAddonConfig(addonId, { ...existing, ...patch })
    },
    // Per-device settings live only in the settings-store door (D870): the
    // sync store has no copy of them, so a view backed by it refuses rather
    // than answering `{}` for a store nobody asked.
    readDeviceStore: refuseDeviceSettings,
    readDeviceStoreBatch: refuseDeviceSettings,
    listDeviceStoreIds: refuseDeviceSettings,
    writeDeviceStore: refuseDeviceSettings,
    clearDeviceStore: refuseDeviceSettings,
    // Runtime state goes to its OWN collection, `device-runtime-state`,
    // addressed by deviceId only — addon identity isn't part of the key
    // because runtime state belongs to the device, not to whichever addon
    // happens to own it. One row per device, the whole cap map in one blob.
    //
    // It used to live in `addon-device-settings` under a synthetic
    // `__device-state` addonId, one row per (device, cap). That is why the
    // named collection read zero on every installation while the state was
    // demonstrably surviving restarts, and why an eight-slice camera paid
    // nine statements per flush. The backend still READS the old prefix, so
    // nothing is lost across the upgrade.
    async readDeviceRuntimeState(deviceId: number): Promise<Record<string, unknown>> {
      return cm.getDeviceRuntimeState(String(deviceId))
    },
    async writeDeviceRuntimeState(deviceId: number, data: Record<string, unknown>): Promise<void> {
      // Replace, don't merge — the caller always hands over the full
      // persistable blob. Merging here would resurrect a slice the
      // durability policy has since stopped persisting.
      cm.setDeviceRuntimeState(String(deviceId), data)
    },
    async clearDeviceRuntimeState(deviceId: number): Promise<void> {
      cm.clearDeviceRuntimeState(String(deviceId))
    },
    async getSection(section: string): Promise<Record<string, unknown>> {
      return cm.getSection(section)
    },
    async setSection(section: string, patch: Record<string, unknown>): Promise<void> {
      const existing = cm.getSection(section)
      cm.setSection(section, { ...existing, ...patch })
    },
  }
}
