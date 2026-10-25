/**
 * The ONE addon-level settings store (D870): collection `addon-settings`, one
 * row per field, id `<addonId>.<field>`, row data `{ addonId, key, value }` -
 * hub-main's layout, now also the forked runner's.
 *
 * Before D870 a runner kept a blob of its own (`<addonId>:addon-settings`,
 * key `root`) next to the hub-main rows, so the two processes read different
 * tables for the same addon. The rules are the per-device store's
 * ({@link ./device-settings-store.ts}): reads are three-way, a write is ONE
 * `transact`, a merge never reads, errors propagate.
 */
import type { ISettingsStoreProvider } from '@camstack/types'
import { prefixRange } from '../builtins/sqlite-storage/prefix-range.js'
import { loadPrefixed, unwrapStoredValue } from './prefix-walk.js'

/** The collection every addon's settings share. Named nowhere else (with sections' own module). */
const ADDON_SETTINGS_COLLECTION = 'addon-settings'

/** The door slice the module needs. */
export type AddonSettingsDoor = Pick<ISettingsStoreProvider, 'query' | 'get' | 'transact'>

/** Three-way answer for an addon's whole settings record. */
export type AddonSettingsRead =
  | { readonly kind: 'present'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly error: string }

/** Three-way answer for one field. */
export type AddonSettingKeyRead =
  | { readonly kind: 'present'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly error: string }

export interface AddonSettingsStore {
  /** Every field of the addon; `absent` when the store answered with no row. */
  read(): Promise<AddonSettingsRead>
  /** ONE row, never the addon's whole range. */
  readKey(key: string): Promise<AddonSettingKeyRead>
  /** Set the fields of `patch`; a field whose value is `undefined` is removed. ONE transaction, no read. */
  merge(patch: Readonly<Record<string, unknown>>): Promise<void>
}

export function createAddonSettingsStore(
  door: AddonSettingsDoor,
  addonId: string,
): AddonSettingsStore {
  const prefix = `${addonId}.`
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
  return {
    async read() {
      try {
        const value = await loadPrefixed(door, ADDON_SETTINGS_COLLECTION, prefix)
        return Object.keys(value).length === 0 ? { kind: 'absent' } : { kind: 'present', value }
      } catch (err: unknown) {
        return { kind: 'unreadable', error: message(err) }
      }
    },

    async readKey(key) {
      try {
        const row = await door.get({
          collection: ADDON_SETTINGS_COLLECTION,
          key: `${prefix}${key}`,
        })
        return row === undefined || row === null
          ? { kind: 'absent' }
          : { kind: 'present', value: unwrapStoredValue(row) }
      } catch (err: unknown) {
        return { kind: 'unreadable', error: message(err) }
      }
    },

    async merge(patch) {
      const records: { id: string; data: Record<string, unknown> }[] = []
      const removed: string[] = []
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) removed.push(`${prefix}${key}`)
        else records.push({ id: `${prefix}${key}`, data: { addonId, key, value } })
      }
      if (records.length === 0 && removed.length === 0) return
      if (prefixRange(prefix) === null) {
        throw new Error(`addon settings: "${addonId}" cannot be expressed as an id range`)
      }
      await door.transact({
        ops: [
          ...(removed.length > 0
            ? [
                {
                  op: 'deleteWhere' as const,
                  collection: ADDON_SETTINGS_COLLECTION,
                  filter: { whereIn: { id: removed } },
                },
              ]
            : []),
          ...(records.length > 0
            ? [
                {
                  op: 'upsertMany' as const,
                  collection: ADDON_SETTINGS_COLLECTION,
                  conflict: ['id'],
                  records,
                },
              ]
            : []),
        ],
      })
    },
  }
}
