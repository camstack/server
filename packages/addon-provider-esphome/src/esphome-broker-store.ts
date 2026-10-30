import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import { espBrokerEntrySchema, type EspBrokerEntry } from './config.js'
import { espBrokersEntryKind, type EspBrokerBody } from './broker-record-kinds.js'

function rowToEntry(id: string, data: EspBrokerBody): EspBrokerEntry | null {
  const parsed = espBrokerEntrySchema.safeParse({
    id,
    name: data.name,
    connection: data.connection,
    integrationId: data.integrationId,
  })
  return parsed.success ? parsed.data : null
}

/** Reads and writes the board list through the records store (secrets go to the keychain). */
export class EspBrokerStore {
  private readonly kind: RecordKindHandle<EspBrokerBody>

  constructor(kind: RecordKindHandle<EspBrokerBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): EspBrokerStore {
    return new EspBrokerStore(records.kind(espBrokersEntryKind))
  }

  /** Every board with its secrets resolved. A row whose secret is unavailable keeps the redacted body. */
  async listResolved(): Promise<EspBrokerEntry[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: EspBrokerEntry[] = []
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

  /** Delete exactly these rows; any other row (even one that cannot be read) stays. */
  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.kind.delete(id)
  }

  async replaceAll(entries: readonly EspBrokerEntry[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(entries.map((e) => e.id))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const entry of entries) {
      const { id, name, connection, integrationId } = entry
      const body = { name, connection, ...(integrationId === undefined ? {} : { integrationId }) }
      const parsed = espBrokersEntryKind.schema.safeParse(body)
      if (!parsed.success) throw new Error(`invalid ESPHome board '${id}': ${parsed.error.message}`)
      await this.kind.put({ id, data: parsed.data })
    }
  }
}
