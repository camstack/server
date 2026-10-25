import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import { GoogleBrokerEntrySchema, type GoogleBrokerEntry } from './google-types.js'
import { googleBrokersEntryKind, type GoogleBrokerBody } from './broker-record-kinds.js'

function rowToEntry(id: string, data: GoogleBrokerBody): GoogleBrokerEntry | null {
  const parsed = GoogleBrokerEntrySchema.safeParse({ id, ...data })
  return parsed.success ? parsed.data : null
}

export class GoogleBrokerStore {
  private readonly kind: RecordKindHandle<GoogleBrokerBody>

  constructor(kind: RecordKindHandle<GoogleBrokerBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): GoogleBrokerStore {
    return new GoogleBrokerStore(records.kind(googleBrokersEntryKind))
  }

  async listResolved(): Promise<GoogleBrokerEntry[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: GoogleBrokerEntry[] = []
    for (const record of page.records) {
      let data = record.data
      try {
        const resolved = await this.kind.getResolved(record.id)
        if (resolved !== null) data = resolved.data
      } catch (err: unknown) {
        if (!(err instanceof RecordSecretUnavailableError)) throw err
      }
      const entry = rowToEntry(record.id, data)
      if (entry !== null) out.push(entry)
    }
    return out
  }

  async replaceAll(entries: readonly GoogleBrokerEntry[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(entries.map((e) => e.id))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const entry of entries) {
      const { id, name, clientId, clientSecret, calendarFilter, fromAddress, fromName } = entry
      const body = { name, clientId, clientSecret, calendarFilter, fromAddress, fromName }
      const parsed = googleBrokersEntryKind.schema.safeParse(body)
      if (!parsed.success) throw new Error(`invalid Google broker '${id}': ${parsed.error.message}`)
      await this.kind.put({ id, data: parsed.data })
    }
  }
}
