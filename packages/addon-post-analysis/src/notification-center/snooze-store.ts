/**
 * NcSnoozeStore — the durable half of snooze.
 *
 * Two collections, and the split matters:
 *
 *  - **windows** (`notification-center:snoozes`) — small, mirrored into RAM,
 *    read on the dispatcher's hot path with zero I/O. Refreshed on the drain
 *    tick, so a window opened on the hub takes effect on the evaluating node
 *    within one tick (D8: reconcile, never trust an event to arrive).
 *  - **suppression counters** (`notification-center:snooze-suppressed`) — one
 *    row per (window, target, rule, camera), holding a COUNT and the first/last
 *    instant. Not one row per hidden notification: a snooze exists because
 *    something is noisy, so the row-per-event version of this table is unbounded
 *    exactly when it is used most. The digest reads "42 events, 14:03–17:58",
 *    which is the aggregate anyway.
 *
 * Expiry is never a job here either. Nothing in this file ends a window; the
 * clock does, and {@link NcSnoozeStore.prune} only reclaims rows long after the
 * fact. A prune that never runs delays a digest and wastes a few KB — it can
 * never leave the operator silenced.
 */

import { randomUUID } from 'node:crypto'
import type { IScopedLogger, NcSnooze, NcSnoozeSuppressed, RecordKindHandle } from '@camstack/types'
import { NcSnoozeSchema, NcSnoozeSuppressedSchema } from '@camstack/types'
import { DurableLedger, type DurableLedgerSpec } from '../durable/durable-ledger.js'
import type { DurableLedgerBody } from '../durable/durable-record-body.js'
import { type DurableKindDeps } from '../durable/durable-wiring.js'
import { ncDurableRecordKinds } from './nc-durable-record-kinds.js'
import { activeSnoozeFor, dueSummaries, type SnoozeQuery } from './snooze-policy.js'

/**
 * @durable class=ledger owner=notification-center
 *   write="operator opens/cancels a window, plus one digest stamp per window; write-through"
 *   retention="prune 6 h after a window CLOSES (never an open one) — the digest of what it hid is still owed until then"
 */
const NC_SNOOZES_COLLECTION = 'notification-center:snoozes'

/**
 * @durable class=ledger owner=notification-center database=events
 *   write="read-modify-write of a COUNT per (window, target, rule, camera) per suppressed notification — never a row per event"
 *   retention="deleted with its window, 6 h after that window closes"
 */
export const NC_SNOOZE_SUPPRESSED_COLLECTION = 'notification-center:snooze-suppressed'

const NC_SNOOZES_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'userId', type: 'TEXT' as const, notNull: true },
  { name: 'expiresAt', type: 'INTEGER' as const, notNull: true },
  /** The FULL window (Zod-validated on read); the scalars are projections. */
  { name: 'snooze', type: 'JSON' as const, notNull: true },
] as const

const NC_SNOOZES_INDEXES = [
  { name: 'idx_nc_snoozes_expires', columns: ['expiresAt'] as const },
] as const

/** How long a closed window's rows survive, for a retried digest and for
 *  "what did I miss" to still answer after a restart. */
const PRUNE_HORIZON_MS = 6 * 3600_000

/** One notification a window hid. */
export interface NcSuppressedNotification {
  readonly snoozeId: string
  readonly targetId: string
  readonly ruleId: string
  readonly ruleName: string
  readonly deviceId: number
  readonly at: number
}

export interface NcSnoozeStoreDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly newId?: () => string
}

/** Counter key — one row per (window, target, rule, camera). */
function counterKey(s: NcSuppressedNotification): string {
  return `${s.snoozeId}|${s.targetId}|${s.ruleId}|${s.deviceId}`
}

/**
 * The windows' mechanics, declared once — see `durable/durable-ledger.ts`.
 *
 * `write-through`: a window that exists only in RAM would silence the operator
 * until the next restart and then stop, silently. The store goes first.
 *
 * No `equalFact`: nothing here judges a repeat. A window is opened, cancelled
 * or stamped by an explicit act.
 *
 * A row whose JSON no longer validates is skipped by `fromRecord` — a
 * malformed window must never be able to silence anything.
 */
const NC_SNOOZES_SPEC: DurableLedgerSpec<NcSnooze> = {
  collection: NC_SNOOZES_COLLECTION,
  columns: NC_SNOOZES_COLUMNS,
  indexes: NC_SNOOZES_INDEXES,
  writeMode: 'write-through',
  keyOf: (snooze) => snooze.id,
  toValue: (snooze) => ({ userId: snooze.userId, expiresAt: snooze.expiresAt, snooze }),
  fromRecord: (_key, data) => {
    const parsed = NcSnoozeSchema.safeParse(data['snooze'])
    return parsed.success ? parsed.data : null
  },
  // The table holds active windows and recently closed ones — small enough to
  // read whole on every drain tick.
  loadLimit: 1_000,
}

export class NcSnoozeStore {
  private readonly windows: DurableLedger<NcSnooze>
  /** The `snooze-suppressed` records kind (events.db): the counters. */
  private readonly suppressed: RecordKindHandle<DurableLedgerBody>
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly newId: () => string

  constructor(deps: NcSnoozeStoreDeps) {
    this.suppressed = deps.records.kind(ncDurableRecordKinds['snooze-suppressed'])
    this.logger = deps.logger
    this.now = deps.now ?? ((): number => Date.now())
    this.newId = deps.newId ?? ((): string => randomUUID())
    this.windows = new DurableLedger({
      spec: NC_SNOOZES_SPEC,
      kind: deps.records.kind(ncDurableRecordKinds.snoozes),
      logger: deps.logger,
    })
  }

  /**
   * (Re)hydrate every window. Called at boot and on the drain tick.
   *
   * A failed load leaves the previous set in RAM rather than an empty one (the
   * primitive's contract rule 2): dropping every window on a transient store
   * error would un-silence the operator without them asking, which is the noisy
   * failure of this feature. Windows still expire on their own from the stale
   * copy.
   */
  async load(): Promise<void> {
    await this.windows.load()
  }

  /** Every known window, newest first. */
  list(): readonly NcSnooze[] {
    return this.windows.snapshot().toSorted((a, b) => b.startedAt - a.startedAt)
  }

  /** The windows a caller may SEE: their own, plus the global ones that
   *  silence them. Never another person's private silence. */
  listVisibleTo(userId: string, isAdmin: boolean): readonly NcSnooze[] {
    if (isAdmin) return this.list()
    return this.list().filter((s) => s.userId === userId || s.global)
  }

  get(snoozeId: string): NcSnooze | null {
    return this.windows.get(snoozeId) ?? null
  }

  /** Hot-path read — the window silencing this delivery, or null. */
  activeFor(query: SnoozeQuery): NcSnooze | null {
    return activeSnoozeFor(this.windows.snapshot(), query)
  }

  /**
   * Open a window. Permission for `global` is the CALLER's problem (see
   * `canSetGlobal`) — this store persists what it is given, exactly like the
   * rule store leaves ownership to the bridge action.
   */
  async create(input: {
    readonly userId: string
    readonly scope: NcSnooze['scope']
    readonly ruleId?: string
    readonly deviceId?: number
    /**
     * Narrow the window to these subject classes. Absent = every class, which
     * is what every window written before this field means.
     *
     * It rides the JSON blob and gets NO SQLite column, deliberately: nothing
     * queries windows by class (the gate reads the whole mirrored set), and a
     * column would be a second copy of a fact the validated blob already
     * holds — the drift this store's `fromRecord` exists to avoid.
     */
    readonly classes?: readonly string[]
    readonly durationMinutes: number
    readonly global: boolean
    readonly summary: boolean
  }): Promise<NcSnooze> {
    const startedAt = this.now()
    const snooze: NcSnooze = NcSnoozeSchema.parse({
      id: this.newId(),
      userId: input.userId,
      scope: input.scope,
      ...(input.ruleId !== undefined ? { ruleId: input.ruleId } : {}),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.classes !== undefined && input.classes.length > 0
        ? { classes: [...input.classes] }
        : {}),
      startedAt,
      expiresAt: startedAt + input.durationMinutes * 60_000,
      global: input.global,
      summary: input.summary,
    })
    await this.windows.put(snooze)
    return snooze
  }

  /**
   * End a window NOW by moving its expiry to this instant — never by deleting
   * it. The digest of what it hid is still owed to whoever opened it, and a
   * deleted row owes nothing.
   */
  async cancel(snoozeId: string): Promise<NcSnooze | null> {
    const existing = this.windows.get(snoozeId)
    if (existing === undefined) return null
    const now = this.now()
    // Already closed: leave the original expiry alone so the digest keeps the
    // window's real end.
    if (existing.expiresAt <= now) return existing
    const ended: NcSnooze = { ...existing, expiresAt: now }
    await this.windows.put(ended)
    return ended
  }

  /**
   * Record that a window hid one notification. Read-modify-write on the
   * counter row; best-effort, because losing a line of a SUMMARY must never
   * cost the suppression decision that produced it.
   */
  async recordSuppressed(s: NcSuppressedNotification): Promise<void> {
    const key = counterKey(s)
    try {
      const existing = await this.readCounter(key)
      const next: NcSnoozeSuppressed = {
        snoozeId: s.snoozeId,
        targetId: s.targetId,
        ruleId: s.ruleId,
        ruleName: s.ruleName,
        deviceId: s.deviceId,
        count: (existing?.count ?? 0) + 1,
        firstAt: existing?.firstAt ?? s.at,
        lastAt: s.at,
      }
      await this.suppressed.put({ id: key, deviceId: next.deviceId, data: { ...next } })
    } catch (err) {
      this.logger.warn('snooze suppression counter write failed (digest will under-report)', {
        tags: { deviceId: s.deviceId },
        meta: { snoozeId: s.snoozeId, ruleId: s.ruleId, error: String(err) },
      })
    }
  }

  /** Windows that have closed and still owe a digest. */
  dueDigests(nowMs: number): readonly NcSnooze[] {
    const all = this.windows.snapshot()
    const sent = new Set(all.filter((s) => s.digestSentAt !== undefined).map((s) => s.id))
    return dueSummaries(all, nowMs, sent)
  }

  /** What one window hid, grouped per target. */
  async suppressedFor(snoozeId: string): Promise<readonly NcSnoozeSuppressed[]> {
    try {
      const { records } = await this.suppressed.query({ where: { snoozeId }, limit: 1_000 })
      const out: NcSnoozeSuppressed[] = []
      for (const row of records) {
        const parsed = NcSnoozeSuppressedSchema.safeParse(row.data)
        if (parsed.success) out.push(parsed.data)
      }
      return out
    } catch (err) {
      this.logger.warn('snooze suppression read failed', {
        meta: { snoozeId, error: String(err) },
      })
      return []
    }
  }

  /**
   * Mark a digest as handled.
   *
   * Called after the ATTEMPT, not after a success: a digest that cannot be
   * delivered is not worth retrying every two seconds for six hours, and a
   * partially-sent one must not be re-sent to the targets that already got it.
   * The failure is logged with the window id — a missing digest is then a
   * findable line, not a silence inside a silence.
   */
  async markDigestSent(snoozeId: string): Promise<void> {
    const existing = this.windows.get(snoozeId)
    if (existing === undefined) return
    const marked: NcSnooze = { ...existing, digestSentAt: this.now() }
    await this.windows.put(marked)
  }

  /**
   * Drop windows that closed more than {@link PRUNE_HORIZON_MS} ago, and their
   * counters. Only ever touches CLOSED windows — an active one cannot be
   * pruned into oblivion by a clock argument.
   */
  async prune(nowMs: number): Promise<number> {
    const horizon = nowMs - PRUNE_HORIZON_MS
    const stale = this.windows.snapshot().filter((s) => s.expiresAt < horizon)
    let dropped = 0
    for (const s of stale) {
      try {
        // ONE statement for the counters — `deleteWhere` exists precisely so a
        // retention path is not an N+1 read-then-delete loop.
        await this.suppressed.deleteWhere({ where: { snoozeId: s.id } })
        await this.windows.forget(s.id)
        dropped += 1
      } catch (err) {
        this.logger.warn('snooze prune failed', { meta: { snoozeId: s.id, error: String(err) } })
      }
    }
    return dropped
  }

  private async readCounter(key: string): Promise<NcSnoozeSuppressed | null> {
    const row = await this.suppressed.get(key)
    if (row === null) return null
    const parsed = NcSnoozeSuppressedSchema.safeParse(row.data)
    return parsed.success ? parsed.data : null
  }
}
