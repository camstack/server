/**
 * DebugNoteArchiveStore — the durable corpus of what operators asked to be
 * checked (D405).
 *
 * A declared SQL-backed collection, like the events ops-log next door, and for
 * the same reason: pipeline-analytics already owns SQLite collections, and an
 * undeclared collection crash-loops the runner. MUST be declared in
 * `onInitialize` before the first write.
 *
 * Collection name: pipeline-analytics:debug-note-archive
 *
 * Two properties separate it from every other table in this addon:
 *
 *  - **It is not track-owned.** It names a track in `sourceTrackId` and that is
 *    PROVENANCE, never ownership — the whole point is that the row outlives the
 *    track, which `debug` deliberately never pinned (D353). It is classified
 *    `never-orphaned` by hand in `collection-classification.ts` so the
 *    ownership derivation cannot see the column and cascade it away.
 *  - **It is bounded by COUNT, not by age.** An age sweep would delete the
 *    corpus for being old, which is the failure this table exists to fix: a
 *    six-month-old note is the most valuable row in it, because the pattern it
 *    describes has had time to repeat. See {@link MAX_ARCHIVED_DEBUG_NOTES}.
 */

import {
  ARCHIVED_DEBUG_NOTES_DEFAULT_LIMIT,
  type ArchivedDebugNote,
  ArchivedDebugNoteSchema,
  type ArchivedDebugNoteQueryInput,
  MAX_ARCHIVED_DEBUG_NOTES,
} from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import type { EventLedgerCollection } from './event-ledger-collection.js'
import { createHash } from 'node:crypto'
import type {
  DebugNoteArchiveAppendInput,
  DebugNoteArchiveAppendResult,
  DebugNoteArchivePort,
} from '../pipeline/archive-debug-note.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per debug note RETIRED by a review — appended by
 *     `applyTrackFlags` immediately before `debug: false` clears the note off
 *     the track row (D405). Idempotent per (sourceTrackId, note): the row id is
 *     derived from the pair, so reviewing the same track twice cannot double
 *     the corpus. An empty note writes nothing."
 *   retention="NOT track retention and NOT an age clock — deleting a note for
 *     being old is the failure this table fixes. Bounded by ROW COUNT
 *     (MAX_ARCHIVED_DEBUG_NOTES, 5000, fleet-wide), oldest `archivedAt` first,
 *     trimmed on append. ~3 MB of text at the ceiling."
 */
export const DEBUG_NOTE_ARCHIVE_COLLECTION = 'pipeline-analytics:debug-note-archive'

/**
 * The row id for one `(track, note)` pair.
 *
 * Deterministic on purpose: the idempotency the operator needs is "reviewing
 * twice does not double the row", and a derived primary key gets it from the
 * database rather than from a read-modify-write that two concurrent reviews
 * could interleave through. Truncated to 32 hex characters — 128 bits over a
 * table capped at 5 000 rows.
 */
function archiveRowId(sourceTrackId: string, note: string): string {
  return createHash('sha256').update(`${sourceTrackId}${note}`).digest('hex').slice(0, 32)
}

export interface DebugNoteArchiveStoreDeps {
  readonly logger: IScopedLogger
  readonly archiveLedger: EventLedgerCollection
  readonly now?: () => number
  /** The row ceiling. Injectable so the bound's BEHAVIOUR is testable without
   *  writing five thousand rows; production never passes it. */
  readonly maxRows?: number
}

export class DebugNoteArchiveStore implements DebugNoteArchivePort {
  private readonly logger: IScopedLogger
  private readonly ledger: EventLedgerCollection
  private readonly now: () => number
  private readonly maxRows: number

  constructor(deps: DebugNoteArchiveStoreDeps) {
    this.logger = deps.logger
    this.ledger = deps.archiveLedger
    this.now = deps.now ?? ((): number => Date.now())
    this.maxRows = deps.maxRows ?? MAX_ARCHIVED_DEBUG_NOTES
  }

  /** The ceiling a store built without an override enforces. */
  static defaultMaxRows(): number {
    return MAX_ARCHIVED_DEBUG_NOTES
  }

  /**
   * Append one retired note. THROWS if the row cannot be written.
   *
   * Deliberately not best-effort, unlike the ops-log's `append`: this is the
   * only copy of something a person typed, and the caller
   * (`archiveNoteBeforeClear`) has both the text and the camera and is the
   * right place to decide what a failure costs — it logs the note verbatim and
   * lets the operator's flag write proceed. Swallowing here would hide the
   * failure from the one caller able to preserve the words.
   *
   * The TRIM is the exception and is best-effort: the row has already landed,
   * and failing the append because housekeeping could not run would make the
   * caller report a note lost that is sitting in the table.
   */
  async append(input: DebugNoteArchiveAppendInput): Promise<DebugNoteArchiveAppendResult> {
    const note = input.note.trim() === '' ? '' : input.note
    if (note === '') return { archived: false, id: null }
    const id = archiveRowId(input.sourceTrackId, note)
    // By id: `id` is the row key, not a body field any index of the kind
    // names, so `where: { id }` is refused by the engine.
    if ((await this.ledger.get(id)) !== null) return { archived: false, id }
    const row: ArchivedDebugNote = ArchivedDebugNoteSchema.parse({
      id,
      note,
      deviceId: input.deviceId,
      sourceTrackId: input.sourceTrackId,
      archivedAt: this.now(),
      trackStartedAt: input.trackStartedAt ?? null,
      trackClass: input.trackClass ?? null,
      trackLabel: input.trackLabel ?? null,
    })
    await this.ledger.insert({
      id: row.id,
      note: row.note,
      deviceId: row.deviceId,
      sourceTrackId: row.sourceTrackId,
      archivedAt: row.archivedAt,
      trackStartedAt: row.trackStartedAt,
      trackClass: row.trackClass,
      trackLabel: row.trackLabel,
    })
    await this.trim()
    return { archived: true, id: row.id }
  }

  /**
   * Hold the table at its ceiling, oldest first. Best-effort by design — see
   * {@link append}.
   *
   * NOT an age-keyed sweep and must never become one: the boundary below is
   * computed from the POSITION of the excess rows, never from a clock, so a
   * quiet fleet keeps its whole corpus for ever and a busy one drops its oldest
   * questions. Rows sharing the boundary timestamp go together; at a
   * one-per-review write rate that is a rounding error, and the alternative —
   * deleting by id, one round trip per row — is the N+1 drain this store layer
   * spent a release removing.
   */
  private async trim(): Promise<void> {
    try {
      const held = await this.ledger.count()
      const excess = held - this.maxRows
      if (excess <= 0) return
      const oldest = await this.ledger.query({
        orderBy: { field: 'archivedAt', direction: 'asc' },
        limit: excess,
      })
      const boundary = oldest.reduce<number>((acc, r) => {
        const at = r.data['archivedAt']
        return typeof at === 'number' && at > acc ? at : acc
      }, 0)
      if (boundary === 0) return
      const deleted = await this.ledger.deleteWhere({ whereBetween: { archivedAt: [0, boundary] } })
      this.logger.info('debug-note archive trimmed to its ceiling', {
        meta: { held, ceiling: this.maxRows, deleted },
      })
    } catch (err) {
      this.logger.warn('debug-note archive trim failed — the archive will keep growing', {
        meta: { ceiling: this.maxRows, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /** Archived notes, newest first, optionally scoped to one camera. */
  async list(query: ArchivedDebugNoteQueryInput): Promise<readonly ArchivedDebugNote[]> {
    const filter: Record<string, unknown> = {
      orderBy: { field: 'archivedAt', direction: 'desc' },
      limit: query.limit ?? ARCHIVED_DEBUG_NOTES_DEFAULT_LIMIT,
    }
    if (query.deviceId !== undefined) filter['where'] = { deviceId: query.deviceId }
    const rows = await this.ledger.query(filter)
    const out: ArchivedDebugNote[] = []
    for (const r of rows) {
      const parsed = ArchivedDebugNoteSchema.safeParse({ id: r.id, ...r.data })
      if (parsed.success) out.push(parsed.data)
      else this.logger.debug('debug-note archive: skipped a malformed row', { meta: { id: r.id } })
    }
    return out
  }
}
