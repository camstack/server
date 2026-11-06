/**
 * The addon-level `brokers` setting and the singleton `oauth` state are gone (planning#440 step 5):
 * every account is a `brokers` record and its tokens live in `oauthAccounts`. This deletes the two
 * leftover keys, each only when nothing in them is still the only copy:
 *
 * - `brokers` goes when the `brokers` kind holds records, or when the setting itself is empty. A
 *   non-empty setting with an empty kind was never copied: it stays.
 * - `oauth` goes when it carries no token (the empty state the old boot migration left behind), or
 *   when `oauthAccounts` already holds accounts. A token with no account to hold it stays.
 *
 * Each edit carries a precondition read, so a row that changed since the plan was made is not
 * deleted; a second run finds nothing to plan.
 */
import { type MigrationPlan, type StoredKeyRead, preconditionOf } from '@camstack/types'
import {
  ADDON_SETTINGS_TABLE,
  type CalendarIdsPorts,
  GOOGLE_ADDON_ID,
  SHARED_CALENDAR_IDS_KEY,
} from './calendar-ids-to-brokers.js'

export const BROKERS_KEY = 'brokers'
export const LEGACY_OAUTH_KEY = 'oauth'
/** The flat singleton client the boot migration used to clear. */
const FLAT_KEYS = ['clientId', 'clientSecret', 'calendarFilter', 'fromAddress', 'fromName']
const OAUTH_ACCOUNTS_KEY = 'oauthAccounts'

function present(answer: StoredKeyRead, key: string): { readonly value: unknown } | null {
  if (answer.kind === 'unreadable') {
    throw new Error(`google-services: the stored '${key}' cannot be read (${answer.reason})`)
  }
  return answer.kind === 'absent' ? null : { value: answer.value }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/** A token field that holds nothing: absent or the empty string. A secret marker is something. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function holdsAccounts(value: unknown): boolean {
  const accounts = field(value, 'accounts')
  return Array.isArray(accounts) && accounts.length > 0
}

export async function planDropConfigBrokersAndLegacyOauth(
  ports: CalendarIdsPorts,
): Promise<MigrationPlan> {
  const rows: Record<string, { addonId: string; key: string; value: unknown }> = {}
  const keys: string[] = []
  const take = (key: string, value: unknown): void => {
    const id = `${GOOGLE_ADDON_ID}.${key}`
    keys.push(id)
    rows[id] = { addonId: GOOGLE_ADDON_ID, key, value }
  }

  const brokers = present(await ports.readStored(BROKERS_KEY), BROKERS_KEY)
  if (brokers !== null) {
    const listed = Array.isArray(brokers.value) && brokers.value.length > 0
    if (!listed || (await ports.listBrokers()).length > 0) take(BROKERS_KEY, brokers.value)
  }

  for (const key of FLAT_KEYS) {
    const flat = present(await ports.readStored(key), key)
    if (flat !== null && (await ports.listBrokers()).length > 0) take(key, flat.value)
  }

  // The shared calendar set the calendar migrations could not place (no broker existed then) goes
  // once every broker shows it as its own or has already turned it into calendar records. A broker
  // holding a DIFFERENT set parks it, as the calendar migration decides.
  const shared = present(await ports.readStored(SHARED_CALENDAR_IDS_KEY), SHARED_CALENDAR_IDS_KEY)
  if (shared !== null) {
    const sharedIds = stringList(shared.value)
    if (sharedIds === null) {
      // The plan has no log channel: a failing plan is how a migration reports, and the ledger keeps it.
      throw new Error(
        `google-services: the stored '${SHARED_CALENDAR_IDS_KEY}' is not a list of ids — nothing dropped`,
      )
    } else {
      const brokers = await ports.listBrokers()
      const same = (ids: readonly string[] | undefined): boolean =>
        ids === undefined ||
        (ids.length === sharedIds.length && ids.every((id) => sharedIds.includes(id)))
      if (brokers.length > 0 && brokers.every((b) => same(b.calendarIds))) {
        take(SHARED_CALENDAR_IDS_KEY, shared.value)
      }
    }
  }

  const oauth = present(await ports.readStored(LEGACY_OAUTH_KEY), LEGACY_OAUTH_KEY)
  if (oauth !== null) {
    const tokenless =
      isBlank(field(oauth.value, 'refreshToken')) && isBlank(field(oauth.value, 'accessToken'))
    const accounts = present(await ports.readStored(OAUTH_ACCOUNTS_KEY), OAUTH_ACCOUNTS_KEY)
    if (tokenless || (accounts !== null && holdsAccounts(accounts.value))) {
      take(LEGACY_OAUTH_KEY, oauth.value)
    }
  }

  if (keys.length === 0) return { edits: [] }
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys,
        precondition: preconditionOf(rows),
      },
    ],
  }
}
