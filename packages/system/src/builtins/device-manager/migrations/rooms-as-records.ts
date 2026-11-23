/**
 * Rooms and site zones become records with an id (D1089, step 1 of the migration).
 *
 * Before: a room was a LABEL. The registry (`locations`), its icon and description maps
 * and the two zone maps (`siteZones`, `locationZones`) lived as keys of the addon store,
 * and a device carried the label in its `location` column.
 *
 * After: one `rooms` record per label and one `zones` record per site zone, with an id
 * derived from the folded name (`roomIdFromKey` / `zoneIdFromKey`, so a rerun and a
 * restored older snapshot reach the same ids); a device carries `locationId`; the maps and
 * the `location` column are gone.
 *
 * ONE plan, so ONE transaction with the ledger row: the records, the device rows and the
 * deleted keys land together or not at all. A rerun finds no legacy key and no device with
 * a `location`, and the plan is empty. A record that already exists is never rewritten (a
 * seed never overwrites): a room an operator edited after a partial restore keeps its edit.
 *
 * The display spelling is the registry's, else the one most devices use (the first
 * alphabetically on a tie), else the folded key a map entry carries.
 */
import {
  type MigrationEdit,
  type MigrationPlan,
  preconditionOf,
  recordUpsertEdit,
  type RoomBody,
  roomIdFromKey,
  ROOM_NAME_MAX_LENGTH,
  type ZoneBody,
  zoneIdFromKey,
  locationIconKey,
} from '@camstack/types'
import { decodeAddonStore } from '../device-meta-types.js'
import { DEVICE_ROWS_COLLECTION } from '../device-row-store.js'
import { deviceManagerRecordKinds } from '../record-kinds.js'

export const DEVICE_MANAGER_ID = 'device-manager'
export const ROOMS_AS_RECORDS_ID = 'device-manager/2026-11-23-rooms-as-records'

/** The canonical settings table: one row per key, id `<addonId>.<key>`. */
const ADDON_SETTINGS_TABLE = 'addon-settings'

/** The addon-store keys this migration retires. */
export const LEGACY_ROOM_KEYS: readonly string[] = [
  'locations',
  'locationIcons',
  'locationDescriptions',
  'siteZones',
  'locationZones',
]

/** The two plain columns of a device row this migration owns, as stored. */
export interface DeviceLocationColumns {
  readonly deviceId: number
  readonly location: string | null
  readonly locationId: string | null
}

export interface RoomsMigrationPorts {
  /** The addon's rows as stored, markers kept, for each of `keys` that has a row. */
  readStored(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>
  /** Every device row's `location` and `locationId` columns, raw. Throws when unreadable. */
  readDeviceLocations(): Promise<readonly DeviceLocationColumns[]>
  /** The ids of the `rooms` and `zones` records that already exist. */
  readRoomIds(): Promise<ReadonlySet<string>>
  readZoneIds(): Promise<ReadonlySet<string>>
}

const settingsRowId = (key: string): string => `${DEVICE_MANAGER_ID}.${key}`

function clip(name: string): string {
  return name.trim().slice(0, ROOM_NAME_MAX_LENGTH)
}

/** The spelling to show for each folded room key: registry first, else the most used on devices. */
function spellings(
  registry: readonly string[],
  devices: readonly DeviceLocationColumns[],
): Map<string, string> {
  const out = new Map<string, string>()
  for (const label of registry) {
    const key = locationIconKey(label)
    if (key.length > 0 && !out.has(key)) out.set(key, clip(label))
  }
  const used = new Map<string, Map<string, number>>()
  for (const { location } of devices) {
    if (location === null) continue
    const key = locationIconKey(location)
    if (key.length === 0) continue
    const counts = used.get(key) ?? new Map<string, number>()
    counts.set(location.trim(), (counts.get(location.trim()) ?? 0) + 1)
    used.set(key, counts)
  }
  for (const [key, counts] of used) {
    if (out.has(key)) continue
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    if (best !== undefined) out.set(key, clip(best[0]))
  }
  return out
}

export async function planRoomsAsRecords(ports: RoomsMigrationPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored(LEGACY_ROOM_KEYS)
  const store = decodeAddonStore(stored)
  const devices = await ports.readDeviceLocations()
  const existingRooms = await ports.readRoomIds()
  const existingZones = await ports.readZoneIds()

  const names = spellings(store.locations ?? [], devices)
  // A key only a map names still becomes a room: its icon or description is the operator's work.
  for (const key of [
    ...Object.keys(store.locationIcons ?? {}),
    ...Object.keys(store.locationDescriptions ?? {}),
    ...Object.keys(store.locationZones ?? {}),
  ]) {
    const folded = locationIconKey(key)
    if (folded.length > 0 && !names.has(folded)) names.set(folded, clip(key))
  }

  const zones = store.siteZones ?? {}
  const membership = store.locationZones ?? {}
  const edits: MigrationEdit[] = []

  for (const [zoneKey, zone] of Object.entries(zones)) {
    const id = zoneIdFromKey(zoneKey)
    if (existingZones.has(id)) continue
    const body: ZoneBody = {
      name: clip(zone.label),
      ...(zone.icon === undefined ? {} : { icon: zone.icon }),
    }
    edits.push(
      recordUpsertEdit({
        owner: DEVICE_MANAGER_ID,
        kind: deviceManagerRecordKinds.zones,
        id,
        data: body,
        read: null,
      }),
    )
  }

  for (const [key, name] of names) {
    const id = roomIdFromKey(key)
    if (existingRooms.has(id)) continue
    const icon = store.locationIcons?.[key]
    const description = store.locationDescriptions?.[key]
    const zoneKey = membership[key]
    const zoneId =
      zoneKey !== undefined && zones[zoneKey] !== undefined ? zoneIdFromKey(zoneKey) : undefined
    const body: RoomBody = {
      name,
      ...(icon === undefined ? {} : { icon }),
      ...(description === undefined ? {} : { description }),
      ...(zoneId === undefined ? {} : { zoneId }),
    }
    edits.push(
      recordUpsertEdit({
        owner: DEVICE_MANAGER_ID,
        kind: deviceManagerRecordKinds.rooms,
        id,
        data: body,
        read: null,
      }),
    )
  }

  for (const device of devices) {
    if (device.location === null) continue
    const folded = locationIconKey(device.location)
    const locationId = device.locationId ?? (folded.length === 0 ? null : roomIdFromKey(folded))
    edits.push({
      op: 'putRow',
      table: DEVICE_ROWS_COLLECTION,
      key: { deviceId: device.deviceId },
      row: { locationId, location: null },
      // Only the two plain columns this edit owns: a write to any other column of the row
      // (a name, a tag) between the read and the apply does not refuse the plan.
      preconditionColumns: ['location', 'locationId'],
      precondition: preconditionOf({ location: device.location, locationId: device.locationId }),
    })
  }

  const present = LEGACY_ROOM_KEYS.filter((key) => key in stored)
  if (present.length > 0) {
    edits.push({
      op: 'deleteKeys',
      scope: ADDON_SETTINGS_TABLE,
      keys: present.map(settingsRowId),
      precondition: preconditionOf(
        Object.fromEntries(
          present.map((key) => [
            settingsRowId(key),
            { addonId: DEVICE_MANAGER_ID, key, value: stored[key] },
          ]),
        ),
      ),
    })
  }
  return { edits }
}
