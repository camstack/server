/**
 * The durable record of what the deleted-device / deleted-target prune did to
 * a rule, and WHY — the only place that answer lives.
 *
 * Two readers, and each is why this is a table and not a log line:
 *
 *  - the prune itself, as its DISABLE-ONCE guard. A rule whose last device was
 *    deleted is kept and switched off exactly once; an operator who switches it
 *    back on is never overridden by the next reconcile tick. Without a durable
 *    row, every restart would disable it again.
 *  - both UIs (`nc.listPrunes`), for the banner "Disabled on <date>: its last
 *    device (#id) was deleted". A rule that switched itself off with no reason
 *    anywhere reads as a bug.
 *
 * Why not a `disabledReason` on the rule row: `NcRuleSchema` and
 * `TimelapseRuleSchema` live in `@camstack/types` and `fromRecord` drops
 * unknown keys, so a new field would need a framework release before it
 * survived a load. This side table ships with the addon.
 *
 * ── Load failure direction ─────────────────────────────────────────────────
 *
 * The guard is a DESTRUCTIVE-direction read: an empty ledger says "never
 * disabled", and acting on that would switch off a rule the operator had
 * re-enabled. So this ledger tracks whether a load has SUCCEEDED, and the
 * pruner does nothing until one has (D49: a read that fails changes nothing).
 * {@link DurableLedger.load} swallows a failed read by design, so the load is
 * done here and handed to the ledger through `stage` / `evict`.
 */

import type { IScopedLogger, RecordKindHandle } from '@camstack/types'
import { z } from 'zod'
import { DurableLedger, type DurableLedgerSpec } from '../durable/durable-ledger.js'
import type { DurableLedgerBody } from '../durable/durable-record-body.js'
import { type DurableKindDeps } from '../durable/durable-wiring.js'
import { ncDurableRecordKinds } from './nc-durable-record-kinds.js'
import type { NcPruneGuardKey, NcPruneKind, NcPruneNote, NcPruneSource } from './device-prune.js'

/**
 * @durable class=ledger owner=notification-center
 *   write="the evaluating node prunes a DELETED device or target from a notification / timelapse / summary rule — one row per (rule, field, subject), written after the rule write landed"
 *   retention="none — bounded by rules × deleted subjects; a row whose rule was deleted is inert (no reader asks about a rule that is gone)"
 */
const NC_DEVICE_PRUNES_COLLECTION = 'notification-center:device-prunes'

const NC_DEVICE_PRUNES_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'ruleId', type: 'TEXT' as const, notNull: true },
  { name: 'at', type: 'INTEGER' as const, notNull: true },
  /** The FULL row (Zod-validated on read). */
  { name: 'row', type: 'JSON' as const, notNull: true },
] as const

/** One recorded prune, as `nc.listPrunes` serves it. */
export const NcPruneRecordSchema = z.object({
  kind: z.enum(['rule', 'timelapse', 'summary']),
  ruleId: z.string().min(1),
  subjectKind: z.enum(['device', 'target']),
  /** Device id as a decimal string, or the target id. */
  subject: z.string().min(1),
  field: z.string().min(1),
  outcome: z.enum(['removed', 'kept-disabled', 'kept', 'sequence-removed', 'binding-removed']),
  at: z.number(),
  source: z.enum(['event', 'reconcile']),
})
export type NcPruneRecord = z.infer<typeof NcPruneRecordSchema>

/** Rules × deleted subjects — small; a generous ceiling. */
const LOAD_LIMIT = 10_000
/** Page size of the load's records query. */
const LOAD_PAGE = 1_000

function keyOf(row: Pick<NcPruneRecord, 'kind' | 'ruleId' | 'field' | 'subject'>): string {
  return `${row.kind}:${row.ruleId}:${row.field}:${row.subject}`
}

const NC_DEVICE_PRUNES_SPEC: DurableLedgerSpec<NcPruneRecord> = {
  collection: NC_DEVICE_PRUNES_COLLECTION,
  columns: [...NC_DEVICE_PRUNES_COLUMNS],
  writeMode: 'write-through',
  keyOf,
  toValue: (row) => ({ ruleId: row.ruleId, at: row.at, row }),
  fromRecord: (_key, data) => {
    const parsed = NcPruneRecordSchema.safeParse(data['row'])
    return parsed.success ? parsed.data : null
  },
  deviceIdOf: (row) => (row.subjectKind === 'device' ? Number(row.subject) : undefined),
  loadLimit: LOAD_LIMIT,
}

export interface NcPruneLedgerDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
}

/** The outcomes that mean "this last reference was already dealt with". */
const KEPT_OUTCOMES: ReadonlySet<NcPruneRecord['outcome']> = new Set(['kept-disabled', 'kept'])

export class NcPruneLedger {
  private readonly ledger: DurableLedger<NcPruneRecord>
  /**
   * The SAME handle the ledger writes through — the records kind wherever
   * `ctx.records` exists. The load reads it, never the legacy table: no boot
   * declares that table any more, so a direct read of it fails forever.
   */
  private readonly kind: RecordKindHandle<DurableLedgerBody>
  private readonly logger: IScopedLogger
  private loaded = false
  /** Bumped on every {@link record} write — a load ignores keys written after it began. */
  private writes = 0
  private readonly writtenAt = new Map<string, number>()

  constructor(deps: NcPruneLedgerDeps) {
    this.logger = deps.logger
    this.kind = deps.records.kind(ncDurableRecordKinds['device-prunes'])
    this.ledger = new DurableLedger({
      spec: NC_DEVICE_PRUNES_SPEC,
      kind: this.kind,
      logger: deps.logger,
    })
  }

  /**
   * (Re)hydrate. A failed read keeps what is mirrored AND leaves
   * {@link isLoaded} as it was — see the module docblock.
   */
  async load(): Promise<void> {
    // Only rows held BEFORE the read may be evicted by it: a row written while
    // the query was in flight is newer than its answer.
    const heldBefore = new Set(this.ledger.snapshot().map(keyOf))
    const startedAt = this.writes
    const writtenSince = (key: string): boolean => (this.writtenAt.get(key) ?? 0) > startedAt
    try {
      const next = await this.readAll()
      // A key this process wrote while the read was in flight is fresher than
      // the answer — neither evicted nor overwritten by it.
      for (const key of heldBefore) {
        if (!next.has(key) && !writtenSince(key)) this.ledger.evict(key)
      }
      for (const [key, row] of next) {
        if (!writtenSince(key)) this.ledger.stage(row)
      }
      this.loaded = true
    } catch (err) {
      this.logger.warn('prune ledger load failed — no prune runs until it loads', {
        meta: { error: String(err), held: this.ledger.size, loaded: this.loaded },
      })
    }
  }

  /** Every row the kind holds, paged. THROWS on a failed page — `load` is the guard. */
  private async readAll(): Promise<Map<string, NcPruneRecord>> {
    const next = new Map<string, NcPruneRecord>()
    let seen = 0
    let cursor: string | undefined
    while (seen < LOAD_LIMIT) {
      const page = await this.kind.query({
        limit: Math.min(LOAD_PAGE, LOAD_LIMIT - seen),
        ...(cursor === undefined ? {} : { cursor }),
      })
      seen += page.records.length
      for (const record of page.records) {
        const row = NC_DEVICE_PRUNES_SPEC.fromRecord(record.id, record.data)
        if (row !== null) next.set(keyOf(row), row)
      }
      if (page.nextCursor === null || page.records.length === 0) break
      cursor = page.nextCursor
    }
    return next
  }

  /** Has a load ever SUCCEEDED? The pruner acts on nothing until it has. */
  isLoaded(): boolean {
    return this.loaded
  }

  /** The disable-once guard: was this last reference already recorded? */
  hasKept(key: NcPruneGuardKey): boolean {
    return this.ledger
      .snapshot()
      .some(
        (row) =>
          row.kind === key.kind &&
          row.ruleId === key.ruleId &&
          row.subjectKind === key.subjectKind &&
          row.subject === key.subject &&
          KEPT_OUTCOMES.has(row.outcome),
      )
  }

  /**
   * Write one row per note. Throws on a failed write (write-through).
   *
   * A `kept*` row is NEVER overwritten by a later removal of the same
   * (rule, field, subject): it is the disable-once guard, and a stale save that
   * re-added the dead id beside a live one would otherwise erase it.
   */
  async record(notes: readonly NcPruneNote[], source: NcPruneSource, at: number): Promise<void> {
    for (const note of notes) {
      const held = this.ledger.get(keyOf(note))
      if (
        held !== undefined &&
        KEPT_OUTCOMES.has(held.outcome) &&
        !KEPT_OUTCOMES.has(note.outcome)
      ) {
        continue
      }
      const row = NcPruneRecordSchema.parse({ ...note, at, source })
      this.writes += 1
      this.writtenAt.set(keyOf(row), this.writes)
      await this.ledger.put(row)
    }
  }

  /** Every row, newest first. */
  list(): readonly NcPruneRecord[] {
    return this.ledger.snapshot().toSorted((a, b) => b.at - a.at)
  }

  /** Rows about one rule — a UI asks about the rule it is showing. */
  listFor(kind: NcPruneKind, ruleId: string): readonly NcPruneRecord[] {
    return this.list().filter((row) => row.kind === kind && row.ruleId === ruleId)
  }
}
