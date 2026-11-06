import {
  type AddonMigration,
  type CalendarRecordPorts,
  moveCalendarIdsToRecords,
} from '@camstack/types'
import { parseStampedCalendarId } from '../google-broker-registry.js'
import {
  type CalendarIdsPorts,
  copyCalendarIdsToBrokers,
  planDropSharedCalendarIds,
} from './calendar-ids-to-brokers.js'

export type { CalendarIdsPorts } from './calendar-ids-to-brokers.js'

export const CALENDAR_IDS_TO_RECORDS_ID =
  'google-services/2026-11-07-calendar-ids-to-calendar-records'

/** What the catalogue's migrations read and write through. */
export type GoogleMigrationPorts = CalendarIdsPorts & CalendarRecordPorts

/** The `google-services` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<GoogleMigrationPorts>[] = [
  {
    meta: {
      id: 'google-services/2026-11-03-calendar-ids-to-brokers',
      owner: 'google-services',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Copy the shared calendar set to every Google broker record that has none of its own',
      fixtureMark: 'the client secret marker of a broker record the migration does not know',
    },
    procedure: copyCalendarIdsToBrokers,
  },
  {
    meta: {
      id: 'google-services/2026-11-03-drop-shared-calendar-ids',
      owner: 'google-services',
      level: 'addon-state',
      seq: 2,
      dependsOn: ['google-services/2026-11-03-calendar-ids-to-brokers'],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the shared calendar set once every broker shows its own',
      fixtureMark: 'the shared set parked when a broker holds a different one',
    },
    plan: planDropSharedCalendarIds,
  },
  {
    meta: {
      id: CALENDAR_IDS_TO_RECORDS_ID,
      owner: 'google-services',
      level: 'addon-state',
      seq: 3,
      dependsOn: ['google-services/2026-11-03-drop-shared-calendar-ids'],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Write one calendar record per calendar an account imports (linked to the account), read each back, then clear the calendar array of the account row',
      fixtureMark: 'the client secret marker of the account that keeps its calendars',
    },
    procedure: (ports) =>
      moveCalendarIdsToRecords(ports, {
        // An entry stamped for ANOTHER account never selected anything for this one.
        calendarIdOf: (accountId, entry) => {
          const parsed = parseStampedCalendarId(entry)
          return parsed?.brokerId === accountId ? parsed.googleCalendarId : null
        },
      }),
  },
]
