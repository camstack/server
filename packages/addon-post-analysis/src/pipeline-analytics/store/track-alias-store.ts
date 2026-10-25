/**
 * The alias collection behind an L2 fusion (D683 §6.1 invariant 5): an
 * absorbed provisional id resolves to its survivor FOREVER, so a late writer
 * that only ever heard of the absorbed id still lands under the right track,
 * and the retention cascade reaches rows a late writer left under it (review
 * H4 — the 38 s case that reopened a closed id and overwrote its persisted
 * row).
 */
import type { EventLedgerCollection } from './event-ledger-collection.js'
import type { TrackCascadeLeafCount } from '../pipeline/delete-track-cascade.js'
import type {
  TrackFusionLeafCount,
  TrackFusionRequest,
  TrackLeafStore,
} from '../pipeline/track-fusion-leaf.js'

/**
 * The alias collection.
 *
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per fused piece (D683): aliasId = the absorbed provisional
 *     id, trackId = its survivor; rewritten when the survivor is itself
 *     absorbed by a later fusion"
 *   retention="TRACK-OWNED by its survivor through the declared `trackId`
 *     column: aliases leave with the survivor in the retention cascade, and
 *     widen that cascade (`expandLeafIds`) to rows still keyed by an
 *     absorbed id"
 */
export const TRACK_ALIASES_COLLECTION = 'pipeline-analytics:track-aliases'

export const TRACK_ALIAS_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'trackId', type: 'TEXT' as const, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'timestamp', type: 'INTEGER' as const, notNull: true },
] as const

/** RAM view of recent fusions: bounded to one hour, so a busy camera cannot grow it. */
export const RECENT_ALIAS_TTL_MS = 3_600_000
/** Ids known NOT to be aliases (review 2 L5), oldest evicted first. */
const MISS_CACHE_SIZE = 4096
/** Round-trip page size for {@link TrackAliasStore.resolveMany} (review N4) —
 *  the same bound `TrackStore.existingTrackIds` already pages at. */
const ALIAS_RESOLVE_PAGE = 500

interface RecentAlias {
  readonly trackId: string
  readonly at: number
}

/** The stored row's data, as read back through `get.query` / `query.query`. */
function readTrackId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const trackId = Reflect.get(data, 'trackId')
  return typeof trackId === 'string' ? trackId : undefined
}

export interface TrackAliasStoreDeps {
  readonly aliasLedger: EventLedgerCollection
}

export class TrackAliasStore implements TrackLeafStore {
  private recent = new Map<string, RecentAlias>()
  private readonly misses = new Set<string>()
  private readonly ledger: EventLedgerCollection

  constructor(deps: TrackAliasStoreDeps) {
    this.ledger = deps.aliasLedger
  }

  async record(deviceId: number, aliasId: string, trackId: string, fusedAt: number): Promise<void> {
    this.misses.delete(aliasId)
    await this.ledger.upsertRow(aliasId, { id: aliasId, trackId, deviceId, timestamp: fusedAt })
    this.recent = new Map(
      [...this.recent]
        .filter(([, r]) => fusedAt - r.at < RECENT_ALIAS_TTL_MS)
        .map(([a, r]): [string, RecentAlias] => [
          a,
          r.trackId === aliasId ? { trackId, at: r.at } : r,
        ]),
    )
    this.recent.set(aliasId, { trackId, at: fusedAt })
  }

  /** In-RAM only — for a hot caller that cannot await (D49-style mirror). */
  resolveSync(id: string): string | undefined {
    return this.recent.get(id)?.trackId
  }

  async resolve(id: string): Promise<string | null> {
    const hot = this.recent.get(id)
    if (hot !== undefined) return hot.trackId
    // Review 2 L5: every trackId-taking cap call resolves, and almost every id
    // is NOT an alias — remember the misses (bounded, cleared by `record`) so
    // an ordinary read does not pay a store `get` each time.
    if (this.misses.has(id)) return null
    const row = await this.ledger.get(id)
    const trackId = row === null ? undefined : readTrackId(row.data)
    if (trackId !== undefined) return trackId
    this.misses.add(id)
    if (this.misses.size > MISS_CACHE_SIZE) {
      const oldest = this.misses.values().next()
      if (!oldest.done) this.misses.delete(oldest.value)
    }
    return null
  }

  /**
   * Every id in `ids` that IS an alias, resolved to its survivor — paged at
   * {@link ALIAS_RESOLVE_PAGE} ids per round trip, never one per id (D683
   * review N4).
   *
   * Deliberately bypasses `resolve()`'s own `recent`/`misses` caching: the
   * orphan audit calls this with potentially thousands of candidate ids in
   * one pass, and `Promise.all(ids.map(resolve))` turned that fan-out into
   * one store round trip PER id that missed both caches — exactly the shape
   * `existingTrackIds` already avoids for the SAME audit's track-liveness
   * half. `id` is this collection's primary key, so the batched `whereIn`
   * is already indexed.
   */
  async resolveMany(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>()
    for (let i = 0; i < ids.length; i += ALIAS_RESOLVE_PAGE) {
      const chunk = ids.slice(i, i + ALIAS_RESOLVE_PAGE)
      if (chunk.length === 0) continue
      const rows = await this.ledger.query({ whereIn: { id: [...chunk] }, limit: chunk.length })
      for (const row of rows) {
        const trackId = readTrackId(row.data)
        if (trackId !== undefined) out.set(row.id, trackId)
      }
    }
    return out
  }

  /** Every absorbed id whose survivor is one of `trackIds` (indexed on `trackId`). */
  async aliasesOf(trackIds: readonly string[]): Promise<readonly string[]> {
    if (trackIds.length === 0) return []
    const rows = await this.ledger.query({ whereIn: { trackId: [...trackIds] } })
    return rows.map((r) => r.id)
  }

  /**
   * The same lookup as {@link aliasesOf} — one indexed `whereIn` round trip —
   * but GROUPED by which of `trackIds` each alias belongs to (D683 review
   * N6). `runTrackCascadeBatch` widens a BATCH of otherwise-unrelated tracks
   * in one query for the whole batch; the flat `aliasesOf` union cannot tell
   * it which track each alias is for, so every track's cascade ended up
   * widened with every SIBLING's aliases too — a track whose own cascade
   * later failed had already lost a sibling's rows to an earlier track's
   * widened delete.
   */
  async aliasesOfGrouped(
    trackIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const out = new Map<string, string[]>()
    if (trackIds.length === 0) return out
    const rows = await this.ledger.query({ whereIn: { trackId: [...trackIds] } })
    for (const row of rows) {
      const survivor = readTrackId(row.data)
      if (survivor === undefined) continue
      const list = out.get(survivor)
      if (list) {
        list.push(row.id)
      } else {
        out.set(survivor, [row.id])
      }
    }
    return out
  }

  /** D683: when the survivor of a fusion is itself later absorbed, every
   *  alias that pointed at it now points at the NEW survivor — so `resolve`
   *  on the original absorbed id still reaches the current one. */
  async reassignTrack(req: TrackFusionRequest): Promise<readonly TrackFusionLeafCount[]> {
    const { updated } = await this.ledger.updateWhere(
      { where: { trackId: req.absorbedId } },
      { trackId: req.survivorId },
    )
    this.recent = new Map(
      [...this.recent].map(([a, r]): [string, RecentAlias] => [
        a,
        r.trackId === req.absorbedId ? { trackId: req.survivorId, at: r.at } : r,
      ]),
    )
    return [{ family: 'aliases', moved: updated, dropped: 0 }]
  }

  /**
   * The orphan audit's reclaim of ONE alias row: the row AND the `recent`
   * entry that would otherwise keep resolving it for up to an hour. `true`
   * only when a row was actually deleted. (`misses` needs nothing: a deleted
   * alias IS a non-alias, which is what a miss records.)
   */
  async deleteAlias(aliasId: string): Promise<boolean> {
    // By id, never `deleteWhere({ where: { id } })`: `id` is the row key, not a
    // body field any index of the kind names, and the engine refuses the filter.
    const deleted = await this.ledger.deleteByIds([aliasId])
    this.recent.delete(aliasId)
    return deleted > 0
  }

  async deleteByTracks(trackIds: readonly string[]): Promise<readonly TrackCascadeLeafCount[]> {
    const deleted = await this.ledger.deleteWhere({ whereIn: { trackId: [...trackIds] } })
    this.recent = new Map([...this.recent].filter(([, r]) => !trackIds.includes(r.trackId)))
    return [{ family: 'aliases', rows: deleted, bytes: 0 }]
  }
}
