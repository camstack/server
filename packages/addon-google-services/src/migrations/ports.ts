import {
  type CalendarRecordBody,
  type CalendarRecordPorts,
  type RecordKindHandle,
  type StoredKeyRead,
} from '@camstack/types'
import type { GoogleBrokerStore } from '../google-broker-store.js'
import { GoogleBrokerEntrySchema } from '../google-types.js'
import type { CalendarIdsPorts } from './calendar-ids-to-brokers.js'
import type { LegacyBrokerPorts } from './legacy-brokers-to-records.js'
import { OAUTH_ACCOUNTS_KEY, type OauthAccountsPorts } from './oauth-accounts-to-records.js'

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

/** The ports of the `oauthAccounts` → account records move (planning#480). */
export function oauthAccountsPortsOver(deps: {
  readonly store: GoogleBrokerStore
  readonly readStored: (key: string) => Promise<StoredKeyRead>
  readonly warn: (message: string) => void
  readonly releaseStateSecrets: () => Promise<void>
}): OauthAccountsPorts {
  return {
    readStored: deps.readStored,
    warn: deps.warn,
    releaseStateSecrets: deps.releaseStateSecrets,
    readSession: (id) => deps.store.readSession(id),
    writeSession: (id, session) => deps.store.saveSession(id, session),
    createAccount: (id, name, session) =>
      deps.store.putOne(GoogleBrokerEntrySchema.parse({ id, name }), session),
  }
}

/**
 * The `oauthAccounts` entries the legacy-broker migration (seq 4) writes on an install older than
 * the records: that migration predates planning#480, so it still fills the state, and the move
 * (seq 6) carries it onto the records. Only migrations reach this key.
 */
export function legacyOauthAccountPortsOver(deps: {
  readonly readStored: (key: string) => Promise<StoredKeyRead>
  readonly writeStored: (patch: Record<string, unknown>) => Promise<void>
}): Pick<LegacyBrokerPorts, 'listOauthAccountIds' | 'putOauthAccount' | 'readOauthAccount'> {
  const accounts = async (): Promise<readonly unknown[]> => {
    const answer = await deps.readStored(OAUTH_ACCOUNTS_KEY)
    if (answer.kind === 'unreadable') {
      throw new Error(
        `google-services: the stored '${OAUTH_ACCOUNTS_KEY}' cannot be read (${answer.reason})`,
      )
    }
    if (answer.kind === 'absent') return []
    const list: unknown =
      typeof answer.value === 'object' && answer.value !== null
        ? Reflect.get(answer.value, 'accounts')
        : undefined
    return Array.isArray(list) ? list : []
  }
  const idOf = (entry: unknown): string | null => {
    const id: unknown =
      typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'id') : undefined
    return typeof id === 'string' ? id : null
  }
  return {
    listOauthAccountIds: async () =>
      (await accounts()).map(idOf).filter((id): id is string => id !== null),
    putOauthAccount: async (account) => {
      await deps.writeStored({
        [OAUTH_ACCOUNTS_KEY]: { accounts: [...(await accounts()), account] },
      })
    },
    readOauthAccount: async (id) => {
      const found = (await accounts()).find((entry) => idOf(entry) === id)
      if (found === undefined) return null
      const token: unknown =
        typeof found === 'object' && found !== null ? Reflect.get(found, 'refreshToken') : undefined
      return { refreshToken: typeof token === 'string' ? token : '' }
    },
  }
}
