/**
 * Where a bulk sweep's resume position LIVES — on disk, not in RAM (D480).
 *
 * The orphan audit paged `pipeline-analytics:media` with an offset cursor held
 * in a field on the addon instance, behind a docblock arguing that persisting
 * it "would be a durable record of a purely advisory position". A position that
 * resets to zero is not advisory: this addon respawns several times a day (nine
 * on the day of measurement) and the sweep interval is six hours, so the cursor
 * almost never survived to a second pass. Every pass re-walked offsets
 * 0–20 000 of a 532 384-row collection and stopped, for ten days, and the 96 %
 * behind the ceiling — 23 594 orphaned rows, 9 714 MiB — was never examined.
 *
 * One KV row, read once per pass and written once per pass. The whole map is
 * one value on purpose: the scopes are a handful (one per media owner kind plus
 * the track-owned collections), and a partial write that left one shard's
 * cursor behind another's would be the same blind spot with a smaller radius.
 *
 * Losing the row costs a re-walk from the top, never correctness — every scope
 * is idempotent and the cursor is only ever a starting offset.
 */

import type { IScopedLogger, RecordKindHandle, RecordsAccess } from '@camstack/types'
import { pipelineAnalyticsRecordKinds, type SweepCursorBody } from '../record-kinds.js'
import type { OrphanCursor } from '../retention/orphan-audit.js'

/** Legacy collection name — kept for the classification, the adoption mapper and docs. */
export const SWEEP_CURSOR_COLLECTION = 'pipeline-analytics:sweep-cursors'

/** The orphan audit's row. One sweep, one key. */
const ORPHAN_AUDIT_CURSOR_KEY = 'orphan-audit'

/**
 * What one sweep resumes from.
 *
 * The vector-index legs are not settings-store collections, so their cursors
 * ride in their own fields rather than in the scope map: a key added to the
 * scope map is dropped the next time the caller assigns the map wholesale (the
 * walk would restart at row 0 every pass and never reach the tail).
 * `clipIndexCursors` holds one per CLIP index, `faceVectorCursor` the
 * `face-arcface` walk. The retired MobileCLIP index had a field of its own
 * (`embeddingCursor`); nothing reads or writes it any more (D871), and a
 * stored row that still carries it is read without it.
 */
export interface OrphanAuditCursors {
  /** Per scope: an offset (number) or an opaque records keyset cursor (string). */
  readonly scopes: Readonly<Record<string, OrphanCursor>>
  /** The `face-arcface` walk. Absent on a row written before it existed — and
   *  absent means "start from the top", which costs a re-walk and nothing else. */
  readonly faceVectorCursor: number
  /** The walk of each CLIP index, keyed by index name (D649). Absent on an older row ⇒ from the top. */
  readonly clipIndexCursors: Readonly<Record<string, number>>
  readonly updatedAtMs: number
}

function decodeCursorMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (raw !== null && typeof raw === 'object') {
    for (const [key, cursor] of Object.entries({ ...raw })) {
      const parsed = nonNegativeInt(cursor)
      if (parsed !== null) out[key] = parsed
    }
  }
  return out
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}

function decodeScopeCursors(raw: unknown): Record<string, OrphanCursor> {
  const out: Record<string, OrphanCursor> = {}
  if (raw !== null && typeof raw === 'object') {
    for (const [key, cursor] of Object.entries({ ...raw })) {
      if (typeof cursor === 'string' && cursor.length > 0) {
        out[key] = cursor
        continue
      }
      const parsed = nonNegativeInt(cursor)
      if (parsed !== null) out[key] = parsed
    }
  }
  return out
}

/** Read a stored row back into a cursor map, ignoring anything unreadable. */
export function decodeOrphanAuditCursors(value: unknown): OrphanAuditCursors {
  const empty: OrphanAuditCursors = {
    scopes: {},
    faceVectorCursor: 0,
    clipIndexCursors: {},
    updatedAtMs: 0,
  }
  if (value === null || typeof value !== 'object') return empty
  const row: Record<string, unknown> = { ...value }
  return {
    scopes: decodeScopeCursors(row['scopes']),
    faceVectorCursor: nonNegativeInt(row['faceVectorCursor']) ?? 0,
    clipIndexCursors: decodeCursorMap(row['clipIndexCursors']),
    updatedAtMs: nonNegativeInt(row['updatedAtMs']) ?? 0,
  }
}

export class SweepCursorStore {
  private readonly kind: RecordKindHandle<SweepCursorBody>
  private readonly logger: IScopedLogger

  constructor(deps: {
    readonly kind: RecordKindHandle<SweepCursorBody>
    readonly logger: IScopedLogger
  }) {
    this.kind = deps.kind
    this.logger = deps.logger
  }

  static of(records: Pick<RecordsAccess, 'kind'>, logger: IScopedLogger): SweepCursorStore {
    return new SweepCursorStore({
      kind: records.kind(pipelineAnalyticsRecordKinds['sweep-cursors']),
      logger,
    })
  }

  /**
   * The persisted cursors, or empty ones.
   *
   * A read that FAILS answers empty — a re-walk from the top, which is the
   * safe direction: the cursor can only ever skip rows, never select them.
   */
  async load(): Promise<OrphanAuditCursors> {
    try {
      const row = await this.kind.get(ORPHAN_AUDIT_CURSOR_KEY)
      return decodeOrphanAuditCursors(row?.data ?? null)
    } catch (err) {
      this.logger.warn('sweep cursors could not be read — the next pass starts from the top', {
        meta: { kind: this.kind.name, error: String(err) },
      })
      return decodeOrphanAuditCursors(null)
    }
  }

  /** Write the cursors. A failure is LOUD: it costs the next pass its reach. */
  async save(input: {
    readonly scopes: ReadonlyMap<string, OrphanCursor>
    readonly faceVectorCursor: number
    readonly clipIndexCursors: ReadonlyMap<string, number>
    readonly nowMs: number
  }): Promise<void> {
    try {
      await this.kind.put({
        id: ORPHAN_AUDIT_CURSOR_KEY,
        data: {
          scopes: Object.fromEntries(input.scopes),
          faceVectorCursor: input.faceVectorCursor,
          clipIndexCursors: Object.fromEntries(input.clipIndexCursors),
          updatedAtMs: input.nowMs,
        },
      })
    } catch (err) {
      this.logger.warn('sweep cursors were NOT persisted — the next pass re-walks the head', {
        meta: { kind: this.kind.name, error: String(err) },
      })
    }
  }
}
