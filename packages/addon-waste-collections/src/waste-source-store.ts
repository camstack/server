import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import {
  wasteSourceEntryKind,
  WasteSourceBodySchema,
  type WasteSourceBody,
} from './waste-source-record-kinds.js'
import { WasteSourceConfigSchema, type WasteSourceConfig } from './waste-types.js'

function rowToSource(id: string, data: WasteSourceBody): WasteSourceConfig | null {
  const parsed = WasteSourceConfigSchema.safeParse({
    id,
    label: data.name,
    module: data.module,
    args: data.args,
    enabled: data.enabled,
  })
  return parsed.success ? parsed.data : null
}

export class WasteSourceStore {
  private readonly kind: RecordKindHandle<WasteSourceBody>

  constructor(kind: RecordKindHandle<WasteSourceBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): WasteSourceStore {
    return new WasteSourceStore(records.kind(wasteSourceEntryKind))
  }

  async listResolved(): Promise<WasteSourceConfig[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: WasteSourceConfig[] = []
    for (const record of page.records) {
      let data = record.data
      try {
        const resolved = await this.kind.getResolved(record.id)
        if (resolved !== null) data = resolved.data
      } catch (err: unknown) {
        if (!(err instanceof RecordSecretUnavailableError)) throw err
      }
      const parsed = WasteSourceBodySchema.safeParse(data)
      if (!parsed.success) continue
      const row = rowToSource(record.id, parsed.data)
      if (row !== null) out.push(row)
    }
    return out
  }

  async replaceAll(sources: readonly WasteSourceConfig[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(sources.map((s) => s.id))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const source of sources) {
      const { id, label, module, args, enabled } = source
      const body = { name: label, module, args, enabled }
      const parsed = wasteSourceEntryKind.schema.safeParse(body)
      if (!parsed.success) throw new Error(`invalid waste source '${id}': ${parsed.error.message}`)
      await this.kind.put({ id, data: parsed.data })
    }
  }
}
