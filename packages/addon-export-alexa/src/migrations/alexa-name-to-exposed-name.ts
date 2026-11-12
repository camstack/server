/**
 * The Alexa-only device name becomes the generic exposed name (D1049, amending D875).
 *
 * Before: one `alexaName` per device in this addon's per-device store (`addon-device-settings`,
 * row `export-alexa:<deviceId>.alexaName`), and every skill of the addon (planning#422) showed
 * it. After: the `device-export` exposed name of EVERY skill that exists, row
 * `export-alexa:<deviceId>.exposedNames` = `{ <skillId>: name, … }` — so each skill keeps calling
 * the device what it called it. A skill id that has no `skills` record (the default one on a hub
 * that never configured Alexa) gets nothing: no running skill would read it.
 *
 * One plan, so the copy and the delete commit together. A name is copied as Alexa read it
 * (normalised; a stored value Alexa would have refused was never used and is not copied). A name
 * already saved for a skill through the new field was saved by the build that reads it, so it is
 * never overwritten; the other skills of that device still get the old name. The legacy key is
 * deleted in every case: nothing reads it any more. A rerun finds no legacy key and does nothing.
 * A read that fails throws, nothing written.
 */
import {
  EXPOSED_NAMES_STORE_KEY,
  type MigrationEdit,
  type MigrationPlan,
  preconditionOf,
} from '@camstack/types'
import { LEGACY_ALEXA_NAME_KEY, validateAlexaName } from '../endpoints/alexa-name.js'

const OWNER = 'export-alexa'
/** The per-device settings table: one row per field, id `<addonId>:<deviceId>.<field>`. */
const DEVICE_SETTINGS_TABLE = 'addon-device-settings'

export interface AlexaNameMovePorts {
  warn(message: string): void
  /** The id of every Alexa skill that has a `skills` record, enabled or not. Throws when unreadable. */
  listSkillIds(): Promise<readonly string[]>
  /** Every device id this addon holds a per-device store for. Throws when unreadable. */
  listDeviceIds(): Promise<readonly number[]>
  /** The per-device values of `field` that exist, by device id. Throws when unreadable. */
  readDeviceField(
    deviceIds: readonly number[],
    field: string,
  ): Promise<ReadonlyMap<number, unknown>>
}

const rowId = (deviceId: number, field: string): string => `${OWNER}:${deviceId}.${field}`
const rowOf = (deviceId: number, field: string, value: unknown): Record<string, unknown> => ({
  addonId: OWNER,
  deviceId: String(deviceId),
  key: field,
  value,
})

/** The held `exposedNames` blob as a record, or `{}` when it is not one. */
function heldNames(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value))
}

export async function planAlexaNameToExposedName(
  ports: AlexaNameMovePorts,
): Promise<MigrationPlan> {
  const ids = await ports.listDeviceIds()
  if (ids.length === 0) return { edits: [] }
  const legacy = await ports.readDeviceField(ids, LEGACY_ALEXA_NAME_KEY)
  if (legacy.size === 0) return { edits: [] }
  const skills = await ports.listSkillIds()
  const held = await ports.readDeviceField([...legacy.keys()], EXPOSED_NAMES_STORE_KEY)

  const written: Record<string, Record<string, unknown>> = {}
  const expected: Record<string, Record<string, unknown> | null> = {}
  const retired: Record<string, Record<string, unknown>> = {}
  for (const [deviceId, stored] of legacy) {
    retired[rowId(deviceId, LEGACY_ALEXA_NAME_KEY)] = rowOf(deviceId, LEGACY_ALEXA_NAME_KEY, stored)
    const check = validateAlexaName(stored)
    if (!check.ok || check.name === null) continue
    if (skills.length === 0) {
      ports.warn(
        `Alexa migration: device ${deviceId} had an Alexa name but no Alexa skill exists; it is not kept`,
      )
      continue
    }
    const before = held.has(deviceId) ? heldNames(held.get(deviceId)) : null
    const merged: Record<string, unknown> = { ...before }
    for (const skillId of skills) {
      if (skillId in merged) {
        ports.warn(
          `Alexa migration: device ${deviceId} already has a name on skill ${skillId}; its old Alexa name is not copied there`,
        )
        continue
      }
      merged[skillId] = check.name
    }
    if (before !== null && Object.keys(merged).length === Object.keys(before).length) continue
    const id = rowId(deviceId, EXPOSED_NAMES_STORE_KEY)
    written[id] = rowOf(deviceId, EXPOSED_NAMES_STORE_KEY, merged)
    expected[id] =
      before === null ? null : rowOf(deviceId, EXPOSED_NAMES_STORE_KEY, held.get(deviceId))
  }

  const edits: MigrationEdit[] = []
  if (Object.keys(written).length > 0) {
    edits.push({
      op: 'setKeys',
      scope: DEVICE_SETTINGS_TABLE,
      values: written,
      precondition: preconditionOf(expected),
    })
  }
  edits.push({
    op: 'deleteKeys',
    scope: DEVICE_SETTINGS_TABLE,
    keys: Object.keys(retired),
    precondition: preconditionOf(retired),
  })
  return { edits }
}
