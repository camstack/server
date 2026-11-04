import type { AddonMigration, FlattenRowPorts } from '@camstack/types'
import { FLATTEN_BROKER_RECORDS_ID, flattenBrokerRecords } from './flatten-broker-records.js'
import {
  type CalendarIdsPorts,
  copyCalendarIdsToIntegrations,
  planDropSharedCalendarIds,
} from './calendar-ids-to-integration.js'

export type { CalendarIdsPorts } from './calendar-ids-to-integration.js'
export { FLATTEN_BROKER_RECORDS_ID } from './flatten-broker-records.js'

/** What the catalogue's migrations read and write through. */
export type HaMigrationPorts = CalendarIdsPorts & FlattenRowPorts

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
]
