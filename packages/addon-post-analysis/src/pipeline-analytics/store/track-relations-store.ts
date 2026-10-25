/**
 * Ground-truth marks for the tracking bench (D681, spec §4.2). Two reference
 * tables: rows NAME tracks as provenance and outlive them — the columns are
 * deliberately not `trackId`, so the retention cascade cannot reach them —
 * and each table is held at a COUNT ceiling, oldest `updatedAt` first, never
 * by age (the D405 argument).
 */
import { createHash } from 'node:crypto'
import {
  MAX_TRACK_PURITIES,
  MAX_TRACK_RELATIONS,
  type TrackPurity,
  TrackPuritySchema,
  type TrackRelation,
  TrackRelationSchema,
} from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import type { EventLedgerCollection } from './event-ledger-collection.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per unordered pair of tracks the operator related
 *     (`setTrackRelation` / `debug.gt.setRelation`); re-marking the pair
 *     replaces the row; `clearTrackRelation` deletes it."
 *   retention="NOT track retention and NOT an age clock — ground truth is kept
 *     after its tracks are gone (D681). Bounded by ROW COUNT
 *     (MAX_TRACK_RELATIONS, 20 000), oldest `updatedAt` first, trimmed on write."
 */
export const TRACK_RELATIONS_COLLECTION = 'pipeline-analytics:track-relations'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per track the operator called `mixed` or `not-a-subject`
 *     (`setTrackPurity` / `debug.gt.setPurity`); `pure` deletes it."
 *   retention="NOT track retention and NOT an age clock (D681). Bounded by ROW
 *     COUNT (MAX_TRACK_PURITIES, 5 000), oldest `updatedAt` first."
 */
export const TRACK_PURITY_COLLECTION = 'pipeline-analytics:track-purity'

/** One id per UNORDERED pair, so re-marking replaces. 128 bits. */
export function relationRowId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return createHash('sha256').update(`${lo}\u0000${hi}`).digest('hex').slice(0, 32)
}

export interface TrackRelationsStoreDeps {
  readonly logger: IScopedLogger
  readonly relationsLedger: EventLedgerCollection
  readonly purityLedger: EventLedgerCollection
  /** Injectable so the ceiling's behaviour is testable; production never passes it. */
  readonly maxRelations?: number
  readonly maxPurities?: number
}

/** A Zod `safeParse` result, narrowed to what the row readers use. */
interface ParsedRow<T> {
  readonly success: true
  readonly data: T
}

interface UnparsedRow {
  readonly success: false
}

type SafeRowParser<T> = (raw: unknown) => ParsedRow<T> | UnparsedRow

export class TrackRelationsStore {
  private readonly logger: IScopedLogger
  private readonly relationsLedger: EventLedgerCollection
  private readonly purityLedger: EventLedgerCollection
  private readonly maxRelations: number
  private readonly maxPurities: number

  constructor(deps: TrackRelationsStoreDeps) {
    this.logger = deps.logger
    this.relationsLedger = deps.relationsLedger
    this.purityLedger = deps.purityLedger
    this.maxRelations = deps.maxRelations ?? MAX_TRACK_RELATIONS
    this.maxPurities = deps.maxPurities ?? MAX_TRACK_PURITIES
  }

  private ledgerFor(collection: string): EventLedgerCollection {
    return collection === TRACK_PURITY_COLLECTION ? this.purityLedger : this.relationsLedger
  }

  async getRelation(id: string): Promise<TrackRelation | null> {
    return this.getOne(TRACK_RELATIONS_COLLECTION, id, (raw) => TrackRelationSchema.safeParse(raw))
  }

  async putRelation(row: TrackRelation): Promise<void> {
    const { id, ...data } = TrackRelationSchema.parse(row)
    await this.put(TRACK_RELATIONS_COLLECTION, id, data)
    await this.trim(TRACK_RELATIONS_COLLECTION, this.maxRelations)
  }

  async deleteRelation(id: string): Promise<boolean> {
    return this.deleteOne(TRACK_RELATIONS_COLLECTION, id)
  }

  async relationsForDevice(deviceId: number, limit: number): Promise<readonly TrackRelation[]> {
    return this.listFor(TRACK_RELATIONS_COLLECTION, deviceId, limit, (raw) =>
      TrackRelationSchema.safeParse(raw),
    )
  }

  async getPurity(trackId: string): Promise<TrackPurity | null> {
    return this.getOne(TRACK_PURITY_COLLECTION, trackId, (raw) => TrackPuritySchema.safeParse(raw))
  }

  async putPurity(row: TrackPurity): Promise<void> {
    const { id, ...data } = TrackPuritySchema.parse(row)
    await this.put(TRACK_PURITY_COLLECTION, id, data)
    await this.trim(TRACK_PURITY_COLLECTION, this.maxPurities)
  }

  async deletePurity(trackId: string): Promise<boolean> {
    return this.deleteOne(TRACK_PURITY_COLLECTION, trackId)
  }

  async puritiesForDevice(deviceId: number, limit: number): Promise<readonly TrackPurity[]> {
    return this.listFor(TRACK_PURITY_COLLECTION, deviceId, limit, (raw) =>
      TrackPuritySchema.safeParse(raw),
    )
  }

  private async getOne<T>(
    collection: string,
    id: string,
    parse: SafeRowParser<T>,
  ): Promise<T | null> {
    // By id: `id` is the row key, not a body field any index of the kind
    // names, so `where: { id }` is refused by the engine.
    const row = await this.ledgerFor(collection).get(id)
    if (row === null) return null
    const parsed = parse({ id: row.id, ...row.data })
    return parsed.success ? parsed.data : null
  }

  /**
   * Write the WHOLE row. An upsert, never a patch of an existing row: a patch
   * is an RFC 7396 merge, where a `null` (`presence: null`) DELETES the field,
   * and the row then fails its schema and drops out of every read.
   */
  private async put(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    await this.ledgerFor(collection).upsertRow(id, data)
  }

  private async deleteOne(collection: string, id: string): Promise<boolean> {
    // By id: `id` is the row key, not a body field any index of the kind
    // names, so `where: { id }` is refused by the engine.
    const deleted = await this.ledgerFor(collection).deleteByIds([id])
    return deleted > 0
  }

  private async listFor<T extends { readonly id: string; readonly updatedAt: number }>(
    collection: string,
    deviceId: number,
    limit: number,
    parse: SafeRowParser<T>,
  ): Promise<readonly T[]> {
    const rows = await this.ledgerFor(collection).query({
      where: { deviceId },
      orderBy: { field: 'updatedAt', direction: 'desc' },
      limit,
    })
    const out: T[] = []
    for (const r of rows) {
      const parsed = parse({ id: r.id, ...r.data })
      if (parsed.success) out.push(parsed.data)
      else
        this.logger.debug('track relations: skipped a malformed row', {
          tags: { deviceId },
          meta: { collection, id: r.id },
        })
    }
    // The store's `orderBy` names only `updatedAt`: two rows written in the
    // same millisecond come back in whatever order the engine happens to
    // pick, and a bundle built from them is not reproducible byte-for-byte
    // (L3, tracking-bench export). `id` breaks the tie deterministically.
    return out.toSorted(
      (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
  }

  /** Same boundary rule as the debug-note archive: by POSITION of the excess
   *  rows, never by a clock. Best-effort — the row has already landed. */
  private async trim(collection: string, max: number): Promise<void> {
    try {
      const ledger = this.ledgerFor(collection)
      const held = await ledger.count()
      const excess = held - max
      if (excess <= 0) return
      const oldest = await ledger.query({
        orderBy: { field: 'updatedAt', direction: 'asc' },
        limit: excess,
      })
      const boundary = oldest.reduce<number>((acc, r) => {
        const at = r.data['updatedAt']
        return typeof at === 'number' && at > acc ? at : acc
      }, 0)
      if (boundary === 0) return
      const deleted = await ledger.deleteWhere({ whereBetween: { updatedAt: [0, boundary] } })
      this.logger.info('track relations trimmed to their ceiling', {
        meta: { collection, held, ceiling: max, deleted },
      })
    } catch (err) {
      this.logger.warn('track relations trim failed — the table will keep growing', {
        meta: { collection, ceiling: max, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
