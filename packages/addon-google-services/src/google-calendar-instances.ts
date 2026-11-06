/**
 * The calendars a Google account imports as `integration-instances` (D1013): one `calendars`
 * record per (account, calendar), linking to its account through the link primitive. The calendar
 * source reads the records; nothing is stored on the account.
 */
import {
  buildLinkedInstances,
  type ConfigUISchema,
  type RecordIntegrationInstances,
  type RecordsAccess,
  type ResolvedInstance,
} from '@camstack/types'
import { randomBytes } from 'node:crypto'
import { type GoogleCalendarBody, googleCalendarsEntryKind } from './broker-record-kinds.js'
import { stampCalendarId } from './google-broker-registry.js'

export const GOOGLE_CALENDAR_INSTANCE_KIND = 'calendar'

/** One calendar an account can import, as the account lists it. */
export interface GoogleCalendarOption {
  readonly value: string
  readonly label: string
}

export interface GoogleCalendarInstancesDeps {
  /** The calendars one signed-in account lists; empty while it is not signed in. */
  readonly catalog: (accountId: string) => Promise<readonly GoogleCalendarOption[]>
  /** Re-read the selection after any change. */
  readonly onChanged: () => Promise<void>
}

/** The stamped ids each account imports, from the calendar records. */
export function selectedStampedIds(
  rows: readonly ResolvedInstance<GoogleCalendarBody>[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>()
  for (const row of rows) {
    const { accountId, calendarId } = row.body
    if (!row.enabled || accountId === '' || calendarId === '') continue
    const set = out.get(accountId) ?? new Set<string>()
    set.add(stampCalendarId(accountId, calendarId))
    out.set(accountId, set)
  }
  return out
}

export function buildGoogleCalendarInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: GoogleCalendarInstancesDeps,
): RecordIntegrationInstances<GoogleCalendarBody> {
  return buildLinkedInstances(records, {
    kind: googleCalendarsEntryKind,
    instanceKind: GOOGLE_CALENDAR_INSTANCE_KIND,
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: GOOGLE_CALENDAR_INSTANCE_KIND,
      canTest: false,
    },
    labels: {
      accountId: {
        label: 'Google account',
        description: 'The account this calendar belongs to.',
      },
    },
    alsoConfigured: (body) => body.calendarId !== '',
    dynamicSections: async (accountId): Promise<ConfigUISchema['sections']> => [
      {
        id: 'google-calendar-pick',
        title: 'Calendar',
        columns: 1,
        fields: [
          {
            type: 'select',
            key: 'calendarId',
            label: 'Calendar',
            options: [...(await deps.catalog(accountId))],
            description: 'The calendars of that account. Sign the account in to see them.',
          },
        ],
      },
    ],
    mintId: () => `cal_${randomBytes(6).toString('hex')}`,
    onChanged: deps.onChanged,
  })
}
