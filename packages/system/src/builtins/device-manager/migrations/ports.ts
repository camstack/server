/**
 * The ports of the device-manager catalogue over the real stores: the addon's settings rows
 * (three-way read, so an unreadable key fails the migration instead of reading as "nothing to
 * move"), the raw device columns, and the room and zone records.
 */
import type { RecordKindHandle, RoomBody, StoredKeyRead, ZoneBody } from '@camstack/types'
import { readAllRows } from '../../../records/read-all-rows.js'
import type { DeviceRowStore } from '../device-row-store.js'
import type { DeviceManagerMigrationPorts } from './index.js'
import { DEVICE_MANAGER_ID } from './rooms-as-records.js'

export interface DeviceManagerPortsSource {
  readonly readStoredKey: (key: string) => Promise<StoredKeyRead>
  readonly rows: Pick<DeviceRowStore, 'readRawColumns'>
  readonly rooms: RecordKindHandle<RoomBody>
  readonly zones: RecordKindHandle<ZoneBody>
  /** An info line on the record (the addon's logger). */
  readonly report?: (message: string, meta: Readonly<Record<string, unknown>>) => void
}

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function deviceManagerMigrationPorts(
  source: DeviceManagerPortsSource,
): DeviceManagerMigrationPorts {
  return {
    readStored: async (keys) => {
      const found: Record<string, unknown> = {}
      for (const key of keys) {
        const answer = await source.readStoredKey(key)
        if (answer.kind === 'unreadable') {
          throw new Error(
            `${DEVICE_MANAGER_ID}: the setting ${key} cannot be read (${answer.reason})`,
          )
        }
        if (answer.kind === 'present') found[key] = answer.value
      }
      return found
    },
    readDeviceLocations: async () => {
      const rows = await source.rows.readRawColumns(['deviceId', 'location', 'locationId'])
      return rows.flatMap((row) => {
        const deviceId = row['deviceId']
        if (typeof deviceId !== 'number') return []
        return [
          {
            deviceId,
            location: stringOrNull(row['location']),
            locationId: stringOrNull(row['locationId']),
          },
        ]
      })
    },
    readDeviceTags: async () => {
      const rows = await source.rows.readRawColumns(['deviceId', 'tags', 'tagIds'])
      return rows.flatMap((row) => {
        const deviceId = row['deviceId']
        if (typeof deviceId !== 'number') return []
        return [
          {
            deviceId,
            tags: stringArray(row['tags']),
            hasTagIds: row['tagIds'] !== null && row['tagIds'] !== undefined,
          },
        ]
      })
    },
    readRoomIds: async () => new Set((await readAllRows(source.rooms)).map((row) => row.id)),
    readZoneIds: async () => new Set((await readAllRows(source.zones)).map((row) => row.id)),
    ...(source.report === undefined ? {} : { report: source.report }),
  }
}
