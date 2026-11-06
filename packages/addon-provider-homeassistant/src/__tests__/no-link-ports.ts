import type { BrokerLinkPorts, CalendarRecordPorts } from '@camstack/types'

/** Link ports over nothing: for a spec that runs the catalogue without exercising the link migration. */
export const NO_LINK_PORTS: BrokerLinkPorts = {
  listBrokers: async () => [],
  readConnection: async () => null,
  putConnection: async () => undefined,
  clearBrokerLink: async () => undefined,
  warn: () => undefined,
}

/** Calendar ports over nothing: for a spec that does not exercise the calendars move. */
export const NO_CALENDAR_PORTS: CalendarRecordPorts = {
  listAccounts: async () => [],
  readCalendar: async () => null,
  putCalendar: async () => undefined,
  clearCalendarIds: async () => undefined,
  warn: () => undefined,
}
