import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import { MatterBrokerEntrySchema, type MatterBrokerEntry } from './config.js'
import { matterBrokersEntryKind, type MatterBrokerBody } from './broker-record-kinds.js'

function rowToEntry(id: string, data: MatterBrokerBody): MatterBrokerEntry | null {
  const parsed = MatterBrokerEntrySchema.safeParse({
    id,
    name: data.name,
    connection: data.connection,
    integrationId: data.integrationId,
  })
  return parsed.success ? parsed.data : null
}

export class MatterBrokerStore {
  private readonly kind: RecordKindHandle<MatterBrokerBody>

  constructor(kind: RecordKindHandle<MatterBrokerBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): MatterBrokerStore {
    return new MatterBrokerStore(records.kind(matterBrokersEntryKind))
  }

  async listResolved(): Promise<MatterBrokerEntry[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: MatterBrokerEntry[] = []
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

  async replaceAll(entries: readonly MatterBrokerEntry[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(entries.map((e) => e.id))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const entry of entries) {
      const { id, name, connection, integrationId } = entry
      const body = { name, connection, ...(integrationId === undefined ? {} : { integrationId }) }
      const parsed = matterBrokersEntryKind.schema.safeParse(body)
      if (!parsed.success) throw new Error(`invalid Matter broker '${id}': ${parsed.error.message}`)
      await this.kind.put({ id, data: parsed.data })
    }
  }
}
