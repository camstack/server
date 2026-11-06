import {
  type CalendarRecordBody,
  type CalendarRecordPorts,
  type RecordKindHandle,
} from '@camstack/types'
import type { RawHaBrokerBody } from '../ha-instance-settings.js'

/** The ports of the calendars move: the raw `brokers` rows and the `calendars` records. */
export function haCalendarRecordPortsOver(deps: {
  readonly brokers: RecordKindHandle<RawHaBrokerBody>
  readonly calendars: RecordKindHandle<CalendarRecordBody>
  readonly warn: (message: string) => void
}): CalendarRecordPorts {
  return {
    warn: deps.warn,
    listAccounts: async () => {
      const page = await deps.brokers.query({ limit: 1000 })
      return page.records.map((record) => ({
        id: record.id,
        calendarIds: record.data['calendarIds'],
      }))
    },
    readCalendar: async (recordId) => {
      const row = await deps.calendars.get(recordId)
      return row === null ? null : row.data
    },
    putCalendar: async (recordId, body) => {
      await deps.calendars.put({ id: recordId, data: body }, { ifRev: 0 })
    },
    clearCalendarIds: async (accountId) => {
      await deps.brokers.patch(accountId, { calendarIds: null })
    },
  }
}
