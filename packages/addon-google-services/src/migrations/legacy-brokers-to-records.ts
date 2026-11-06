/**
 * The accounts a pre-record install kept in the addon settings become `brokers` records and
 * `oauthAccounts` entries (planning#440 step 5). Three legacy shapes feed it, the ones the boot
 * migration used to read:
 *
 * - the `brokers` setting (a list of entries);
 * - the flat singleton (`clientId`, `clientSecret`, `calendarFilter`, `fromAddress`, `fromName`),
 *   which becomes `google_001`;
 * - the singleton `oauth` state, whose token follows its account (`google_001`, or the first
 *   broker when brokers already existed).
 *
 * Reads come RESOLVED (the settings view answers values, not keychain markers); a value the
 * keychain could not serve is not a string and REFUSES the step, so nothing is written from a
 * guess. Each record is read back with its secret before the step reports done, and an account
 * that already has a record is never overwritten. The shared `calendarIds` set goes onto every
 * broker this step creates (the calendar migrations before it found no broker to give it to),
 * then becomes calendar records, so the selection is not lost whichever order the steps ran in. The legacy keys stay where they are: the drop
 * migration deletes them only after this one landed.
 */
import {
  GoogleBrokerEntrySchema,
  type GoogleBrokerEntry,
  type GoogleOauthAccount,
} from '../google-types.js'
import {
  type CalendarRecordPorts,
  type MigrationProcedureResult,
  moveCalendarIdsToRecords,
  type StoredKeyRead,
} from '@camstack/types'
import { parseStampedCalendarId } from '../google-broker-registry.js'
import type { CalendarIdsPorts } from './calendar-ids-to-brokers.js'

export const LEGACY_BROKER_ID = 'google_001'
const LEGACY_FLAT_KEYS = ['clientId', 'clientSecret', 'calendarFilter', 'fromAddress', 'fromName']

export interface LegacyBrokerPorts {
  /** Write a broker record (its secret goes to the keychain through the records door). */
  putBroker(entry: GoogleBrokerEntry): Promise<void>
  /** The record as stored, secret resolved; `null` when there is none. */
  readBroker(id: string): Promise<Pick<GoogleBrokerEntry, 'clientId' | 'clientSecret'> | null>
  /** Ids that already have an `oauthAccounts` entry. */
  listOauthAccountIds(): Promise<readonly string[]>
  putOauthAccount(account: GoogleOauthAccount): Promise<void>
  readOauthAccount(id: string): Promise<Pick<GoogleOauthAccount, 'refreshToken'> | null>
}

export type LegacyBrokersPorts = CalendarIdsPorts & CalendarRecordPorts & LegacyBrokerPorts

function present(answer: StoredKeyRead, key: string): unknown {
  if (answer.kind === 'unreadable') {
    throw new Error(`google-services: the stored '${key}' cannot be read (${answer.reason})`)
  }
  return answer.kind === 'absent' ? undefined : answer.value
}

function text(value: unknown, what: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  throw new Error(`google-services: ${what} is not a plain value (is the keychain available?)`)
}

interface LegacyOauth {
  readonly refreshToken: string
  readonly accessToken: string
  readonly accessExpiresAt: number
  readonly accountEmail: string
}

function legacyOauthOf(value: unknown): LegacyOauth | null {
  if (typeof value !== 'object' || value === null) return null
  const refreshToken = text(Reflect.get(value, 'refreshToken'), 'the legacy oauth refreshToken')
  if (refreshToken.length === 0) return null
  const expires: unknown = Reflect.get(value, 'accessExpiresAt')
  return {
    refreshToken,
    accessToken: text(Reflect.get(value, 'accessToken'), 'the legacy oauth accessToken'),
    accessExpiresAt: typeof expires === 'number' ? expires : 0,
    accountEmail: text(Reflect.get(value, 'accountEmail'), 'the legacy oauth accountEmail').trim(),
  }
}

async function flatFields(ports: CalendarIdsPorts): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const key of LEGACY_FLAT_KEYS) {
    out[key] = text(present(await ports.readStored(key), key), `the stored '${key}'`)
  }
  return out
}

async function legacyEntries(
  ports: CalendarIdsPorts,
  oauth: LegacyOauth | null,
): Promise<readonly GoogleBrokerEntry[]> {
  const listed = present(await ports.readStored('brokers'), 'brokers')
  if (Array.isArray(listed) && listed.length > 0) {
    return listed.map((item) => {
      const parsed = GoogleBrokerEntrySchema.safeParse(item)
      if (!parsed.success) {
        throw new Error(`google-services: a stored broker is invalid — ${parsed.error.message}`)
      }
      return parsed.data
    })
  }
  const flat = await flatFields(ports)
  if (!flat['clientId'] && !flat['clientSecret'] && oauth === null) return []
  const email = oauth?.accountEmail ?? ''
  return [
    GoogleBrokerEntrySchema.parse({
      id: LEGACY_BROKER_ID,
      name: email.length > 0 ? email : 'Google account',
      ...flat,
    }),
  ]
}

async function sharedCalendarIds(ports: CalendarIdsPorts): Promise<readonly string[] | null> {
  const value = present(await ports.readStored('calendarIds'), 'calendarIds')
  if (value === undefined) return null
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error('google-services: the shared calendarIds is not a list of ids — nothing copied')
  }
  return value
}

/** The keys a legacy install left that no record holds yet, for the init warning. */
export async function leftoverLegacyKeys(ports: CalendarIdsPorts): Promise<readonly string[]> {
  const left: string[] = []
  const listed = await ports.readStored('brokers')
  if (listed.kind === 'present' && Array.isArray(listed.value) && listed.value.length > 0) {
    left.push('brokers')
  }
  for (const key of ['clientId', 'clientSecret']) {
    const answer = await ports.readStored(key)
    if (answer.kind === 'present' && answer.value !== '' && answer.value !== null) left.push(key)
  }
  const oauth = await ports.readStored('oauth')
  if (oauth.kind === 'present') {
    const token =
      typeof oauth.value === 'object' && oauth.value !== null
        ? Reflect.get(oauth.value, 'refreshToken')
        : undefined
    if (token !== undefined && token !== '' && token !== null) left.push('oauth')
  }
  return left
}

export async function copyLegacyBrokersToRecords(
  ports: LegacyBrokersPorts,
): Promise<MigrationProcedureResult> {
  const oauth = legacyOauthOf(present(await ports.readStored('oauth'), 'oauth'))
  const entries = await legacyEntries(ports, oauth)
  if (entries.length === 0)
    return { outcome: 'already-done', summary: { reason: 'no-legacy-data' } }

  const have = new Set((await ports.listBrokers()).map((b) => b.id))
  const shared = await sharedCalendarIds(ports)
  let created = 0
  let selections = 0
  for (const entry of entries) {
    if (have.has(entry.id)) continue
    await ports.putBroker(entry)
    const back = await ports.readBroker(entry.id)
    if (
      back === null ||
      back.clientId !== entry.clientId ||
      back.clientSecret !== entry.clientSecret
    ) {
      throw new Error(`google-services: broker '${entry.id}' did not read back as written`)
    }
    created += 1
    if (shared !== null && (await ports.setBrokerCalendarIds(entry.id, shared))) selections += 1
  }
  if (selections > 0) {
    await moveCalendarIdsToRecords(ports, {
      calendarIdOf: (accountId, stamped) => {
        const parsed = parseStampedCalendarId(stamped)
        return parsed?.brokerId === accountId ? parsed.googleCalendarId : null
      },
    })
  }

  let account = 0
  const primary = entries[0]
  if (oauth !== null && primary !== undefined) {
    const accounts = await ports.listOauthAccountIds()
    if (accounts.length === 0) {
      await ports.putOauthAccount({
        id: primary.id,
        refreshToken: oauth.refreshToken,
        accessToken: oauth.accessToken,
        accessExpiresAt: oauth.accessExpiresAt,
        accountEmail: oauth.accountEmail,
        needsReauth: false,
      })
      const back = await ports.readOauthAccount(primary.id)
      if (back === null || back.refreshToken !== oauth.refreshToken) {
        throw new Error(`google-services: the oauth account of '${primary.id}' did not read back`)
      }
      account = 1
    }
  }
  return {
    outcome: created + account === 0 ? 'already-done' : 'done',
    summary: { brokers: created, oauthAccounts: account },
  }
}
