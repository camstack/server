/**
 * OpsLogStore — the EVENTS-domain operations audit for pipeline-analytics.
 *
 * pipeline-analytics already owns SQLite collections, so (unlike the recorder's
 * DurableState ring) the events ops-log is a DECLARED SQL-backed collection.
 * MUST be declared in `onInitialize` via `declare()` before the first insert —
 * an undeclared collection crash-loops the runner.
 *
 * Collection name: pipeline-analytics:ops-log
 *
 * Append is BEST-EFFORT (`append` catches + logs, never throws) — a failed
 * audit write must not fail the operation it records.
 */
import { OpsLogEntrySchema, OPS_LOG_DEFAULT_LIMIT } from '@camstack/types'
import type {
  IScopedLogger,
  OpsLogEntry,
  OpsLogQueryInput,
  OpsLogOp,
  OpsLogReason,
} from '@camstack/types'
import type { EventLedgerCollection } from './event-ledger-collection.js'

/**
 * @durable class=audit owner=pipeline-analytics database=events
 *   write="one row per events-domain maintenance op — every per-device prune the
 *     retention sweep performs (with items affected and the mode it ran in) and
 *     every operator-initiated purge. The append is BEST-EFFORT: it logs and
 *     swallows, because a failed audit write must not fail the op it records."
 *   retention="the ONE global clock in this addon — pruneBefore(now − 30 days,
 *     OPS_LOG_RETENTION_MS) on each retention tick. Deliberately NOT a device
 *     window: it records what retention did, including to devices that no longer
 *     exist. It had no clock at all until it reached 11,519 rows on the
 *     operator's hub."
 */
export const OPS_LOG_COLLECTION = 'pipeline-analytics:ops-log'

export const OPS_LOG_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'at', type: 'INTEGER' as const, notNull: true },
  { name: 'domain', type: 'TEXT' as const, notNull: true },
  { name: 'op', type: 'TEXT' as const, notNull: true },
  { name: 'reason', type: 'TEXT' as const, notNull: true },
  // Nullable: a cluster/global op carries no deviceId.
  { name: 'deviceId', type: 'INTEGER' as const },
  { name: 'nodeId', type: 'TEXT' as const, notNull: true },
  { name: 'itemsAffected', type: 'INTEGER' as const, notNull: true },
  { name: 'bytesReclaimed', type: 'INTEGER' as const, notNull: true },
  { name: 'detail', type: 'TEXT' as const },
  { name: 'actor', type: 'TEXT' as const, notNull: true },
] as const

/** The fields a caller supplies to record one events op — the store fills
 *  `id`, `at`, `domain` ('events') and `nodeId`. */
export interface EventsOpsLogAppendInput {
  readonly op: OpsLogOp
  readonly reason: OpsLogReason
  readonly deviceId: number | null
  readonly itemsAffected: number
  readonly bytesReclaimed: number
  readonly detail?: string | null
  readonly actor?: string
}

export interface OpsLogStoreDeps {
  readonly logger: IScopedLogger
  readonly nodeId: string
  readonly opsLedger: EventLedgerCollection
  readonly now?: () => number
  readonly newId?: () => string
}

export class OpsLogStore {
  private readonly logger: IScopedLogger
  private readonly ledger: EventLedgerCollection
  private readonly nodeId: string
  private readonly now: () => number
  private readonly newId: () => string

  constructor(deps: OpsLogStoreDeps) {
    this.logger = deps.logger
    this.ledger = deps.opsLedger
    this.nodeId = deps.nodeId
    this.now = deps.now ?? ((): number => Date.now())
    this.newId = deps.newId ?? ((): string => globalThis.crypto.randomUUID())
  }

  /**
   * Append one events-domain ops-log row. Best-effort — stamps
   * `domain:'events'`, `nodeId`, `id`, `at`, validates, inserts, and swallows
   * (logs) any failure so it can never fail the operation being audited.
   */
  async append(input: EventsOpsLogAppendInput): Promise<void> {
    const entry: OpsLogEntry = {
      id: this.newId(),
      at: this.now(),
      domain: 'events',
      op: input.op,
      reason: input.reason,
      deviceId: input.deviceId,
      nodeId: this.nodeId,
      itemsAffected: input.itemsAffected,
      bytesReclaimed: input.bytesReclaimed,
      detail: input.detail ?? null,
      actor: input.actor ?? 'operator',
    }
    try {
      const { id, ...rest } = OpsLogEntrySchema.parse(entry)
      await this.ledger.insert({ id, ...(rest as Record<string, unknown>) })
    } catch (err) {
      this.logger.warn('OpsLogStore.append failed (best-effort)', {
        tags: { deviceId: input.deviceId ?? undefined },
        meta: { op: input.op, error: String(err) },
      })
    }
  }

  /**
   * List events ops-log rows newest-first, optionally scoped to one device,
   * capped at `limit` (default {@link OPS_LOG_DEFAULT_LIMIT}).
   */
  async list(query: OpsLogQueryInput): Promise<readonly OpsLogEntry[]> {
    const filter: Record<string, unknown> = {
      orderBy: { field: 'at', direction: 'desc' },
      limit: query.limit ?? OPS_LOG_DEFAULT_LIMIT,
    }
    if (query.deviceId !== undefined) filter.where = { deviceId: query.deviceId }
    const rows = await this.ledger.query(filter)
    const out: OpsLogEntry[] = []
    for (const r of rows) {
      const parsed = OpsLogEntrySchema.safeParse({ id: r.id, ...stripNulls(r.data) })
      if (parsed.success) out.push(parsed.data)
      else this.logger.debug('OpsLogStore.list: skipped malformed row', { meta: { id: r.id } })
    }
    return out
  }

  /**
   * Delete audit entries older than `cutoffMs`. Returns how many went.
   *
   * The audit log is the one collection that records everyone else's
   * retention and had none of its own — it grows monotonically for the life of
   * the node (11,519 rows on the operator's hub before this existed).
   *
   * ONE statement, not a select-then-delete drain: `deleteWhere` is exactly
   * the bulk path that removed the N+1 loops from every other retention path.
   * `whereBetween` on `at` is inclusive, so `[0, cutoffMs - 1]` selects
   * strictly-older rows — the same boundary `EventStore.pruneBefore` uses.
   *
   * BEST-EFFORT, like `append`: a failed audit trim must never fail the
   * retention sweep that called it. It warns rather than throwing, because a
   * trim that silently does nothing is how a table gets to 11,519 rows.
   */
  async pruneBefore(cutoffMs: number): Promise<number> {
    try {
      return await this.ledger.deleteWhere({ whereBetween: { at: [0, cutoffMs - 1] } })
    } catch (err) {
      this.logger.warn('ops-log: prune failed — the audit log will keep growing', {
        meta: { cutoffMs, error: err instanceof Error ? err.message : String(err) },
      })
      return 0
    }
  }
}

/** SQLite stores nullable columns as `null`; the row schema uses `.nullable()`
 *  for deviceId/detail (accepts null) but drop any stray null on required
 *  fields defensively before parse. */
function stripNulls(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    // Keep null for the two nullable columns; drop null elsewhere so a legacy
    // row missing a required column fails validation loudly (skipped) instead of
    // silently coercing.
    if (v === null && k !== 'deviceId' && k !== 'detail') continue
    out[k] = v
  }
  return out
}
