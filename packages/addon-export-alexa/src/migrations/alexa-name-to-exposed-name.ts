/**
 * The Alexa-only device name becomes the generic exposed name (D1049, amending D875).
 *
 * Before: one `alexaName` per device in this addon's per-device store (`addon-device-settings`,
 * row `export-alexa:<deviceId>.alexaName`). After: the `device-export` exposed name of the
 * default Alexa instance, row `export-alexa:<deviceId>.exposedNames` = `{ 'export-alexa': name }`.
 *
 * One plan, so the copy and the delete commit together. A name is copied as Alexa read it
 * (normalised; a stored value Alexa would have refused was never used and is not copied). A
 * device that already has an `exposedNames` row was named through the new field by the build that
 * reads it, so it is never overwritten. The legacy key is deleted in every case: nothing reads it
 * any more. A rerun finds no legacy key and does nothing. A read that fails throws, nothing written.
 */
import {
  EXPOSED_NAMES_STORE_KEY,
  type MigrationEdit,
  type MigrationPlan,
  preconditionOf,
} from '@camstack/types'
import { LEGACY_ALEXA_NAME_KEY, validateAlexaName } from '../endpoints/alexa-name.js'
import { ALEXA_INSTANCE_ID } from '../skill-records.js'

const OWNER = 'export-alexa'
/** The per-device settings table: one row per field, id `<addonId>:<deviceId>.<field>`. */
const DEVICE_SETTINGS_TABLE = 'addon-device-settings'

export interface AlexaNameMovePorts {
  warn(message: string): void
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

export async function planAlexaNameToExposedName(
  ports: AlexaNameMovePorts,
): Promise<MigrationPlan> {
  const ids = await ports.listDeviceIds()
  if (ids.length === 0) return { edits: [] }
  const legacy = await ports.readDeviceField(ids, LEGACY_ALEXA_NAME_KEY)
  if (legacy.size === 0) return { edits: [] }
  const held = await ports.readDeviceField([...legacy.keys()], EXPOSED_NAMES_STORE_KEY)

  const created: Record<string, Record<string, unknown>> = {}
  const retired: Record<string, Record<string, unknown>> = {}
  for (const [deviceId, stored] of legacy) {
    retired[rowId(deviceId, LEGACY_ALEXA_NAME_KEY)] = rowOf(deviceId, LEGACY_ALEXA_NAME_KEY, stored)
    if (held.has(deviceId)) {
      ports.warn(
        `Alexa migration: device ${deviceId} already has an exposed name; its old Alexa name is not copied`,
      )
      continue
    }
    const check = validateAlexaName(stored)
    if (!check.ok || check.name === null) continue
    created[rowId(deviceId, EXPOSED_NAMES_STORE_KEY)] = rowOf(deviceId, EXPOSED_NAMES_STORE_KEY, {
      [ALEXA_INSTANCE_ID]: check.name,
    })
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
    keys: Object.keys(retired),
    precondition: preconditionOf(retired),
  })
  return { edits }
}
