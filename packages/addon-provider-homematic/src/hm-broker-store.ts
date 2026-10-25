import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import { HmBrokerEntrySchema, type HmBrokerEntry } from './config.js'
import { hmBrokersEntryKind, type HmBrokerBody } from './broker-record-kinds.js'

function rowToEntry(id: string, data: HmBrokerBody): HmBrokerEntry | null {
  const parsed = HmBrokerEntrySchema.safeParse({
    id,
    name: data.name,
    connection: data.connection,
    integrationId: data.integrationId,
  })
  return parsed.success ? parsed.data : null
}

export class HmBrokerStore {
  private readonly kind: RecordKindHandle<HmBrokerBody>

  constructor(kind: RecordKindHandle<HmBrokerBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): HmBrokerStore {
    return new HmBrokerStore(records.kind(hmBrokersEntryKind))
  }

  async listResolved(): Promise<HmBrokerEntry[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: HmBrokerEntry[] = []
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

  async replaceAll(entries: readonly HmBrokerEntry[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(entries.map((e) => e.id))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const entry of entries) {
      const { id, name, connection, integrationId } = entry
      const body = { name, connection, ...(integrationId === undefined ? {} : { integrationId }) }
      const parsed = hmBrokersEntryKind.schema.safeParse(body)
      if (!parsed.success) throw new Error(`invalid HM broker '${id}': ${parsed.error.message}`)
      await this.kind.put({ id, data: parsed.data })
    }
  }
}
