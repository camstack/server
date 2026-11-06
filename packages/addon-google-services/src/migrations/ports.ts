import {
  type CalendarRecordBody,
  type CalendarRecordPorts,
  type RecordKindHandle,
  type StoredKeyRead,
} from '@camstack/types'
import type { CalendarIdsPorts } from './calendar-ids-to-brokers.js'

/** A broker record read as stored: the migrations see fields the current schema no longer names. */
export type RawBrokerBody = Record<string, unknown>

function listOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

/** The migration's ports over the `brokers` record kind and the addon's raw settings read. */
export function calendarIdsPortsOver(
  kind: RecordKindHandle<RawBrokerBody>,
  readStored: (key: string) => Promise<StoredKeyRead>,
): CalendarIdsPorts {
  return {
    readStored,
    listBrokers: async () => {
      const page = await kind.query({ limit: 1000 })
      return page.records.map((record) => ({
        id: record.id,
        calendarIds: listOf(record.data['calendarIds']),
      }))
    },
    setBrokerCalendarIds: async (id, ids) => {
      const row = await kind.get(id)
      if (row === null) return false
      // A set the record already holds is never overwritten, even one written since the list.
      if (row.data['calendarIds'] !== undefined) return true
      await kind.patch(id, { calendarIds: [...ids] })
      return true
    },
  }
}

/** The ports of the calendars move: the raw `brokers` rows and the `calendars` records. */
export function calendarRecordPortsOver(deps: {
  readonly brokers: RecordKindHandle<RawBrokerBody>
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
