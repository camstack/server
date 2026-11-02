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
import { nodeIdOfScopedKey } from '@camstack/types/addon'
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
  /**
   * The cluster and fleet-default rows: every field with NO node suffix (D986). A node row
   * (`<field>@<nodeId>`) is never part of it.
   */
  readUnscoped(): Promise<AddonSettingsRead>
  /**
   * ONE node's rows, keyed by the BARE field. A primary-key range read over the addon's prefix,
   * filtered on the `@<nodeId>` suffix, so another node's value never leaks in.
   */
  readNode(nodeId: string): Promise<AddonSettingsRead>
  /** {@link merge} for one node: bare fields in, `<field>@<nodeId>` rows out, each carrying `nodeId`. */
  mergeNode(nodeId: string, patch: Readonly<Record<string, unknown>>): Promise<void>
}

/** Row data of a field: `nodeId` only on a node row (the key says which node). */
function rowData(
  addonId: string,
  key: string,
  value: unknown,
): { addonId: string; key: string; value: unknown; nodeId?: string } {
  const nodeId = nodeIdOfScopedKey(key)
  return nodeId === null ? { addonId, key, value } : { addonId, key, value, nodeId }
}

/**
 * The central delete of a forgotten node (D986, the node twin of `clearDeviceSettings`): every
 * `addon-settings` row of EVERY addon that carries this node id, in one statement. Matched on
 * the `nodeId` each node row carries. A cluster row, a fleet-default row and a device row have
 * none, so nothing else goes. Returns how many rows went.
 */
export async function clearNodeSettings(
  door: Pick<ISettingsStoreProvider, 'deleteWhere'>,
  nodeId: string,
): Promise<number> {
  if (nodeId === '') throw new Error('node settings: an empty node id names every node')
  const { deleted } = await door.deleteWhere({
    collection: ADDON_SETTINGS_COLLECTION,
    filter: { where: { nodeId } },
  })
  return deleted
}

/**
 * The cluster and fleet-default rows of one addon (no node suffix), through the `query` slice
 * alone, so a runner's client door serves it as hub-main's door does. Three-way like every read
 * here; the device resolver's fleet-default layer (D986).
 */
export async function readUnscopedAddonSettings(
  door: Pick<ISettingsStoreProvider, 'query'>,
  addonId: string,
): Promise<AddonSettingsRead> {
  try {
    const all = await loadPrefixed(door, ADDON_SETTINGS_COLLECTION, `${addonId}.`)
    const value = Object.fromEntries(
      Object.entries(all).filter(([key]) => nodeIdOfScopedKey(key) === null),
    )
    return Object.keys(value).length === 0 ? { kind: 'absent' } : { kind: 'present', value }
  } catch (err: unknown) {
    return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) }
  }
}

export function createAddonSettingsStore(
  door: AddonSettingsDoor,
  addonId: string,
): AddonSettingsStore {
  const prefix = `${addonId}.`
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
  const store: AddonSettingsStore = {
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
        else records.push({ id: `${prefix}${key}`, data: rowData(addonId, key, value) })
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

    readUnscoped: () => readUnscopedAddonSettings(door, addonId),

    async readNode(nodeId) {
      const all = await store.read()
      if (all.kind !== 'present') return all
      const value: Record<string, unknown> = {}
      for (const [key, field] of Object.entries(all.value)) {
        if (nodeIdOfScopedKey(key) !== nodeId) continue
        value[key.slice(0, key.indexOf('@'))] = field
      }
      return Object.keys(value).length === 0 ? { kind: 'absent' } : { kind: 'present', value }
    },

    async mergeNode(nodeId, patch) {
      if (nodeId === '') throw new Error('node settings: an empty node id names every node')
      const scoped: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) {
        if (key.includes('@')) throw new Error(`node settings: "${key}" is already scoped`)
        scoped[`${key}@${nodeId}`] = value
      }
      return store.merge(scoped)
    },
  }
  return store
}
