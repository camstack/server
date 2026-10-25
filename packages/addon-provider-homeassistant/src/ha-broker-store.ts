/**
 * CRUD for HA brokers over the `brokers` entry record kind (B2).
 */
import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import { HaBrokerEntrySchema, type HaBrokerEntry } from './ha-broker-registry.js'
import { haBrokersEntryKind, type HaBrokerBody, HA_BROKERS_KIND } from './broker-record-kinds.js'

function rowToEntry(id: string, data: HaBrokerBody): HaBrokerEntry | null {
  const parsed = HaBrokerEntrySchema.safeParse({
    id,
    name: data.name,
    auth: data.auth,
    integrationId: data.integrationId,
  })
  return parsed.success ? parsed.data : null
}

export class HaBrokerStore {
  private readonly kind: RecordKindHandle<HaBrokerBody>

  constructor(kind: RecordKindHandle<HaBrokerBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): HaBrokerStore {
    return new HaBrokerStore(records.kind(haBrokersEntryKind))
  }

  async listResolved(): Promise<HaBrokerEntry[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: HaBrokerEntry[] = []
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

  async getById(id: string): Promise<HaBrokerEntry | null> {
    try {
      const row = await this.kind.getResolved(id)
      if (row === null) return null
      return rowToEntry(row.id, row.data)
    } catch (err: unknown) {
      if (err instanceof RecordSecretUnavailableError) return null
      throw err
    }
  }

  async upsert(entry: HaBrokerEntry): Promise<void> {
    const { id, name, auth, integrationId } = entry
    const body = { name, auth, ...(integrationId === undefined ? {} : { integrationId }) }
    const parsed = haBrokersEntryKind.schema.safeParse(body)
    if (!parsed.success) {
      throw new Error(`invalid HA broker '${id}': ${parsed.error.message}`)
    }
    await this.kind.put({ id, data: parsed.data })
  }

  async delete(id: string): Promise<void> {
    await this.kind.delete(id)
  }

  async replaceAll(entries: readonly HaBrokerEntry[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(entries.map((e) => e.id))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const entry of entries) await this.upsert(entry)
  }
}

/** Kind handle for tests that seed rows without the store. */
export function haBrokersKindHandle(
  records: Pick<RecordsAccess, 'kind'>,
): RecordKindHandle<HaBrokerBody> {
  return records.kind(haBrokersEntryKind)
}

export { HA_BROKERS_KIND }
