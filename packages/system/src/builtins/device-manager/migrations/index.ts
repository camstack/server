import type { AddonMigration } from '@dominevo/types'
import { DEVICE_TAG_IDS_ID, type DeviceTagIdsPorts, planDeviceTagIds } from './device-tag-ids.js'
import { type OrphanChildrenPorts, removeOrphanChildren } from './orphan-children.js'
import {
  DEVICE_MANAGER_ID,
  planRoomsAsRecords,
  ROOMS_AS_RECORDS_ID,
  type RoomsMigrationPorts,
} from './rooms-as-records.js'

export { DEVICE_TAG_IDS_ID } from './device-tag-ids.js'
export { ROOMS_AS_RECORDS_ID } from './rooms-as-records.js'

export const REMOVE_ORPHAN_CHILDREN_ID = 'device-manager/2026-11-23-remove-orphan-children'

/** The ports of the migrations that run before the first read (rooms, zones, tag ids). */
export type DeviceManagerStatePorts = RoomsMigrationPorts & DeviceTagIdsPorts

export type DeviceManagerMigrationPorts = DeviceManagerStatePorts & OrphanChildrenPorts

/** Rooms, zones and tag ids: run BEFORE the first read resolves a name (D1089). */
export const ROOMS_AND_TAGS_MIGRATIONS: readonly AddonMigration<DeviceManagerStatePorts>[] = [
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

/** Accessory rows left behind by a removal that did not cascade: run once the fleet is up (D987). */
export const ORPHAN_CHILDREN_MIGRATIONS: readonly AddonMigration<OrphanChildrenPorts>[] = [
  {
    meta: {
      id: REMOVE_ORPHAN_CHILDREN_ID,
      owner: DEVICE_MANAGER_ID,
      level: 'addon-state',
      seq: 3,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Remove every device row whose parentDeviceId names no row, through the tombstoned removal, each one logged',
      fixtureMark: 'a child of a live parent and a top-level row, both kept',
    },
    procedure: removeOrphanChildren,
  },
]

/** The whole `device-manager` catalogue (D987), in seq order. */
export const ADDON_MIGRATIONS: readonly AddonMigration<DeviceManagerMigrationPorts>[] = [
  ...ROOMS_AND_TAGS_MIGRATIONS,
  ...ORPHAN_CHILDREN_MIGRATIONS,
]
