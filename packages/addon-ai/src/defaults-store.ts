/**
 * Per-consumer / per-purpose default profile rows (spec §3) over the
 * `llm-defaults` record kind. Row id is the stable selector key so `set`
 * replaces and `set(selector, null)` deletes.
 */
import {
  type LlmDefault,
  LlmDefaultSchema,
  type LlmDefaultSelector,
  type RecordKindHandle,
  type RecordsAccess,
} from '@camstack/types'
import { aiRecordKinds } from './record-kinds.js'
import { readAllRows } from './record-pages.js'

/** Legacy collection name — kept for the adoption mapper / docs. */
export const DEFAULTS_COLLECTION = 'ai:llm-defaults'

function selectorKey(selector: LlmDefaultSelector): string {
  return 'consumer' in selector ? `consumer:${selector.consumer}` : `purpose:${selector.purpose}`
}

export class DefaultsStore {
  constructor(private readonly kind: RecordKindHandle<LlmDefault>) {}

  static of(records: Pick<RecordsAccess, 'kind'>): DefaultsStore {
    return new DefaultsStore(records.kind(aiRecordKinds['llm-defaults']))
  }

  async list(): Promise<LlmDefault[]> {
    const rows = await readAllRows(this.kind)
    const out: LlmDefault[] = []
    for (const row of rows) {
      const parsed = LlmDefaultSchema.safeParse(row.data)
      if (parsed.success) out.push(parsed.data)
    }
    return out
  }

  async set(selector: LlmDefaultSelector, profileId: string | null): Promise<void> {
    const id = selectorKey(selector)
    if (profileId === null) {
      await this.kind.delete(id)
      return
    }
    await this.kind.put({ id, data: { selector, profileId } })
  }
}
