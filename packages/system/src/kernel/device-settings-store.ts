/**
 * The ONE per-device settings store (D870): collection `addon-device-settings`,
 * one row per field, id `<addonId>:<deviceId>.<field>`, row data
 * `{ addonId, deviceId, key, value }`.
 *
 * Every process reaches it through this module — hub-main with the settings
 * door, a forked runner with an adapter over its `settingsStore` client — so the
 * two views cannot disagree about where a device's settings live. This is the
 * only module that names the collection (guard: `check-device-settings-standard`).
 *
 * Rules the module holds, each one an incident:
 *  - A read is THREE-way. A failed read is `unreadable`, never `{}` (D49): every
 *    caller that merges would otherwise persist its patch alone and destroy the
 *    rest (the recorder configuration, 2026-07-31).
 *  - A write is ONE `transact` (upserts + deletes together). The old
 *    `deleteWhere` + N `set` window is where a reader, or a crash, saw a device
 *    with half its settings; on 2026-10-17 that window stopped all recordings.
 *  - A merge never reads: one row per field means two writers touching
 *    different fields cannot overwrite each other, and nothing needs a
 *    read-modify-write.
 *  - Errors propagate. Nothing here swallows one.
 */
import type { ISettingsStoreProvider } from '@camstack/types'
import { prefixRange } from '../builtins/sqlite-storage/prefix-range.js'
import { loadPrefixed } from './prefix-walk.js'

/** The collection every addon's per-device settings share. Named nowhere else. */
const DEVICE_SETTINGS_COLLECTION = 'addon-device-settings'

/** The slice of the settings store the module needs; the door or a client adapter. */
export type DeviceSettingsDoor = Pick<ISettingsStoreProvider, 'query' | 'transact' | 'deleteWhere'>

/** Three-way answer for one device's settings. */
export type DeviceSettingsRead =
  | { readonly kind: 'present'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly error: string }

/** One addon's view of the per-device settings store. */
export interface DeviceSettingsStore {
  /** The device's fields; `absent` when the store answered with no row. */
  read(deviceId: number): Promise<DeviceSettingsRead>
  /**
   * An entry for EVERY id asked for (`{}` for a device with no rows — the store
   * answered). THROWS when the store could not be asked or answered partially.
   */
  readBatch(deviceIds: readonly number[]): Promise<ReadonlyMap<number, Record<string, unknown>>>
  /** Ids this addon holds at least one row for, ascending. Throws on a failed read. */
  listIds(): Promise<readonly number[]>
  /**
   * Set the fields of `patch`; a field whose value is `undefined` is removed.
   * ONE transaction, no read.
   */
  merge(deviceId: number, patch: Readonly<Record<string, unknown>>): Promise<void>
  /** Remove every field of this addon for the device (one statement). */
  clear(deviceId: number): Promise<void>
}

function scopeOf(addonId: string, deviceId: number): string {
  return `${addonId}:${String(deviceId)}.`
}

function assertDeviceId(deviceId: number): void {
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    throw new Error(`device settings: "${String(deviceId)}" is not a device id`)
  }
}

function deviceIdOfSuffix(suffix: string): number | null {
  const dot = suffix.indexOf('.')
  if (dot <= 0) return null
  const id = Number(suffix.slice(0, dot))
  return Number.isInteger(id) && id > 0 ? id : null
}

/** Every field row of one device scope, or a throw. */
async function readScope(
  door: DeviceSettingsDoor,
  addonId: string,
  deviceId: number,
): Promise<Record<string, unknown>> {
  return loadPrefixed(door, DEVICE_SETTINGS_COLLECTION, scopeOf(addonId, deviceId))
}

export function createDeviceSettingsStore(
  door: DeviceSettingsDoor,
  addonId: string,
): DeviceSettingsStore {
  return {
    async read(deviceId: number): Promise<DeviceSettingsRead> {
      try {
        assertDeviceId(deviceId)
        const value = await readScope(door, addonId, deviceId)
        return Object.keys(value).length === 0 ? { kind: 'absent' } : { kind: 'present', value }
      } catch (err: unknown) {
        return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) }
      }
    },

    async readBatch(deviceIds) {
      const out = new Map<number, Record<string, unknown>>()
      if (deviceIds.length === 0) return out
      for (const id of deviceIds) out.set(id, {})
      // ONE range read for the whole addon, then a group-by: the ids of a fleet
      // listing are not contiguous, so per-id ranges would be per-id queries.
      const wanted = new Set(deviceIds)
      const prefix = `${addonId}:`
      const all = await loadPrefixed(door, DEVICE_SETTINGS_COLLECTION, prefix)
      for (const [suffix, value] of Object.entries(all)) {
        const id = deviceIdOfSuffix(suffix)
        if (id === null || !wanted.has(id)) continue
        const blob = out.get(id)
        if (blob !== undefined) blob[suffix.slice(suffix.indexOf('.') + 1)] = value
      }
      return out
    },

    async listIds() {
      const all = await loadPrefixed(door, DEVICE_SETTINGS_COLLECTION, `${addonId}:`, () => null)
      const ids = new Set<number>()
      for (const suffix of Object.keys(all)) {
        const id = deviceIdOfSuffix(suffix)
        if (id !== null) ids.add(id)
      }
      return [...ids].toSorted((a, b) => a - b)
    },

    async merge(deviceId, patch) {
      assertDeviceId(deviceId)
      const scope = scopeOf(addonId, deviceId)
      const records: { id: string; data: Record<string, unknown> }[] = []
      const removed: string[] = []
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) removed.push(`${scope}${key}`)
        else {
          records.push({
            id: `${scope}${key}`,
            data: { addonId, deviceId: String(deviceId), key, value },
          })
        }
      }
      if (records.length === 0 && removed.length === 0) return
      await door.transact({
        ops: [
          ...(removed.length > 0
            ? [
                {
                  op: 'deleteWhere' as const,
                  collection: DEVICE_SETTINGS_COLLECTION,
                  filter: { whereIn: { id: removed } },
                },
              ]
            : []),
          ...(records.length > 0
            ? [
                {
                  op: 'upsertMany' as const,
                  collection: DEVICE_SETTINGS_COLLECTION,
                  conflict: ['id'],
                  records,
                },
              ]
            : []),
        ],
      })
    },

    async clear(deviceId) {
      assertDeviceId(deviceId)
      const range = prefixRange(scopeOf(addonId, deviceId))
      if (range === null) throw new Error(`device settings: no id range for addon "${addonId}"`)
      await door.deleteWhere({
        collection: DEVICE_SETTINGS_COLLECTION,
        filter: { whereBetween: { id: [range.lo, range.hi] } },
      })
    },
  }
}

/** The `Record` form of a read: `{}` for a store that answered with no row, a THROW for one that did not. */
export async function readDeviceOrThrow(
  store: Pick<DeviceSettingsStore, 'read'>,
  deviceId: number,
): Promise<Record<string, unknown>> {
  const read = await store.read(deviceId)
  switch (read.kind) {
    case 'present':
      return { ...read.value }
    case 'absent':
      return {}
    case 'unreadable':
      throw new Error(`device settings of ${String(deviceId)} could not be read: ${read.error}`)
  }
}

/**
 * Remove a device's rows for EVERY addon, in one statement (D865's central
 * delete). Matched on the device id each row carries, so no addon needs a
 * handler. Returns how many rows went.
 */
export async function clearDeviceSettings(
  door: Pick<ISettingsStoreProvider, 'deleteWhere'>,
  deviceId: number,
): Promise<number> {
  assertDeviceId(deviceId)
  const { deleted } = await door.deleteWhere({
    collection: DEVICE_SETTINGS_COLLECTION,
    filter: { where: { deviceId: String(deviceId) } },
  })
  return deleted
}

/** Rows one page of the scope walk asks for. */
const SCOPE_PAGE_ROWS = 1_000
/** Pages the walk may take before it refuses (a bound, never a silent cut). */
const SCOPE_PAGE_BUDGET = 512
/** Above every id: ids are ASCII. */
const SCOPE_TAIL = '\u007f'

/** One (addon, device) pair that holds at least one settings row. */
export interface DeviceSettingsScope {
  readonly deviceId: number
  readonly addonId: string
}

/**
 * Every (addon, device) pair holding rows, across all addons - the admin
 * "deleted devices" listing. A keyset walk by primary key (never one query cut
 * at a row cap): a read that cannot be completed THROWS.
 */
export async function listDeviceSettingsScopes(
  door: Pick<ISettingsStoreProvider, 'query'>,
): Promise<readonly DeviceSettingsScope[]> {
  const seen = new Map<string, DeviceSettingsScope>()
  let cursor = ''
  for (let page = 0; ; page++) {
    if (page >= SCOPE_PAGE_BUDGET) {
      throw new Error(
        `device settings scopes: more than ${SCOPE_PAGE_BUDGET} pages - refusing a partial list`,
      )
    }
    const rows = await door.query({
      collection: DEVICE_SETTINGS_COLLECTION,
      filter: {
        whereBetween: { id: [cursor, SCOPE_TAIL] },
        orderBy: { field: 'id', direction: 'asc' },
        limit: SCOPE_PAGE_ROWS,
      },
    })
    for (const row of rows) {
      const addonId = row.data['addonId']
      const raw = row.data['deviceId']
      if (typeof addonId !== 'string' || typeof raw !== 'string') continue
      const deviceId = Number(raw)
      if (!Number.isInteger(deviceId) || deviceId <= 0) continue
      seen.set(`${addonId}:${deviceId}`, { deviceId, addonId })
    }
    const last = rows[rows.length - 1]
    if (rows.length < SCOPE_PAGE_ROWS || last === undefined) return [...seen.values()]
    if (last.id === cursor) {
      throw new Error(`device settings scopes: no progress at "${last.id}"`)
    }
    cursor = last.id
  }
}
