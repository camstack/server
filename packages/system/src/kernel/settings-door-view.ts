/**
 * `AddonSettingsView` backed by the async `settings-store` door, not by a
 * synchronous `ISettingsStore` handle on the engine.
 *
 * Isolating sqlite-settings removes that handle from hub-main: the UDS proxy
 * for `data-store-provider` does not implement `getAllAddon` /
 * `setDeviceRuntimeState`. The door already does, as `get` / `set` / `query`,
 * and those calls `await` — so hub-main can yield while the engine's
 * `Statement.run` occupies the child.
 *
 * Storage layout is the in-process one (`addon-settings` keys
 * `"<addonId>.<key>"`, runtime state in `device-runtime-state`), not the
 * forked-runner namespaced tables. Device-manager still lives here.
 */
import type { ISettingsStoreProvider, StoredKeyRead } from '@camstack/types'
import { createAddonSettingsStore } from './addon-settings-store.js'
import { createDeviceSettingsStore, readDeviceOrThrow } from './device-settings-store.js'
import { loadPrefixed } from './prefix-walk.js'
import type { SettingsViewBackend } from './settings-view-types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asBlob(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/**
 * Every `system-settings` row under `prefix`, keyed by the suffix — or a throw.
 *
 * `system-settings` stores the value ITSELF (`setSystem` / `door.set` write
 * `JSON.stringify(value)`), mostly scalars. The engine's `query` hands a KV row
 * back parsed only when its text is an object or an array; a scalar comes back
 * as `{ value: <its JSON text> }` — `"12h"` arrives as `{ value: '"12h"' }`.
 * That is not a value anyone stored, and guessing it back would misread a
 * stored object that happens to be `{ value: … }`. So the range read only
 * ENUMERATES the keys (same keyset walk and refusal as every prefix read
 * here), and each value is taken from `get`, which parses the row exactly
 * (D675). These reads are small and rare: a section's handful of keys when a
 * form opens, and the capability preferences once at boot.
 */
export async function loadSystemSettingsPrefix(
  door: Pick<ISettingsStoreProvider, 'query' | 'get'>,
  prefix: string,
  /** Suffixes the caller may read. A refused one is never FETCHED — the
   *  `auth` section's credential rows never enter this process (D675). */
  mayRead: (suffix: string) => boolean = () => true,
): Promise<Record<string, unknown>> {
  const listed = await loadPrefixed(door, 'system-settings', prefix, () => null)
  const result: Record<string, unknown> = {}
  for (const suffix of Object.keys(listed).filter(mayRead)) {
    const value = await door.get({ collection: 'system-settings', key: `${prefix}${suffix}` })
    // Deleted between the listing and the read: it is not stored any more.
    if (value !== undefined) result[suffix] = value
  }
  return result
}

/**
 * The `system-settings` section surface a door-backed view delegates to.
 * `getSection` is ASYNC: it reads the section through the door (D675) — a
 * synchronous reader has no store to ask when the engine is isolated.
 */
export interface DoorSectionAccess {
  getSection(section: string): Promise<Record<string, unknown>>
  setSection(section: string, patch: Record<string, unknown>): void | Promise<void>
}

export function createDoorSettingsView(
  addonId: string,
  door: ISettingsStoreProvider,
  sections: DoorSectionAccess,
): SettingsViewBackend {
  const addonStore = createAddonSettingsStore(door, addonId)
  const deviceStore = createDeviceSettingsStore(door, addonId)
  return {
    async readAddonStore(): Promise<Record<string, unknown>> {
      const read = await addonStore.read()
      switch (read.kind) {
        case 'present':
          return { ...read.value }
        case 'absent':
          return {}
        case 'unreadable':
          throw new Error(`settings of "${addonId}" could not be read: ${read.error}`)
      }
    },
    // ONE row - `"<addonId>.<key>"` - never the addon's whole range (D675).
    // Exactly three-way: `absent` is a row nobody wrote, `unreadable` a store
    // that did not answer.
    async readAddonStoreKeyResult(key: string): Promise<StoredKeyRead> {
      const read = await addonStore.readKey(key)
      return read.kind === 'unreadable'
        ? { kind: 'unreadable', reason: 'store-read-failed', error: read.error }
        : read
    },
    writeAddonStore: (patch) => addonStore.merge(patch),
    async readDeviceStore(deviceId: number): Promise<Record<string, unknown>> {
      return readDeviceOrThrow(deviceStore, deviceId)
    },
    readDeviceStoreBatch: (deviceIds) => deviceStore.readBatch(deviceIds),
    listDeviceStoreIds: () => deviceStore.listIds(),
    writeDeviceStore: (deviceId, patch) => deviceStore.merge(deviceId, patch),
    clearDeviceStore: (deviceId) => deviceStore.clear(deviceId),
    async readDeviceRuntimeState(deviceId: number): Promise<Record<string, unknown>> {
      return asBlob(await door.get({ collection: 'device-runtime-state', key: String(deviceId) }))
    },
    async writeDeviceRuntimeState(deviceId: number, data: Record<string, unknown>): Promise<void> {
      await door.set({
        collection: 'device-runtime-state',
        key: String(deviceId),
        value: data,
      })
    },
    async clearDeviceRuntimeState(deviceId: number): Promise<void> {
      await door.delete({
        collection: 'device-runtime-state',
        key: String(deviceId),
      })
    },
    async getSection(section: string): Promise<Record<string, unknown>> {
      return sections.getSection(section)
    },
    async setSection(section: string, patch: Record<string, unknown>): Promise<void> {
      await sections.setSection(section, patch)
    },
  }
}
