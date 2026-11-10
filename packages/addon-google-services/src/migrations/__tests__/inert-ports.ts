import type { CalendarRecordPorts } from '@camstack/types'
import type { LegacyBrokerPorts } from '../legacy-brokers-to-records.js'
import type { OauthAccountsPorts } from '../oauth-accounts-to-records.js'

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

/** OAuth-accounts move ports over nothing: no record, writes dropped (the state is never read here). */
export const NO_OAUTH_ACCOUNTS_PORTS: Omit<OauthAccountsPorts, 'readStored' | 'warn'> = {
  readSession: async () => null,
  writeSession: async () => undefined,
  createAccount: async () => undefined,
  releaseStateSecrets: async () => undefined,
}
