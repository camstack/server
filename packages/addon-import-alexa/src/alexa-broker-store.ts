import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import { AlexaBrokerEntrySchema, type AlexaBrokerEntry } from './config.js'
import { alexaBrokersEntryKind, type AlexaBrokerBody } from './broker-record-kinds.js'

function rowToEntry(id: string, data: AlexaBrokerBody): AlexaBrokerEntry | null {
  const parsed = AlexaBrokerEntrySchema.safeParse({
    id,
    name: data.name,
    connection: data.connection,
    integrationId: data.integrationId,
  })
  return parsed.success ? parsed.data : null
}

export class AlexaBrokerStore {
  private readonly kind: RecordKindHandle<AlexaBrokerBody>

  constructor(kind: RecordKindHandle<AlexaBrokerBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): AlexaBrokerStore {
    return new AlexaBrokerStore(records.kind(alexaBrokersEntryKind))
  }

  async listResolved(): Promise<AlexaBrokerEntry[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: AlexaBrokerEntry[] = []
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

  async replaceAll(entries: readonly AlexaBrokerEntry[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(entries.map((e) => e.id))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const entry of entries) {
      const { id, name, connection, integrationId } = entry
      const body = { name, connection, ...(integrationId === undefined ? {} : { integrationId }) }
      const parsed = alexaBrokersEntryKind.schema.safeParse(body)
      if (!parsed.success) throw new Error(`invalid Alexa broker '${id}': ${parsed.error.message}`)
      await this.kind.put({ id, data: parsed.data })
    }
  }
}
