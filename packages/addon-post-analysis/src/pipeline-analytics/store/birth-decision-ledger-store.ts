/**
 * BirthDecisionLedgerStore — the durable record of every track-birth verdict
 * (D409).
 *
 * A declared SQL-backed collection, like the events ops-log and the debug-note
 * archive next door, and for the same reason: pipeline-analytics already owns
 * SQLite collections, and an undeclared collection crash-loops the runner. MUST
 * be declared in `onInitialize` before the first write.
 *
 * Collection name: pipeline-analytics:birth-decision-ledger
 *
 * ── Why a table rather than a log line ─────────────────────────────────────
 * The gate ALREADY logs every decision. `logs.query` is an in-memory ring that
 * measured 40 000 entries covering 38 MINUTES of fleet traffic on 2026-09-08 —
 * so a fourteenth field on that line answers nothing the next morning, and the
 * questions this data exists for ("what fraction of births on 102 were decided
 * on a coasted frame, over the week the operator complained about") are all
 * multi-day. A previous investigation in this repo was blocked for exactly
 * this.
 *
 * ── Why it is safe on the write path ──────────────────────────────────────
 * ONE INSERT PER BIRTH DECISION. Not per frame, not periodic, and never an
 * update of an existing row. Measured fleet-wide on the live hub, 2026-09-08:
 * 31 decided births in 38 minutes = ~49/hour = 0.014 writes/s. The write
 * amplification the runtime-state guard exists to prevent
 * (`scripts/check-runtime-state-durability.ts`: 12-19 writes/s rewriting
 * ~2.6-5 GB/day to maintain 161 KB) is three orders of magnitude above this and
 * is a different shape entirely — that one is a periodic REWRITE of a slice
 * whose values do not change. Nothing here advances a clock under an unchanged
 * value, because every row is new.
 *
 * ── Two properties, stated once ───────────────────────────────────────────
 *  - **It is not track-owned.** A SUPPRESSED birth never had a track; a
 *    confirmed one is expected to age out long before this row. The column is
 *    `sourceTrackId` and not `trackId` so the ownership derivation in
 *    `collection-classification.ts` cannot see it and cascade it away.
 *  - **It is bounded by COUNT, not by age.** A miss rate needs a denominator
 *    over whatever window the table holds; a quiet fleet should keep more of
 *    that window, not less. See {@link MAX_BIRTH_DECISION_RECORDS}.
 *
 * MEASUREMENT ONLY. Nothing reads this on the frame path; nothing gates on it.
 */

import {
  BIRTH_DECISION_DEFAULT_LIMIT,
  type BirthDecisionQueryInput,
  type BirthDecisionRecord,
  BirthDecisionRecordSchema,
  MAX_BIRTH_DECISION_RECORDS,
} from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import type { EventLedgerCollection } from './event-ledger-collection.js'
import type { BirthDecisionRecordDraft } from '../pipeline/birth-decision-record.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per track-birth VERDICT — appended by the birth loop in
 *     `processFrame` the instant the confirmation gate's verdict resolves
 *     (confirmed / suppressed / exhausted fail-open). Per BIRTH, never per
 *     frame: measured at ~49 rows/hour fleet-wide on 2026-09-08. Append-only,
 *     never updated. BEST-EFFORT — it logs and swallows, because a failed
 *     measurement must not fail the birth it measures."
 *   retention="NOT track retention and NOT an age clock — a miss rate needs
 *     whatever window the table holds, and an age sweep would shorten it on a
 *     quiet fleet exactly when more history is affordable. Bounded by ROW
 *     COUNT (MAX_BIRTH_DECISION_RECORDS, 30000, fleet-wide), oldest `at`
 *     first, trimmed on append. ~6 MB at the ceiling."
 */
export const BIRTH_DECISION_LEDGER_COLLECTION = 'pipeline-analytics:birth-decision-ledger'

export interface BirthDecisionLedgerStoreDeps {
  readonly logger: IScopedLogger
  readonly birthLedger: EventLedgerCollection
  readonly newId?: () => string
  /** The row ceiling. Injectable so the bound's BEHAVIOUR is testable without
   *  writing thirty thousand rows; production never passes it. */
  readonly maxRows?: number
  /** Appends between ceiling checks — see {@link DEFAULT_TRIM_EVERY}. Injectable
   *  for the same reason as `maxRows`; production never passes it. */
  readonly trimEvery?: number
}

export class BirthDecisionLedgerStore {
  private readonly logger: IScopedLogger
  private readonly ledger: EventLedgerCollection
  private readonly newId: () => string
  private readonly maxRows: number
  private readonly trimEvery: number
  /** Rows appended since the last trim — see {@link trim}. */
  private sinceTrim = 0

  constructor(deps: BirthDecisionLedgerStoreDeps) {
    this.logger = deps.logger
    this.ledger = deps.birthLedger
    this.newId = deps.newId ?? ((): string => globalThis.crypto.randomUUID())
    this.maxRows = deps.maxRows ?? MAX_BIRTH_DECISION_RECORDS
    this.trimEvery = deps.trimEvery ?? DEFAULT_TRIM_EVERY
  }

  /** The ceiling a store built without an override enforces. */
  static defaultMaxRows(): number {
    return MAX_BIRTH_DECISION_RECORDS
  }

  /**
   * Append one birth decision. NEVER THROWS.
   *
   * Best-effort, unlike the debug-note archive and deliberately so: that table
   * holds the only copy of something a PERSON typed, and this one holds a
   * measurement the system takes ~49 times an hour. A birth must not fail — nor
   * be delayed by a retry — because bookkeeping could not be written. The
   * failure is logged with `tags: { deviceId }` so a camera whose rows are
   * silently missing is attributable rather than an unexplained hole in the
   * denominator.
   */
  async append(draft: BirthDecisionRecordDraft): Promise<void> {
    try {
      const row: BirthDecisionRecord = BirthDecisionRecordSchema.parse({
        id: this.newId(),
        ...draft,
      })
      const { id, at, deviceId, ...rest } = row
      await this.ledger.insert({ id, at, deviceId, ...rest })
      this.sinceTrim += 1
      await this.trim()
    } catch (err) {
      this.logger.warn('birth-decision ledger append failed — this decision is not counted', {
        tags: { deviceId: draft.deviceId },
        meta: {
          trackId: draft.sourceTrackId,
          verdict: draft.verdict,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  /**
   * Hold the table at its ceiling, oldest first.
   *
   * NOT an age-keyed sweep and must never become one: the boundary is computed
   * from the POSITION of the excess rows, never from a clock. Rows sharing the
   * boundary timestamp go together, which at this write rate is a rounding
   * error against a 30 000-row ceiling.
   *
   * AMORTISED. The debug-note archive counts on every append because it writes
   * a few rows a week; this one writes ~49 an hour, and a `count` round trip per
   * birth would triple the ledger's own store traffic to answer a question whose
   * answer only changes on the row that crosses the ceiling. Checking once per
   * {@link DEFAULT_TRIM_EVERY} appends bounds the overshoot at that many rows —
   * 0.3% of the ceiling — for two hours' delay in enforcing it.
   */
  private async trim(): Promise<void> {
    if (this.sinceTrim < this.trimEvery) return
    this.sinceTrim = 0
    try {
      const held = await this.ledger.count()
      const excess = held - this.maxRows
      if (excess <= 0) return
      const oldest = await this.ledger.query({
        orderBy: { field: 'at', direction: 'asc' },
        limit: excess,
      })
      const boundary = oldest.reduce<number>((acc, r) => {
        const at = r.data['at']
        return typeof at === 'number' && at > acc ? at : acc
      }, 0)
      if (boundary === 0) return
      const deleted = await this.ledger.deleteWhere({ whereBetween: { at: [0, boundary] } })
      this.logger.info('birth-decision ledger trimmed to its ceiling', {
        meta: { held, ceiling: this.maxRows, deleted },
      })
    } catch (err) {
      this.logger.warn('birth-decision ledger trim failed — the ledger will keep growing', {
        meta: { ceiling: this.maxRows, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /** Birth decisions, newest first, optionally scoped by camera / verdict / age. */
  async list(query: BirthDecisionQueryInput): Promise<readonly BirthDecisionRecord[]> {
    const where: Record<string, unknown> = {}
    if (query.deviceId !== undefined) where['deviceId'] = query.deviceId
    if (query.verdict !== undefined) where['verdict'] = query.verdict
    const filter: Record<string, unknown> = {
      orderBy: { field: 'at', direction: 'desc' },
      limit: query.limit ?? BIRTH_DECISION_DEFAULT_LIMIT,
    }
    if (Object.keys(where).length > 0) filter['where'] = where
    // `>= since`, expressed with the one range predicate the backend compiles.
    if (query.since !== undefined) {
      filter['whereBetween'] = { at: [query.since, Number.MAX_SAFE_INTEGER] }
    }
    const rows = await this.ledger.query(filter)
    const out: BirthDecisionRecord[] = []
    for (const r of rows) {
      const parsed = BirthDecisionRecordSchema.safeParse({ id: r.id, ...r.data })
      if (parsed.success) out.push(parsed.data)
      else
        this.logger.debug('birth-decision ledger: skipped a malformed row', { meta: { id: r.id } })
    }
    return out
  }
}

/**
 * How many appends between ceiling checks, by default. See
 * {@link BirthDecisionLedgerStore.trim}.
 *
 * 100 rows is two hours of measured fleet traffic and 0.3% of the ceiling —
 * small enough that the table's real size never meaningfully exceeds its stated
 * bound, large enough that the ledger costs one `count` per two hours instead of
 * one per birth.
 */
const DEFAULT_TRIM_EVERY = 100
