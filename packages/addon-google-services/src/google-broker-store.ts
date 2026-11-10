/**
 * The Google accounts as `brokers` records: the OAuth client AND the account's session (refresh
 * token through the keychain, email, scopes, needsReauth; planning#480). The records are the only
 * store; the access token is never written.
 */
import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import {
  GoogleBrokerEntrySchema,
  type GoogleBrokerEntry,
  type GoogleSession,
  GoogleSessionSchema,
} from './google-types.js'
import { googleBrokersEntryKind, type GoogleBrokerBody } from './broker-record-kinds.js'

/** One account's stored session, with its record id. */
export interface StoredGoogleSession extends GoogleSession {
  readonly id: string
}

/** Every account record: its client entry, its session when the keychain served it. */
export interface GoogleAccountsRead {
  readonly entries: readonly GoogleBrokerEntry[]
  readonly sessions: readonly StoredGoogleSession[]
  /** Records whose secrets the keychain could not serve right now: no session is known for them. */
  readonly unresolved: readonly string[]
}

function rowToEntry(id: string, data: GoogleBrokerBody): GoogleBrokerEntry | null {
  const parsed = GoogleBrokerEntrySchema.safeParse({ id, ...data })
  return parsed.success ? parsed.data : null
}

function sessionOf(id: string, data: GoogleBrokerBody): StoredGoogleSession {
  return { id, ...GoogleSessionSchema.parse(data) }
}

export class GoogleBrokerStore {
  private readonly kind: RecordKindHandle<GoogleBrokerBody>

  constructor(kind: RecordKindHandle<GoogleBrokerBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): GoogleBrokerStore {
    return new GoogleBrokerStore(records.kind(googleBrokersEntryKind))
  }

  /**
   * Every account, secrets resolved. A record the keychain cannot serve keeps its entry (the
   * client secret reads as the redaction token, as before) but has NO session: a locked keychain
   * is never read as "signed out", and never as a token.
   */
  async loadAll(): Promise<GoogleAccountsRead> {
    const page = await this.kind.query({ limit: 1000 })
    const entries: GoogleBrokerEntry[] = []
    const sessions: StoredGoogleSession[] = []
    const unresolved: string[] = []
    for (const record of page.records) {
      let data = record.data
      let resolved = false
      try {
        const row = await this.kind.getResolved(record.id)
        if (row !== null) {
          data = row.data
          resolved = true
        }
      } catch (err: unknown) {
        if (!(err instanceof RecordSecretUnavailableError)) throw err
        unresolved.push(record.id)
      }
      const entry = rowToEntry(record.id, data)
      if (entry === null) continue
      entries.push(entry)
      if (resolved) sessions.push(sessionOf(record.id, data))
    }
    return { entries, sessions, unresolved }
  }

  async listResolved(): Promise<GoogleBrokerEntry[]> {
    return [...(await this.loadAll()).entries]
  }

  /** One account's session, resolved; null when the record is absent. Throws when the keychain cannot serve it. */
  async readSession(id: string): Promise<StoredGoogleSession | null> {
    const row = await this.kind.getResolved(id)
    return row === null ? null : sessionOf(id, row.data)
  }

  /** Create an account record (its client); refused when the id exists. */
  async putOne(entry: GoogleBrokerEntry, session?: GoogleSession): Promise<void> {
    const { id, name, clientId, clientSecret, calendarFilter, fromAddress, fromName } = entry
    const parsed = googleBrokersEntryKind.schema.safeParse({
      name,
      clientId,
      clientSecret,
      calendarFilter,
      fromAddress,
      fromName,
      ...session,
    })
    if (!parsed.success) throw new Error(`invalid Google broker '${id}': ${parsed.error.message}`)
    await this.kind.put({ id, data: parsed.data }, { ifRev: 0 })
  }

  /**
   * Write an account's session onto its record (a patch: the client fields are untouched). An
   * empty refresh token KEEPS the stored one; {@link clearSession} is how a token is forgotten.
   */
  async saveSession(id: string, session: GoogleSession): Promise<void> {
    const parsed = GoogleSessionSchema.parse(session)
    await this.kind.patch(id, {
      refreshToken: parsed.refreshToken,
      accountEmail: parsed.accountEmail,
      scopes: parsed.scopes,
      needsReauth: parsed.needsReauth,
    })
  }

  /** Sign-out: the refresh token leaves the record AND the keychain; the session fields reset. */
  async clearSession(id: string): Promise<void> {
    await this.kind.patch(id, {
      refreshToken: null,
      accountEmail: '',
      scopes: '',
      needsReauth: false,
    })
  }

  async rename(id: string, name: string): Promise<void> {
    await this.kind.patch(id, { name })
  }
}
