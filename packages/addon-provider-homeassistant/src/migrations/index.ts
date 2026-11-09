import {
  type AddonMigration,
  type BrokerLinkPorts,
  type CalendarRecordPorts,
  type FlattenRowPorts,
  moveBrokerLinksToConnections,
  moveCalendarIdsToRecords,
} from '@camstack/types'
import { BROKER_LINKS_TO_CONNECTIONS_ID, haBrokerLinkPorts } from './broker-links-to-connections.js'
import { FLATTEN_BROKER_RECORDS_ID, flattenBrokerRecords } from './flatten-broker-records.js'
import {
  CLEAR_INSTANCE_SETTINGS_ROWS_ID,
  INSTANCE_SETTINGS_TO_RECORD_ID,
  type InstanceSettingsPorts,
  clearInstanceSettingsRows,
  moveInstanceSettingsToRecords,
} from './instance-settings-to-record.js'
import {
  type CalendarIdsPorts,
  copyCalendarIdsToIntegrations,
  planDropSharedCalendarIds,
} from './calendar-ids-to-integration.js'

import {
  HA_NOTIFY_TARGETS_TO_BODY_ID,
  type HaNotifyPorts,
  moveHaNotifyTargets,
} from './notify-targets-to-body.js'

export const CALENDAR_IDS_TO_RECORDS_ID =
  'provider-homeassistant/2026-11-07-calendar-ids-to-calendar-records'

export { BROKER_LINKS_TO_CONNECTIONS_ID, haBrokerLinkPorts }
export {
  HA_NOTIFY_TARGETS_TO_BODY_ID,
  haLegacyTargetsOver,
  haNotifyPortsOver,
} from './notify-targets-to-body.js'
export { haInstanceRecordPortsOver } from './ha-instance-settings.js'
export type { HaNotifyPorts } from './notify-targets-to-body.js'
export type { CalendarIdsPorts } from './calendar-ids-to-integration.js'
export { FLATTEN_BROKER_RECORDS_ID } from './flatten-broker-records.js'
export {
  CLEAR_INSTANCE_SETTINGS_ROWS_ID,
  INSTANCE_SETTINGS_TO_RECORD_ID,
} from './instance-settings-to-record.js'

/** What the catalogue's migrations read and write through. */
export type HaMigrationPorts = CalendarIdsPorts &
  FlattenRowPorts &
  InstanceSettingsPorts &
  BrokerLinkPorts &
  CalendarRecordPorts &
  HaNotifyPorts

/** The `provider-homeassistant` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<HaMigrationPorts>[] = [
  {
    meta: {
      id: 'provider-homeassistant/2026-11-03-calendar-ids-to-integration',
      owner: 'provider-homeassistant',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Copy the shared calendar set to the settings of every Home Assistant integration that has none',
      fixtureMark: 'the broker link stored beside the calendars of an integration',
    },
    procedure: copyCalendarIdsToIntegrations,
  },
  {
    meta: {
      id: 'provider-homeassistant/2026-11-03-drop-shared-calendar-ids',
      owner: 'provider-homeassistant',
      level: 'addon-state',
      seq: 2,
      dependsOn: ['provider-homeassistant/2026-11-03-calendar-ids-to-integration'],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the shared calendar set once every integration shows its own',
      fixtureMark: 'the shared set parked when an integration holds a different one',
    },
    plan: planDropSharedCalendarIds,
  },
  {
    meta: {
      id: FLATTEN_BROKER_RECORDS_ID,
      owner: 'provider-homeassistant',
      level: 'addon-state',
      seq: 3,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Flatten the nested auth of every Home Assistant broker record under its own id, moving each token to a top-level keychain secret',
      fixtureMark: 'a non-secret field stored beside the auth of a broker record',
    },
    procedure: flattenBrokerRecords,
  },
  {
    meta: {
      id: INSTANCE_SETTINGS_TO_RECORD_ID,
      owner: 'provider-homeassistant',
      level: 'addon-state',
      seq: 4,
      dependsOn: [
        'provider-homeassistant/2026-11-03-drop-shared-calendar-ids',
        FLATTEN_BROKER_RECORDS_ID,
      ],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Merge the calendars and the integration link of every Home Assistant integration into the instance record its broker link names; a field the record holds wins; read back',
      fixtureMark: 'a calendar id stored in the integration settings of an instance',
    },
    procedure: moveInstanceSettingsToRecords,
  },
  {
    meta: {
      id: CLEAR_INSTANCE_SETTINGS_ROWS_ID,
      owner: 'provider-homeassistant',
      level: 'addon-state',
      seq: 5,
      dependsOn: [INSTANCE_SETTINGS_TO_RECORD_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Clear the calendars from the integration settings of every Home Assistant instance whose record reads back the same set',
      fixtureMark: 'a calendar set the instance record holds differently',
    },
    procedure: clearInstanceSettingsRows,
  },
  {
    meta: {
      id: BROKER_LINKS_TO_CONNECTIONS_ID,
      owner: 'provider-homeassistant',
      level: 'addon-state',
      seq: 6,
      dependsOn: [INSTANCE_SETTINGS_TO_RECORD_ID, CLEAR_INSTANCE_SETTINGS_ROWS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Write each integration a connections record naming its Home Assistant connection (keyed by the integration id), then clear the integration link on the connection (a link that does not read back stays on the broker, the failure is logged, the addon runs); stray registry-keyed connection rows are counted and logged, never deleted',
      fixtureMark: 'the calendars and the name of the connection that keeps its record',
    },
    procedure: moveBrokerLinksToConnections,
  },
  {
    meta: {
      id: CALENDAR_IDS_TO_RECORDS_ID,
      owner: 'provider-homeassistant',
      level: 'addon-state',
      seq: 7,
      dependsOn: [
        BROKER_LINKS_TO_CONNECTIONS_ID,
        INSTANCE_SETTINGS_TO_RECORD_ID,
        CLEAR_INSTANCE_SETTINGS_ROWS_ID,
      ],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Write one calendar record per calendar a Home Assistant connection imports (linked to the connection), read each back, then clear the calendar array of the connection row',
      fixtureMark: 'the name of the connection that keeps its calendars',
    },
    procedure: (ports) =>
      moveCalendarIdsToRecords(ports, { calendarIdOf: (_accountId, entry) => entry }),
  },
  {
    meta: {
      id: HA_NOTIFY_TARGETS_TO_BODY_ID,
      owner: 'provider-homeassistant',
      level: 'addon-state',
      seq: 8,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Move each Home Assistant notify target to the notify-homeassistant record, the config flat in the body, the same id and the same switch; read back before the old row goes; a row that fails stays in the old kind and is still served',
      fixtureMark: 'the switch (off) and the id of a Home Assistant notify target',
    },
    procedure: moveHaNotifyTargets,
  },
]
