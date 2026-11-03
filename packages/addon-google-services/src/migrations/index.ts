import type { AddonMigration } from '@camstack/types'
import {
  type CalendarIdsPorts,
  copyCalendarIdsToBrokers,
  planDropSharedCalendarIds,
} from './calendar-ids-to-brokers.js'

export type { CalendarIdsPorts } from './calendar-ids-to-brokers.js'

/** The `google-services` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<CalendarIdsPorts>[] = [
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
]
