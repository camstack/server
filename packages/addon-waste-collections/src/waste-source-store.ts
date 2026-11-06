import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import { wasteSourceEntryKind, type WasteSourceBody } from './waste-source-record-kinds.js'
import { hasUnresolvedCredential } from './waste-secrets.js'
import { WasteSourceConfigSchema, type WasteSourceConfig } from './waste-types.js'

/**
 * A stored body as a source. A row read while the keychain is locked still carries its markers
 * in `args`; the config schema keeps them, so the source lists and its fetch refuses by name.
 */
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

function bodyOf(source: WasteSourceConfig): WasteSourceBody {
  const { id, label, module, args, enabled } = source
  const body = { name: label, module, args, enabled }
  const parsed = wasteSourceEntryKind.schema.safeParse(body)
  if (!parsed.success) throw new Error(`invalid waste source '${id}': ${parsed.error.message}`)
  return parsed.data
}

export class WasteSourceStore {
  private readonly kind: RecordKindHandle<WasteSourceBody>

  constructor(kind: RecordKindHandle<WasteSourceBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): WasteSourceStore {
    return new WasteSourceStore(records.kind(wasteSourceEntryKind))
  }

  /** The record ids, whatever their content. */
  async listIds(): Promise<readonly string[]> {
    const page = await this.kind.query({ limit: 1000 })
    return page.records.map((record) => record.id)
  }

  /** One source with its credentials resolved; markers stay where the keychain cannot serve. */
  async readResolved(id: string): Promise<WasteSourceConfig | null> {
    const stored = await this.kind.get(id)
    if (stored === null) return null
    let data = stored.data
    try {
      const resolved = await this.kind.getResolved(id)
      if (resolved !== null) data = resolved.data
    } catch (err: unknown) {
      if (!(err instanceof RecordSecretUnavailableError)) throw err
    }
    return rowToSource(id, data)
  }

  async listResolved(): Promise<WasteSourceConfig[]> {
    const out: WasteSourceConfig[] = []
    for (const id of await this.listIds()) {
      const row = await this.readResolved(id)
      if (row !== null) out.push(row)
    }
    return out
  }

  /** Create the record when the id is free; an existing record is never touched. */
  async putIfAbsent(source: WasteSourceConfig): Promise<boolean> {
    if ((await this.kind.get(source.id)) !== null) return false
    await this.kind.put({ id: source.id, data: bodyOf(source) }, { ifRev: 0 })
    return true
  }

  /**
   * Make the records equal `sources`. A source whose credential the keychain did not serve is
   * left exactly as stored: rewriting it would save a marker as the credential.
   */
  async replaceAll(sources: readonly WasteSourceConfig[]): Promise<void> {
    const nextIds = new Set(sources.map((s) => s.id))
    for (const id of await this.listIds()) {
      if (!nextIds.has(id)) await this.kind.delete(id)
    }
    for (const source of sources) {
      if (hasUnresolvedCredential(source.args)) continue
      await this.kind.put({ id: source.id, data: bodyOf(source) })
    }
  }
}
