/**
 * The index of PROMOTED tracking-tape windows (D681). Segments are files with
 * no rows; a promotion is a row, because the operator reviews it, releases it
 * and deletes it, and the viewer-less admin lanes need its track list.
 *
 * The row is also the INTENT LOG for its pins (`pinsSettled`). The row and
 * the `benchPinned` flags live in different tables, so no write makes them
 * atomic; instead a row is written unsettled BEFORE its pins are touched and
 * marked settled only once every pin (or, after a release, every unpin) it
 * implies has landed. `reconcileTapePins` (tape-promotion.ts) finishes any
 * unsettled row, so a promotion or release that stopped part-way — a throw, a
 * short `setBenchPinned`, a crash — is completed, never left as pins without
 * an index or an index without pins.
 */
import type { IScopedLogger } from '@camstack/types'
import type { EventLedgerCollection } from './event-ledger-collection.js'
import { z } from 'zod'
import { TapeLightingSchema } from '../tracking-bench/tape-schema.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per PROMOTED tracking-tape window (`debug.tape.promote`);
 *     updated when the operator marks it reviewed or releases its pins;
 *     deleted together with its file by `debug.tape.delete`."
 *   retention="NOT an age clock and NOT track retention — a promoted window is
 *     history being labelled (D681). Bounded by the promotion budget
 *     (MAX_PROMOTED_TAPES = 60, 1 GiB): a promotion beyond it is REFUSED,
 *     never satisfied by evicting another row."
 */
export const TRACKING_TAPES_COLLECTION = 'pipeline-analytics:tracking-tapes'

const TrackingTapeRowSchema = z.object({
  id: z.string(),
  deviceId: z.number().int(),
  scenario: z.string(),
  note: z.string().nullable(),
  lighting: TapeLightingSchema,
  fromMs: z.number().int(),
  toMs: z.number().int(),
  state: z.enum(['complete', 'incomplete']),
  frames: z.number().int(),
  skips: z.number().int(),
  gaps: z.number().int(),
  bytes: z.number().int(),
  reviewed: z.boolean(),
  trackIds: z.array(z.string()),
  createdAt: z.number().int(),
  releasedAt: z.number().int().nullable(),
  pinsSettled: z.boolean(),
})
export type TrackingTapeRow = z.infer<typeof TrackingTapeRowSchema>

const TrackIdsSchema = z.array(z.string())

/**
 * True when the SQLite settings backend would hand `text` back DECODED: it
 * parses any TEXT that starts with `[` or `{` and is valid JSON
 * (`decodeColumnValue` decodes by content, not by declared type). Free text
 * like that cannot round-trip through a TEXT column (follow-up 102, review M2).
 */
export function decodesAsJson(text: string): boolean {
  if (!(text.startsWith('[') || text.startsWith('{'))) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Free text (`scenario`, `note`) as the column hands it back: a value the
 * backend decoded is re-encoded, so a row written before `debug.tape.promote`
 * refused such text never vanishes (its whitespace may differ). Anything else
 * goes to the schema as it came.
 */
function freeText(raw: unknown): unknown {
  return raw !== null && typeof raw === 'object' ? JSON.stringify(raw) : raw
}

/**
 * `trackIds` as the column hands it back. The SQLite backend decodes a TEXT
 * that starts with `[` on read (`decodeColumnValue`), so the store sees the
 * ARRAY it wrote; a string is parsed here only for a backend (or an old row)
 * that hands the text back as written. `JSON.parse(String(array))` threw on the
 * decoded array and every promoted row was skipped as malformed (follow-up 102).
 * `null` = unreadable, absent included (the column is NOT NULL, so absence is
 * corruption) — the row is reported, never repaired.
 */
function decodeTrackIds(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export interface TrackingTapeIndexStoreDeps {
  readonly logger: IScopedLogger
  readonly tapeLedger: EventLedgerCollection
}

export class TrackingTapeIndexStore {
  private readonly logger: IScopedLogger
  private readonly ledger: EventLedgerCollection

  constructor(deps: TrackingTapeIndexStoreDeps) {
    this.logger = deps.logger
    this.ledger = deps.tapeLedger
  }

  async insert(row: TrackingTapeRow): Promise<void> {
    const { id, trackIds, ...rest } = TrackingTapeRowSchema.parse(row)
    await this.ledger.insert({ id, ...rest, trackIds: JSON.stringify(trackIds) })
  }

  async get(id: string): Promise<TrackingTapeRow | null> {
    // By id: `id` is the row key, not a body field any index of the kind
    // names, so `where: { id }` is refused by the engine.
    const row = await this.ledger.get(id)
    return row === null ? null : this.parse(row.id, row.data)
  }

  async list(deviceId?: number): Promise<readonly TrackingTapeRow[]> {
    const rows = await this.ledger.query({
      ...(deviceId !== undefined ? { where: { deviceId } } : {}),
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 1_000,
    })
    const out: TrackingTapeRow[] = []
    for (const r of rows) {
      const parsed = this.parse(r.id, r.data)
      if (parsed !== null) out.push(parsed)
    }
    return out
  }

  async setReviewed(id: string, reviewed: boolean): Promise<void> {
    await this.ledger.update(id, { reviewed })
  }

  /** Release AND unsettle in one row write: the unpins the release implies
   *  are owed from this moment, whether or not the caller lives to make them. */
  async setReleased(id: string, atMs: number): Promise<void> {
    await this.ledger.update(id, { releasedAt: atMs, pinsSettled: false })
  }

  async setPinsSettled(id: string, settled: boolean): Promise<void> {
    await this.ledger.update(id, { pinsSettled: settled })
  }

  async remove(id: string): Promise<void> {
    await this.ledger.deleteKey(id)
  }

  private parse(id: string, data: Record<string, unknown>): TrackingTapeRow | null {
    const ids = TrackIdsSchema.safeParse(decodeTrackIds(data['trackIds']))
    const parsed = TrackingTapeRowSchema.safeParse({
      id,
      ...data,
      scenario: freeText(data['scenario']),
      note: freeText(data['note'] ?? null),
      releasedAt: data['releasedAt'] ?? null,
      trackIds: ids.success ? ids.data : null,
    })
    if (parsed.success) return parsed.data
    // Why (D391): which fields failed, and what the trackIds column handed
    // back — the original bug was an ARRAY where text was expected, and this
    // line could not say so.
    this.logger.warn('tracking tape index: skipped a malformed row', {
      meta: {
        id,
        issues: parsed.error.issues.map((i) => i.path.join('.')),
        trackIdsType: typeof data['trackIds'],
      },
      ...(typeof data['deviceId'] === 'number' ? { tags: { deviceId: data['deviceId'] } } : {}),
    })
    return null
  }
}
