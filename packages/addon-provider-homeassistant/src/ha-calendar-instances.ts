/**
 * The calendars a Home Assistant connection imports as `integration-instances` (D1013): one
 * `calendars` record per (connection, calendar), linking to its connection through the link
 * primitive. The calendar source reads the records; nothing is stored on the connection.
 */
import {
  buildLinkedInstances,
  type ConfigUISchema,
  type RecordIntegrationInstances,
  type RecordsAccess,
  type ResolvedInstance,
} from '@camstack/types'
import { randomBytes } from 'node:crypto'
import { type HaCalendarBody, haCalendarsEntryKind } from './broker-record-kinds.js'

export const HA_CALENDAR_INSTANCE_KIND = 'calendar'

/** One calendar a connection can import, as the connection lists it. */
export interface HaCalendarOption {
  readonly value: string
  readonly label: string
}

export interface HaCalendarInstancesDeps {
  /** The `calendar.*` entities one connection offers; empty while it is not connected. */
  readonly catalog: (accountId: string) => readonly HaCalendarOption[]
  /** Re-read the selection after any change. */
  readonly onChanged: () => Promise<void>
}

/** The entity ids each connection imports, from the calendar records. */
export function selectedEntityIds(
  rows: readonly ResolvedInstance<HaCalendarBody>[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>()
  for (const row of rows) {
    const { accountId, calendarId } = row.body
    if (!row.enabled || accountId === '' || calendarId === '') continue
    const set = out.get(accountId) ?? new Set<string>()
    set.add(calendarId)
    out.set(accountId, set)
  }
  return out
}

export function buildHaCalendarInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: HaCalendarInstancesDeps,
): RecordIntegrationInstances<HaCalendarBody> {
  return buildLinkedInstances(records, {
    kind: haCalendarsEntryKind,
    instanceKind: HA_CALENDAR_INSTANCE_KIND,
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: HA_CALENDAR_INSTANCE_KIND,
      canTest: false,
      kinds: [
        {
          id: HA_CALENDAR_INSTANCE_KIND,
          label: 'Home Assistant calendar',
          functionCap: 'calendar-source',
          role: 'services',
        },
      ],
    },
    labels: {
      accountId: {
        label: 'Home Assistant connection',
        description: 'The connection this calendar is read from.',
      },
    },
    alsoConfigured: (body) => body.calendarId !== '',
    dynamicSections: async (accountId): Promise<ConfigUISchema['sections']> => [
      {
        id: 'ha-calendar-pick',
        title: 'Calendar',
        columns: 1,
        fields: [
          {
            type: 'select',
            key: 'calendarId',
            label: 'Calendar',
            options: [...deps.catalog(accountId)],
            description: 'The calendars of that connection. It must be connected to list them.',
          },
        ],
      },
    ],
    mintId: () => `cal_${randomBytes(6).toString('hex')}`,
    onChanged: deps.onChanged,
  })
}
