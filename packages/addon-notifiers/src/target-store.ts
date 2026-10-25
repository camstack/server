/**
 * Persistence for notification targets over the `notification-targets` record
 * kind (records plan phase 2, step 17).
 *
 * The store is addressed through a `RecordKindHandle<TargetBody>` — the
 * records facade handles all transport, boot-guard, and index concerns. No
 * `init()` or `declareCollection` call: kinds are declared at addon boot via
 * `ctx.records.declare(notifiersRecordKinds)` before this store is constructed.
 *
 * A row body is `{ name, kind, addonId, enabled, config }` (the record id IS
 * the target id). Secrets inside `config` are handled at the provider level by
 * `secrets.ts` (redact on read, merge on write); the records layer stores
 * the blob verbatim.
 */
import {
  type RecordKindHandle,
  type RecordsAccess,
  type Target,
  TargetSchema,
} from '@camstack/types'
import { notifiersRecordKinds, type TargetBody } from './record-kinds.js'

/** Legacy collection name — kept for the adoption mapper and docs. */
export const TARGETS_COLLECTION = 'notifiers:notification-targets'

function rowToTarget(id: string, data: TargetBody): Target | null {
  const parsed = TargetSchema.safeParse({ id, ...data })
  return parsed.success ? parsed.data : null
}

export class TargetStore {
  private readonly kind: RecordKindHandle<TargetBody>

  constructor(kind: RecordKindHandle<TargetBody>) {
    this.kind = kind
  }

  /** Factory: build from a declared `RecordsAccess` (after `ctx.records.declare`). */
  static of(records: Pick<RecordsAccess, 'kind'>): TargetStore {
    return new TargetStore(records.kind(notifiersRecordKinds['notification-targets']))
  }

  async list(): Promise<Target[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: Target[] = []
    for (const record of page.records) {
      const target = rowToTarget(record.id, record.data)
      if (target !== null) out.push(target)
    }
    return out
  }

  async getById(id: string): Promise<Target | null> {
    const row = await this.kind.get(id)
    if (row === null) return null
    return rowToTarget(row.id, row.data)
  }

  /** Upsert by id — inserts a new row or replaces the existing one. */
  async upsert(target: Target): Promise<void> {
    const { id, ...rest } = target
    // Validate the body (ensures kind, name, addonId, enabled and config are present).
    const parsed = notifiersRecordKinds['notification-targets'].schema.safeParse(rest)
    if (!parsed.success) {
      throw new Error(`invalid target '${id}': ${parsed.error.message}`)
    }
    await this.kind.put({ id, data: parsed.data })
  }

  async delete(id: string): Promise<void> {
    await this.kind.delete(id)
  }

  /** Flip `enabled` on an existing target. Returns the updated target, or null if absent. */
  async setEnabled(id: string, enabled: boolean): Promise<Target | null> {
    const target = await this.getById(id)
    if (target === null) return null
    const next: Target = { ...target, enabled }
    await this.upsert(next)
    return next
  }
}
