import type { CalendarRecordPorts } from '@camstack/types'
import type { LegacyBrokerPorts } from '../legacy-brokers-to-records.js'

/** Calendar-record ports over nothing: no accounts, nothing to read, writes dropped. */
export const NO_RECORD_PORTS: CalendarRecordPorts = {
  warn: () => undefined,
  listAccounts: async () => [],
  readCalendar: async () => null,
  putCalendar: async () => undefined,
  clearCalendarIds: async () => undefined,
}

/** Legacy-broker ports over nothing: no record, no oauth account, writes dropped. */
export const NO_LEGACY_PORTS: LegacyBrokerPorts = {
  putBroker: async () => undefined,
  readBroker: async () => null,
  listOauthAccountIds: async () => [],
  putOauthAccount: async () => undefined,
  readOauthAccount: async () => null,
}
