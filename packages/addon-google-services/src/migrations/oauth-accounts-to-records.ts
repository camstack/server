/**
 * The OAuth accounts leave the `oauthAccounts` state for the account records (planning#480, the
 * last split of planning#440: one store per configured thing, D1013). Two migrations, in order:
 *
 *  6. `moveOauthAccountsToRecords` (procedure): each entry becomes or JOINS its `brokers` record.
 *     The refresh token is read RESOLVED from the state and written through the records door, so
 *     it lands in the keychain under the record's own ref and the row holds the marker: the same
 *     token, so the operator does not consent again. Each write is read back (token and email)
 *     before it counts. A record that already holds a token keeps it (the runtime wrote it later).
 *     An entry that fails (a token the keychain cannot serve, a write refused, a read-back that
 *     differs) blocks only itself: it is logged with its reason, the others land, and the step
 *     then FAILS so the drop is blocked and the next boot retries what is left (the landed ones
 *     are skipped as already joined). Idempotent: a second run finds every entry joined.
 *  7. `releaseOauthAccountsSecrets` (procedure): only after a SECOND read shows every entry's
 *     token on its record, the state is written with no accounts; the secret-aware write deletes
 *     the keychain refs it dropped. A side effect, so it is a procedure: it runs when the ledger
 *     applies it, never while a plan is being built.
 *  8. `planDropOauthAccountsState` (plan, pure): it reads the state and, once no account is left
 *     in it, deletes the key. A plan precondition is compared with the RAW row and an addon reads
 *     only resolved values, so a precondition can be taken only on a row that holds no keychain
 *     marker any more; that is why step 7 empties it first. (The `export-alexa` drop takes its
 *     precondition after the same kind of release.) Rollback is the D987 pre-migration snapshot
 *     of the hub database: the settings, the records and the `keychain:secrets` rows come back
 *     together.
 *
 * No message here carries a token: an entry is named by its id, a failure by its reason.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import type { GoogleSession } from '../google-types.js'
import type { StoredGoogleSession } from '../google-broker-store.js'
import {
  ADDON_SETTINGS_TABLE,
  type CalendarIdsPorts,
  GOOGLE_ADDON_ID,
} from './calendar-ids-to-brokers.js'

export const OAUTH_ACCOUNTS_KEY = 'oauthAccounts'

export interface OauthAccountsPorts extends Pick<CalendarIdsPorts, 'readStored'> {
  /** The record's session, resolved; null when there is no record. Throws when unreadable. */
  readSession(id: string): Promise<StoredGoogleSession | null>
  /** Patch the session onto an existing record. */
  writeSession(id: string, session: GoogleSession): Promise<void>
  /** Create the record of an entry that has none (refused when one appeared meanwhile). */
  createAccount(id: string, name: string, session: GoogleSession): Promise<void>
  warn(message: string): void
  /** Write the state with no accounts: its keychain values are released with the markers. */
  releaseStateSecrets(): Promise<void>
}

/** One state entry as the migration understands it; `problem` names why it cannot move. */
interface LegacyEntry {
  readonly id: string
  readonly session: GoogleSession | null
  readonly problem: string | null
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function textField(value: unknown, key: string): string | null {
  const v = field(value, key)
  if (v === undefined || v === null) return ''
  return typeof v === 'string' ? v : null
}

function entryOf(raw: unknown): LegacyEntry | null {
  const id = field(raw, 'id')
  if (typeof id !== 'string' || id.length === 0) return null
  const refreshToken = textField(raw, 'refreshToken')
  const accountEmail = textField(raw, 'accountEmail')
  if (refreshToken === null) {
    return {
      id,
      session: null,
      problem: 'the refresh token cannot be read from the keychain',
    }
  }
  if (accountEmail === null) return { id, session: null, problem: 'the email is not text' }
  return {
    id,
    session: {
      refreshToken,
      accountEmail: accountEmail.trim(),
      scopes: '',
      needsReauth: field(raw, 'needsReauth') === true,
    },
    problem: null,
  }
}

/** The entries of the stored state, or null when there is no state. Throws when unreadable. */
async function storedEntries(ports: Pick<OauthAccountsPorts, 'readStored'>): Promise<{
  readonly entries: readonly LegacyEntry[]
  readonly value: unknown
} | null> {
  const answer = await ports.readStored(OAUTH_ACCOUNTS_KEY)
  if (answer.kind === 'unreadable') {
    throw new Error(
      `google-services: the stored '${OAUTH_ACCOUNTS_KEY}' cannot be read (${answer.reason})`,
    )
  }
  if (answer.kind === 'absent') return null
  const accounts = field(answer.value, 'accounts')
  if (accounts === undefined || accounts === null) return { entries: [], value: answer.value }
  if (!Array.isArray(accounts)) {
    throw new Error(`google-services: the stored '${OAUTH_ACCOUNTS_KEY}' holds no list of accounts`)
  }
  const entries: LegacyEntry[] = []
  for (const raw of accounts) {
    const entry = entryOf(raw)
    if (entry !== null) entries.push(entry)
  }
  return { entries, value: answer.value }
}

/** Whether an entry carries anything a record must hold before the state may go. */
function carries(session: GoogleSession): boolean {
  return session.refreshToken.length > 0
}

/** The record holds the entry: its own token (or a newer one the runtime wrote), and the email. */
function joined(entry: GoogleSession, held: StoredGoogleSession | null): boolean {
  if (held === null) return false
  if (held.refreshToken.length === 0) return false
  if (held.refreshToken !== entry.refreshToken) return true
  return entry.accountEmail.length === 0 || held.accountEmail === entry.accountEmail
}

async function moveOne(
  ports: OauthAccountsPorts,
  id: string,
  session: GoogleSession,
): Promise<'moved' | 'kept'> {
  const held = await ports.readSession(id)
  if (joined(session, held)) return 'kept'
  if (held === null) {
    await ports.createAccount(
      id,
      session.accountEmail.length > 0 ? session.accountEmail : id,
      session,
    )
  } else {
    await ports.writeSession(id, {
      ...session,
      // An email the record learned since (a later Test) is not overwritten by an empty one.
      accountEmail: session.accountEmail.length > 0 ? session.accountEmail : held.accountEmail,
    })
  }
  const back = await ports.readSession(id)
  if (
    back === null ||
    back.refreshToken !== session.refreshToken ||
    (session.accountEmail.length > 0 && back.accountEmail !== session.accountEmail) ||
    back.needsReauth !== session.needsReauth
  ) {
    throw new Error('the record did not read back what was written')
  }
  return 'moved'
}

function reasonOf(err: unknown): string {
  // A records error never carries the secret value (records-access); still, name only its class
  // of failure for an error of unknown origin.
  return err instanceof Error ? err.message : 'unknown failure'
}

export async function moveOauthAccountsToRecords(
  ports: OauthAccountsPorts,
): Promise<MigrationProcedureResult> {
  const stored = await storedEntries(ports)
  if (stored === null)
    return {
      outcome: 'already-done',
      summary: { reason: 'no-oauth-accounts' },
    }
  let moved = 0
  let kept = 0
  const failed: string[] = []
  for (const entry of stored.entries) {
    if (entry.session === null) {
      ports.warn(
        `google-services: the OAuth account '${entry.id}' was NOT moved to its record: ${entry.problem ?? 'unreadable'}`,
      )
      failed.push(entry.id)
      continue
    }
    if (!carries(entry.session) && !entry.session.needsReauth) continue
    try {
      if ((await moveOne(ports, entry.id, entry.session)) === 'moved') moved += 1
      else kept += 1
    } catch (err: unknown) {
      ports.warn(
        `google-services: the OAuth account '${entry.id}' was NOT moved to its record: ${reasonOf(err)}`,
      )
      failed.push(entry.id)
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `google-services: ${failed.length} OAuth account(s) not moved (${failed.join(', ')}); the state is kept and the move retried at the next boot`,
    )
  }
  return {
    outcome: moved === 0 ? 'already-done' : 'done',
    summary: { moved, kept, entries: stored.entries.length },
  }
}

export async function releaseOauthAccountsSecrets(
  ports: OauthAccountsPorts,
): Promise<MigrationProcedureResult> {
  const stored = await storedEntries(ports)
  if (stored === null) return { outcome: 'already-done', summary: { reason: 'no-oauth-accounts' } }
  for (const entry of stored.entries) {
    if (entry.session === null) {
      throw new Error(
        `google-services: the OAuth account '${entry.id}' cannot be read — the state is kept`,
      )
    }
    if (!carries(entry.session)) continue
    // The SECOND read: positive proof the record holds the token before its only other copy goes.
    if (!joined(entry.session, await ports.readSession(entry.id))) {
      throw new Error(
        `google-services: the record of '${entry.id}' does not hold its token — the state is kept`,
      )
    }
  }
  if (stored.entries.length === 0) {
    return { outcome: 'already-done', summary: { reason: 'no-oauth-accounts' } }
  }
  await ports.releaseStateSecrets()
  const left = await storedEntries(ports)
  if (left !== null && left.entries.length > 0) {
    throw new Error(
      'google-services: the OAuth accounts state still holds accounts after the release — kept',
    )
  }
  return { outcome: 'done', summary: { released: stored.entries.length } }
}

/**
 * Pure: reads the state and plans its deletion. It refuses while any account is still in it (the
 * release of step 7 has not landed), so the key never goes with a token the records lack.
 */
export async function planDropOauthAccountsState(
  ports: Pick<OauthAccountsPorts, 'readStored'>,
): Promise<MigrationPlan> {
  const left = await storedEntries(ports)
  if (left === null) return { edits: [] }
  if (left.entries.length > 0) {
    throw new Error(
      `google-services: the OAuth accounts state still holds ${left.entries.length} account(s) — kept until they are released`,
    )
  }
  const rowId = `${GOOGLE_ADDON_ID}.${OAUTH_ACCOUNTS_KEY}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: [rowId],
        precondition: preconditionOf({
          [rowId]: {
            addonId: GOOGLE_ADDON_ID,
            key: OAUTH_ACCOUNTS_KEY,
            value: left.value,
          },
        }),
      },
    ],
  }
}
