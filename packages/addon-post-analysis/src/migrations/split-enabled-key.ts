/**
 * The shared settings key `enabled` becomes two (D987, D986 §2).
 *
 * One key meant two things: "Face recognition on" and "Suppress parked objects". Toggling one
 * flipped the other. Each switch now has its own key. So today's behaviour does not change, the
 * value an install has stored under `enabled` is copied into BOTH new keys, and `enabled` is
 * deleted. That covers the cluster row (`addon-settings`) and every camera's own row
 * (`addon-device-settings`).
 *
 * A new key that already has a row is never overwritten (a seed never overwrites): it was written
 * by the build that reads it. The plan has nothing left to do once `enabled` is gone, so a rerun is
 * a no-op. A read that fails throws and nothing is written.
 */
import {
  type MigrationEdit,
  type MigrationPlan,
  preconditionOf,
  type StoredKeyRead,
} from '@camstack/types'

export const PIPELINE_ANALYTICS_ID = 'pipeline-analytics'
export const RETIRED_ENABLED_KEY = 'enabled'
export const FACE_ENABLED_KEY = 'faceRecognitionEnabled'
export const STATIONARY_ENABLED_KEY = 'stationarySuppressionEnabled'
const NEW_KEYS: readonly string[] = [FACE_ENABLED_KEY, STATIONARY_ENABLED_KEY]

/** The canonical settings table: one row per key, id `<addonId>.<key>`. */
const SETTINGS_TABLE = 'addon-settings'
/** The per-device settings table: one row per field, id `<addonId>:<deviceId>.<field>`. */
const DEVICE_SETTINGS_TABLE = 'addon-device-settings'

export interface EnabledSplitPorts {
  /** The addon's cluster rows as stored, for each of `keys` that has one. Throws when unreadable. */
  readStored(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>
  /** Every device id that has a per-device settings blob. Throws when unreadable. */
  listDeviceIds(): Promise<readonly number[]>
  /** The per-device rows of `field` that exist, by device id. Throws when unreadable. */
  readDeviceField(
    deviceIds: readonly number[],
    field: string,
  ): Promise<ReadonlyMap<number, unknown>>
}

function clusterEdits(stored: Readonly<Record<string, unknown>>): readonly MigrationEdit[] {
  if (!(RETIRED_ENABLED_KEY in stored)) return []
  const value = stored[RETIRED_ENABLED_KEY]
  const rowId = (key: string): string => `${PIPELINE_ANALYTICS_ID}.${key}`
  const missing = NEW_KEYS.filter((key) => !(key in stored))
  const edits: MigrationEdit[] = []
  if (missing.length > 0) {
    edits.push({
      op: 'setKeys',
      scope: SETTINGS_TABLE,
      values: Object.fromEntries(
        missing.map((key) => [rowId(key), { addonId: PIPELINE_ANALYTICS_ID, key, value }]),
      ),
      precondition: preconditionOf(Object.fromEntries(missing.map((key) => [rowId(key), null]))),
    })
  }
  edits.push({
    op: 'deleteKeys',
    scope: SETTINGS_TABLE,
    keys: [rowId(RETIRED_ENABLED_KEY)],
    precondition: preconditionOf({
      [rowId(RETIRED_ENABLED_KEY)]: {
        addonId: PIPELINE_ANALYTICS_ID,
        key: RETIRED_ENABLED_KEY,
        value,
      },
    }),
  })
  return edits
}

async function deviceEdits(ports: EnabledSplitPorts): Promise<readonly MigrationEdit[]> {
  const ids = await ports.listDeviceIds()
  if (ids.length === 0) return []
  const retired = await ports.readDeviceField(ids, RETIRED_ENABLED_KEY)
  if (retired.size === 0) return []
  const carriers = [...retired.keys()]
  const existing = new Map<string, ReadonlyMap<number, unknown>>()
  for (const key of NEW_KEYS) existing.set(key, await ports.readDeviceField(carriers, key))
  const rowId = (deviceId: number, field: string): string =>
    `${PIPELINE_ANALYTICS_ID}:${deviceId}.${field}`
  const created: Record<string, Record<string, unknown>> = {}
  const retiredRows: Record<string, Record<string, unknown>> = {}
  for (const [deviceId, value] of retired) {
    for (const key of NEW_KEYS) {
      if (existing.get(key)?.has(deviceId) === true) continue
      created[rowId(deviceId, key)] = {
        addonId: PIPELINE_ANALYTICS_ID,
        deviceId: String(deviceId),
        key,
        value,
      }
    }
    retiredRows[rowId(deviceId, RETIRED_ENABLED_KEY)] = {
      addonId: PIPELINE_ANALYTICS_ID,
      deviceId: String(deviceId),
      key: RETIRED_ENABLED_KEY,
      value,
    }
  }
  const edits: MigrationEdit[] = []
  const createdIds = Object.keys(created)
  if (createdIds.length > 0) {
    edits.push({
      op: 'setKeys',
      scope: DEVICE_SETTINGS_TABLE,
      values: created,
      precondition: preconditionOf(Object.fromEntries(createdIds.map((id) => [id, null]))),
    })
  }
  edits.push({
    op: 'deleteKeys',
    scope: DEVICE_SETTINGS_TABLE,
    keys: Object.keys(retiredRows),
    precondition: preconditionOf(retiredRows),
  })
  return edits
}

/** Copy `enabled` into both new keys (cluster row and every camera's row) and delete it. */
export async function planSplitEnabledKey(ports: EnabledSplitPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored([RETIRED_ENABLED_KEY, ...NEW_KEYS])
  return { edits: [...clusterEdits(stored), ...(await deviceEdits(ports))] }
}

/**
 * The port's read over an addon's three-way key read: each of `keys` that has a row, raw. A key
 * the store could not answer for throws, so the migration fails instead of treating a failed read
 * as "nothing to move".
 */
export async function readRawKeys(
  read: (key: string) => Promise<StoredKeyRead>,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  const found: Record<string, unknown> = {}
  for (const key of keys) {
    const answer = await read(key)
    if (answer.kind === 'unreadable') {
      throw new Error(
        `${PIPELINE_ANALYTICS_ID}: the setting ${key} cannot be read (${answer.reason})`,
      )
    }
    if (answer.kind === 'present') found[key] = answer.value
  }
  return found
}
