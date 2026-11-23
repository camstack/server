import type { AddonMigration } from '@camstack/types'
import { DEVICE_TAG_IDS_ID, type DeviceTagIdsPorts, planDeviceTagIds } from './device-tag-ids.js'
import {
  DEVICE_MANAGER_ID,
  planRoomsAsRecords,
  ROOMS_AS_RECORDS_ID,
  type RoomsMigrationPorts,
} from './rooms-as-records.js'

export { DEVICE_TAG_IDS_ID } from './device-tag-ids.js'
export { ROOMS_AS_RECORDS_ID } from './rooms-as-records.js'

export type DeviceManagerMigrationPorts = RoomsMigrationPorts & DeviceTagIdsPorts

/** The `device-manager` catalogue (D987), offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<DeviceManagerMigrationPorts>[] = [
  {
    meta: {
      id: ROOMS_AS_RECORDS_ID,
      owner: DEVICE_MANAGER_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Rooms and site zones become records with an id: one record per label, a locationId on each device, and the label maps and the location column deleted, in one transaction',
      fixtureMark: 'a device column and a room icon the migration does not know',
    },
    plan: (ports) => planRoomsAsRecords(ports),
  },
  {
    meta: {
      id: DEVICE_TAG_IDS_ID,
      owner: DEVICE_MANAGER_ID,
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Add the ids of its tags to each device row beside the kept names, derived from the folded name',
      fixtureMark: 'a device column the migration does not know',
    },
    plan: (ports) => planDeviceTagIds(ports),
  },
]
