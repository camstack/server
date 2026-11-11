/**
 * The orchestrator's three id-keyed JSON maps become one row per id (D986 §2):
 *
 * - `nodeBindings` and `agentSettings` (a map keyed on node id) become node rows
 *   `<addonId>.<field>@<nodeId>` in `addon-settings`, carrying `nodeId`;
 * - `cameraSettings` (a map keyed on device id) becomes one device row
 *   `<addonId>:<deviceId>.cameraSettings` in `addon-device-settings`.
 *
 * Each entry is copied VERBATIM (the value of a row is the entry the map held), so a field the
 * schema does not know yet survives byte for byte. The mover leaves the map key in place; the
 * catalogue's last step (`drop-moved-maps`) deletes it once all three movers are applied.
 *
 * A row that already exists is never overwritten: it was written by the build that reads rows,
 * and a seed never overwrites. A plan that has nothing left to copy is empty, so a second run is
 * a no-op. A read that fails throws, and nothing is written. A map whose shape is not a map of
 * objects throws too: copying part of it would leave the readers with a half-moved store.
 */
import { type MigrationPlan, preconditionOf } from '@camstack/types'
import { ADDON_SETTINGS_TABLE, type DropKeysPorts } from './drop-keys.js'

/** The per-device settings table: one row per field, id `<addonId>:<deviceId>.<field>`. */
export const ADDON_DEVICE_SETTINGS_TABLE = 'addon-device-settings'

export interface BlobToRowsPorts extends DropKeysPorts {
  /**
   * The per-device rows of `field` that exist, by device id (a device without one is left out).
   * Throws when the store cannot be read.
   */
  readDeviceField(
    deviceIds: readonly number[],
    field: string,
  ): Promise<ReadonlyMap<number, unknown>>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A node id the orchestrator itself refuses to persist (`writeAgentSettings`): never a real node. */
const GHOST_NODE_IDS: ReadonlySet<string> = new Set(['', 'undefined', 'null'])

function entriesOf(
  field: string,
  blob: unknown,
): readonly (readonly [string, Readonly<Record<string, unknown>>])[] {
  if (blob === undefined) return []
  if (!isRecord(blob)) throw new Error(`${field} is not a map: it is left as it is`)
  return Object.entries(blob).map(([id, entry]) => {
    if (!isRecord(entry)) {
      throw new Error(`${field}[${id}] is not an object: nothing is copied, fix it and retry`)
    }
    return [id, entry] as const
  })
}

/** Copy each node's entry of `field` to its node row `<field>@<nodeId>`. */
export async function planBlobToNodeRows(
  addonId: string,
  field: string,
  ports: BlobToRowsPorts,
): Promise<MigrationPlan> {
  const blob = (await ports.readStored([field]))[field]
  const entries = entriesOf(field, blob).filter(
    ([nodeId]) => !GHOST_NODE_IDS.has(nodeId) && !nodeId.includes('@'),
  )
  if (entries.length === 0) return { edits: [] }
  const rowKey = (nodeId: string): string => `${field}@${nodeId}`
  const existing = await ports.readStored(entries.map(([nodeId]) => rowKey(nodeId)))
  const values: Record<string, Record<string, unknown>> = {}
  for (const [nodeId, entry] of entries) {
    if (rowKey(nodeId) in existing) continue
    values[`${addonId}.${rowKey(nodeId)}`] = {
      addonId,
      key: rowKey(nodeId),
      value: entry,
      nodeId,
    }
  }
  const ids = Object.keys(values)
  if (ids.length === 0) return { edits: [] }
  return {
    edits: [
      {
        op: 'setKeys',
        scope: ADDON_SETTINGS_TABLE,
        values,
        // Every target row was absent when the plan read; a row that appeared since refuses it.
        precondition: preconditionOf(Object.fromEntries(ids.map((id) => [id, null]))),
      },
    ],
  }
}

/** A device id as the blob spells it: a positive integer. */
function deviceIdOf(key: string): number | null {
  const id = Number(key)
  return Number.isInteger(id) && id > 0 && String(id) === key ? id : null
}

/** Copy each device's entry of `field` to its device row `<addonId>:<deviceId>.<field>`. */
export async function planBlobToDeviceRows(
  addonId: string,
  field: string,
  ports: BlobToRowsPorts,
): Promise<MigrationPlan> {
  const blob = (await ports.readStored([field]))[field]
  const entries = entriesOf(field, blob).flatMap(([key, entry]) => {
    const deviceId = deviceIdOf(key)
    return deviceId === null ? [] : [{ deviceId, entry }]
  })
  if (entries.length === 0) return { edits: [] }
  const existing = await ports.readDeviceField(
    entries.map((e) => e.deviceId),
    field,
  )
  const values: Record<string, Record<string, unknown>> = {}
  for (const { deviceId, entry } of entries) {
    if (existing.has(deviceId)) continue
    values[`${addonId}:${deviceId}.${field}`] = {
      addonId,
      deviceId: String(deviceId),
      key: field,
      value: entry,
    }
  }
  const ids = Object.keys(values)
  if (ids.length === 0) return { edits: [] }
  return {
    edits: [
      {
        op: 'setKeys',
        scope: ADDON_DEVICE_SETTINGS_TABLE,
        values,
        precondition: preconditionOf(Object.fromEntries(ids.map((id) => [id, null]))),
      },
    ],
  }
}
