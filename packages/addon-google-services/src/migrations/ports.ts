import type { RecordKindHandle, StoredKeyRead } from '@camstack/types'
import type { GoogleBrokerBody } from '../broker-record-kinds.js'
import type { CalendarIdsPorts } from './calendar-ids-to-brokers.js'

/** The migration's ports over the `brokers` record kind and the addon's raw settings read. */
export function calendarIdsPortsOver(
  kind: RecordKindHandle<GoogleBrokerBody>,
  readStored: (key: string) => Promise<StoredKeyRead>,
): CalendarIdsPorts {
  return {
    readStored,
    listBrokers: async () => {
      const page = await kind.query({ limit: 1000 })
      return page.records.map((record) => ({
        id: record.id,
        calendarIds: record.data.calendarIds,
      }))
    },
    setBrokerCalendarIds: async (id, ids) => {
      const row = await kind.get(id)
      if (row === null) return false
      // A set the record already holds is never overwritten, even one written since the list.
      if (row.data.calendarIds !== undefined) return true
      await kind.patch(id, { calendarIds: [...ids] })
      return true
    },
  }
}
