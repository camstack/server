/**
 * The orphan audit — ownership-keyed, REPORT-FIRST, and deliberately nothing
 * like the age sweep.
 *
 * ## How to tell this apart from retention, in one line
 *
 * **It has no clock to select with.** {@link runOrphanAudit} takes no cutoff,
 * no retention days, no device window. Its only use of a timestamp is
 * {@link OrphanAuditLimits.graceMs}, which can exclusively SAVE a row — a row
 * younger than the grace window is never called an orphan, whatever its owner
 * says. Nothing here can ever delete something for being old.
 *
 * The age sweep lives in `track-retention-sweep.ts`, takes `cutoffMs`, and
 * cascades. This lives here, takes an ownership probe, and cascades nothing.
 * Different name, different log line (`analytics orphan audit` vs `analytics
 * track retention sweep`), different counters, different ops-log op
 * (`'orphan-audit'` vs `'prune'`). That separation is not cosmetic: the whole
 * point of D61 is that there is exactly ONE age-keyed sweep, and a future
 * reader must not be able to mistake this for a second one and "simplify" it.
 *
 * ## Report first, reclaim on purpose
 *
 * The default mode is {@link OrphanAuditMode} `'report'`: it counts and logs
 * what is orphaned, per collection, and touches nothing. Reclaiming is a
 * separate, opt-in mode.
 *
 * That is not caution theatre. This engine's correctness rests entirely on an
 * ownership model that is being rewritten in the same change, and a wrong
 * ownership model here is a delete loop pointed at the operator's own database
 * — this repo destroyed a live 8,686-row index in a single call this year.
 * Report mode makes the model observable BEFORE it is load-bearing: if the
 * audit reports thousands of orphans in a family the cascade should already
 * cover, the model is wrong and the number says so at zero cost.
 *
 * ## What bounds the damage when it does reclaim
 *
 * Five independent bounds, any one of which is enough to keep a bug survivable:
 *
 * 1. **Exempt owner kinds are never candidates.** `identity` / `vehicle` media
 *    is refused before any probe runs (`RETENTION_EXEMPT_OWNER_KINDS`).
 * 2. **The grace window** protects everything recent, so the write-then-index
 *    race and late enrichment can never be mistaken for an orphan.
 * 3. **A probe that throws aborts the scope**, keeping whatever it has. It
 *    never reads a failed liveness answer as "dead" — that is the exact shape
 *    of the mistake that empties a table.
 * 4. **An unresolvable row is left alone** and counted. "I do not know who owns
 *    this" is never "nobody owns this". A row whose owner keeps its OWN count
 *    (`writer-bounded` — the digest mosaic) is likewise counted and never
 *    touched: there is no table to probe, and pretending otherwise is what
 *    made 675 delivered notification images look collectable (D480).
 * 5. **A per-scope reclaim ceiling.** A runaway costs one ceiling per run, not
 *    a collection, and the ceiling shows up in the report as `stoppedBy:
 *    'reclaim-ceiling'` — visible, not silent.
 * 6. **A reclaim CONFIRMS its blob.** `deps.reclaim` is
 *    `MediaStore.deleteConfirmed`; a delete that cannot prove the blob is gone
 *    throws, and the row is KEPT. A best-effort delete converts an orphan into
 *    bytes nothing names, which is worse than the state it was cleaning up.
 *
 * ## Reach is a separate property from judgement, and it was the broken one
 *
 * For ten days this ran in `reclaim` mode and examined 96 % of NOTHING: one
 * `ORDER BY id` offset space over `pipeline-analytics:media`, a 20 000-row
 * ceiling, and a cursor in RAM in a process that respawns several times a day.
 * `track:` sorts last and held 23 594 orphaned rows / 9 714 MiB. So (D480):
 * the walk is SHARDED by the dimension it judges ({@link OrphanShard}, one
 * cursor per `ownerKind` over `idx_media_owner`), the cursor is PERSISTED by
 * the caller (`store/sweep-cursor-store.ts`), and every scope reports its
 * SIZE and whether it covered it — a short pass WARNs, because
 * `stoppedBy=row-ceiling` on its own reads as pacing.
 *
 * ## Cost
 *
 * `better-sqlite3` runs on the hub's main thread, which has been measured at
 * 70–95% with 42 s of synchronous blocks in a 120 s window. A full scan of
 * every collection is exactly the shape of a seven-second stall, so this pages
 * (`pageSize`), stops early (`maxRowsPerScope`), and RESUMES from a persisted
 * per-scope cursor on the next run instead of starting over. The caller runs it
 * on a wide interval (hours) and skips a run entirely if the previous one has
 * not finished.
 */

import type { EventOwnerType, IScopedLogger } from '@camstack/types'
import {
  FACE_MEDIA_OWNER_PREFIX,
  isRetiredMediaOwnerKind,
  isWriterBoundedOwnerKind,
  MEDIA_COLLECTION,
  OWNER_KINDS,
  type OwnerKind,
  PLATE_MEDIA_OWNER_PREFIX,
  RETIRED_OWNER_KINDS,
} from '../store/media-store.js'
import { auditableCollections, type ClassifiedCollection } from './collection-classification.js'
import { isRetentionExemptOwnerKind } from './retention-model.js'

// ── The ownership question, and its possible answers ─────────────────────

/** The entity whose existence decides a row's fate. */
export type OwnerRef =
  | { readonly kind: 'track'; readonly trackId: string }
  /**
   * An event-owned row, carrying the TABLE its id belongs to (D480).
   *
   * The table is not decoration. D474 made an event id a per-table rowid
   * alias, and on the live hub every one of the 100 051 object ids and every
   * one of the 391 984 audio ids is ALSO a motion id — so a probe that unions
   * the three tables does not occasionally answer "live" for a dead event, it
   * answers "live" for every object- and audio-owned media row in existence.
   * The probe must ask the table the ROW names.
   */
  | { readonly kind: 'event'; readonly table: EventOwnerType; readonly eventId: string }
  /**
   * A row owned by an entity this codebase has DELETED — the group entity
   * (D183 removal, 2026-09-01) and the session summary (D680, 2026-09-29). Its table is gone, so nothing can ever claim
   * the row again: it is an orphan by construction, with no probe to ask.
   * It still passes the grace window and the reclaim ceiling like any other.
   */
  | { readonly kind: 'retired-owner'; readonly ownerKind: string }
  /**
   * A row whose lifetime is a BOUND its writer enforces, with no table to
   * probe — the notification summary mosaic (D480).
   *
   * Distinct from `exempt`, which means retention-exempt enrolment (and which
   * also moves the blob onto the gallery location), and from `unresolvable`,
   * which means "the row does not say who owns it". This says the row is
   * legitimately owned by something that is not a queryable entity, and that
   * the owner keeps its own count. The audit sees it, counts it, and never
   * deletes it: a sweeper probing a table an id was never in is exactly the
   * mistake that made 675 delivered mosaics look collectable.
   */
  | { readonly kind: 'writer-bounded'; readonly ownerKind: string; readonly why: string }
  /** Retention must never touch this row, whatever the probes say. */
  | { readonly kind: 'exempt'; readonly why: string }
  /** The row does not say who owns it. Counted, never deleted. */
  | { readonly kind: 'unresolvable'; readonly why: string }

/** A row as the audit sees it — the index row, never a blob. */
export interface OrphanRow {
  /** The row's own id in its collection. A media row's is its rowid (D482);
   *  every other audited collection is still TEXT-keyed, so this stays a
   *  string and the media caller stringifies at the boundary. */
  readonly key: string
  readonly data: Record<string, unknown>
}

/**
 * The generation of a live event row — camera + its own timestamp (D694).
 * Used by the orphan audit to refuse treating another camera's leftovers as
 * owned by the next holder of a reused event id.
 */
export interface EventGeneration {
  readonly deviceId: number
  readonly timestamp: number
}

function str(data: Record<string, unknown>, field: string): string | null {
  const v = data[field]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(data: Record<string, unknown>, field: string): number | null {
  const v = data[field]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * The `(ownerKind, ownerId)` indirection, resolved.
 *
 * This is the mapping `collection-classification.ts` calls out as underivable:
 * `ownerId` is a trackId, a PREFIXED trackId, an eventId or an enrolled gallery
 * id depending entirely on `ownerKind`, and no column declaration can say that.
 */
export function resolveMediaOwner(row: OrphanRow): OwnerRef {
  const kindRaw = str(row.data, 'ownerKind')
  const ownerId = str(row.data, 'ownerId')
  if (kindRaw === null || ownerId === null) {
    return { kind: 'unresolvable', why: 'media row carries no (ownerKind, ownerId)' }
  }
  if (isRetiredMediaOwnerKind(kindRaw)) {
    return { kind: 'retired-owner', ownerKind: kindRaw }
  }
  const ownerKind = kindRaw as OwnerKind
  if (isRetentionExemptOwnerKind(ownerKind)) {
    return { kind: 'exempt', why: `ownerKind '${ownerKind}' is an enrolled gallery` }
  }
  if (isWriterBoundedOwnerKind(ownerKind)) {
    return {
      kind: 'writer-bounded',
      ownerKind,
      why: `ownerKind '${ownerKind}' is bounded by its writer — there is no table to probe`,
    }
  }
  switch (ownerKind) {
    case 'track':
      return { kind: 'track', trackId: ownerId }
    // D476 split `event` into the three event TABLES; D480 carries the table
    // through to the probe, because after D474 an event id is a per-table
    // rowid alias and the three tables' id ranges overlap completely. The
    // resolved ref names the table, `questionsFor` groups the ids by it, and
    // `liveEventIds` asks that table alone.
    case 'motion':
    case 'object':
    case 'audio':
      return { kind: 'event', table: ownerKind, eventId: ownerId }
    case 'face':
      return ownerId.startsWith(FACE_MEDIA_OWNER_PREFIX)
        ? { kind: 'track', trackId: ownerId.slice(FACE_MEDIA_OWNER_PREFIX.length) }
        : {
            kind: 'unresolvable',
            why: `face-owned media whose ownerId does not carry the '${FACE_MEDIA_OWNER_PREFIX}' prefix — the trackId cannot be recovered, so guessing is refused`,
          }
    case 'plate':
      return ownerId.startsWith(PLATE_MEDIA_OWNER_PREFIX)
        ? { kind: 'track', trackId: ownerId.slice(PLATE_MEDIA_OWNER_PREFIX.length) }
        : {
            kind: 'unresolvable',
            why: `plate-owned media whose ownerId does not carry the '${PLATE_MEDIA_OWNER_PREFIX}' prefix`,
          }
    default:
      return { kind: 'unresolvable', why: `unknown ownerKind '${kindRaw}'` }
  }
}

/**
 * A collection whose rows declare `trackId`, resolved. The `assigned` exemption
 * is derived the same way the classification is — an enrolled row is out of
 * reach regardless of what happened to the track that produced it.
 */
export function resolveDeclaredTrackOwner(row: OrphanRow, enrolmentExempt: boolean): OwnerRef {
  if (enrolmentExempt && row.data['assigned'] === true) {
    return { kind: 'exempt', why: 'assigned = enrolled' }
  }
  const trackId = str(row.data, 'trackId')
  return trackId === null
    ? { kind: 'unresolvable', why: 'row declares a trackId column but holds no value' }
    : { kind: 'track', trackId }
}

// ── Scopes ───────────────────────────────────────────────────────────────

/**
 * The SLICE of a collection one scope walks — an equality predicate, nothing
 * more expressive (D480).
 *
 * The media collection is sharded by `ownerKind` because that is the dimension
 * the sweep JUDGES: one cursor per owner kind over the existing
 * `idx_media_owner`, so a low-volume owner kind cannot be starved by a
 * high-volume one. One offset across the whole id space starved `track:` — the
 * last prefix in id order — for the entire life of the audit.
 */
export interface OrphanShard {
  readonly field: string
  readonly value: string
}

/**
 * Every media owner kind that gets its OWN shard, and therefore its own cursor.
 *
 * `OWNER_KINDS` minus the kinds no probe can ever condemn — the enrolment
 * galleries (`RETENTION_EXEMPT_OWNER_KINDS`) and the writer-bounded ones —
 * plus every `RETIRED_OWNER_KINDS` entry, whose rows are orphans by
 * construction and would otherwise be walked by nothing at all. Walking a
 * shard whose every row resolves to `exempt` buys an index scan and cannot
 * produce a reclaim; NOT walking the retired kinds is how 676 rows stayed
 * immortal.
 *
 * An owner kind absent from BOTH lists (a row written by a version that
 * declared a kind this one does not) is walked by no shard, so the caller
 * counts those rows separately and says so — see `runOrphanAuditPass`.
 */
export const MEDIA_AUDIT_SHARD_KINDS: readonly string[] = [
  ...OWNER_KINDS.filter(
    (kind) => !isRetentionExemptOwnerKind(kind) && !isWriterBoundedOwnerKind(kind),
  ),
  ...RETIRED_OWNER_KINDS,
]

export interface OrphanScope {
  /** Stable id — the cursor key and the reporting label. */
  readonly id: string
  readonly collection: string
  /** The slice this scope walks. `null` = the whole collection. */
  readonly shard: OrphanShard | null
  readonly resolve: (row: OrphanRow) => OwnerRef
  /** Field holding the row's instant, for the grace window. */
  readonly timestampField: string
  /** Field holding on-disk bytes, when the row knows (media only). */
  readonly sizeField: string | null
  readonly deviceIdField: string
}

/** Build the scope list from the DERIVED classification — never a second list. */
export function buildOrphanScopes(
  collections: readonly ClassifiedCollection[] = auditableCollections(),
): readonly OrphanScope[] {
  const scopes: OrphanScope[] = []
  for (const entry of collections) {
    if (entry.classification.kind === 'owner-indirection') {
      if (entry.collection === MEDIA_COLLECTION) {
        // ONE scope per owner kind, each with its own cursor. The scope id
        // carries the shard, so a cursor persisted by an earlier release (one
        // offset for the whole collection) is simply an unknown key and the
        // shards start from zero — never a cursor meaning one thing and being
        // read as another.
        for (const ownerKind of MEDIA_AUDIT_SHARD_KINDS) {
          scopes.push({
            id: `${entry.collection}#${ownerKind}`,
            collection: entry.collection,
            shard: { field: 'ownerKind', value: ownerKind },
            resolve: resolveMediaOwner,
            timestampField: 'timestamp',
            sizeField: 'sizeBytes',
            deviceIdField: 'deviceId',
          })
        }
        continue
      }
      // A second indirection would need its own resolver; refusing here is
      // better than scanning it with the wrong one.
      continue
    }
    if (entry.classification.kind !== 'track-owned') continue
    const enrolmentExempt = entry.classification.enrolmentExempt
    scopes.push({
      id: entry.collection,
      collection: entry.collection,
      shard: null,
      resolve: (row) => resolveDeclaredTrackOwner(row, enrolmentExempt),
      timestampField: 'timestamp',
      sizeField: null,
      deviceIdField: 'deviceId',
    })
  }
  return scopes
}

// ── The engine ───────────────────────────────────────────────────────────

/** `'report'` counts and logs. `'reclaim'` also deletes. */
export type OrphanAuditMode = 'report' | 'reclaim'

/**
 * What one reclaim actually did.
 *
 * `rows: 0` means the delete removed nothing (the row was already gone), and
 * is not counted as a reclaim. `bytes: null` means the delete could not say —
 * a failed measurement, which the engine then takes from the index row rather
 * than calling 0. A byte counter that can only ever be 0 is why a 9.6 GiB
 * backlog looked like a clean sweep for ten days.
 */
export interface OrphanReclaimOutcome {
  readonly rows: number
  readonly bytes: number | null
}

/**
 * Where a scope resumes. A NUMBER is an offset into an offset-paged scope (the
 * settings-store collections); a STRING is the records engine's opaque keyset
 * cursor for a scope its kind pages ({@link OrphanAuditDeps.pageKeyset}). A
 * keyset scope handed a number starts from the top: an offset persisted before
 * the scope moved onto records means nothing to the keyset, and the top is the
 * safe direction — a cursor can only ever skip rows, never select them.
 */
export type OrphanCursor = number | string

/** One keyset page — `nextCursor === null` is the end of the kind. */
export interface OrphanKeysetPage {
  readonly rows: readonly OrphanRow[]
  readonly nextCursor: string | null
}

export interface OrphanAuditDeps {
  /**
   * One KEYSET page of a scope whose rows live in a records kind, or `null`
   * when this collection is not keyset-paged on this node (no records): the
   * engine then pages it through {@link page}, by offset. Optional so an audit
   * of settings-store collections only needs nothing new.
   */
  readonly pageKeyset?: (
    collection: string,
    cursor: string | null,
    limit: number,
  ) => Promise<OrphanKeysetPage | null>
  /** Checked before every page: `true` ends the scope (`stoppedBy: 'stopped'`)
   *  where it stands, cursor kept. */
  readonly stop?: () => boolean
  /** One page of the scope's SHARD, ordered stably so the cursor means
   *  something. `shard === null` = the whole collection. */
  readonly page: (
    collection: string,
    shard: OrphanShard | null,
    offset: number,
    limit: number,
  ) => Promise<readonly OrphanRow[]>
  /**
   * How many rows the shard HOLDS — the denominator a coverage claim needs.
   *
   * `null` means "could not measure", and the engine reports it as `null`
   * rather than folding it into 0: a collection whose size is unknown is not
   * an empty one (D393). A pass that stops short of a size it knows WARNS,
   * which is the line whose absence made a ten-day outage read as pacing.
   */
  readonly size: (collection: string, shard: OrphanShard | null) => Promise<number | null>
  /** The SUBSET of `ids` that still have a track row. MUST throw rather than
   *  answer partially — a quiet under-report here deletes live rows. */
  readonly liveTrackIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>
  /**
   * The SUBSET of `ids` that still have a row IN `table`. Same contract.
   *
   * Per table, not a union across the three (D480): event ids are per-table
   * rowid aliases since D474 and their ranges overlap completely, so a union
   * answers "live" for every object- and audio-owned media row there is.
   */
  readonly liveEventIds: (
    table: EventOwnerType,
    ids: readonly string[],
  ) => Promise<ReadonlySet<string>>
  /**
   * The SUBSET of media row KEYS a live stationary entry still vouches for
   * (D547): a promoted object's key frame stays `track`-owned under a track
   * whose row was disposed of, so its owner probe answers "gone" while the
   * entity that keeps it is alive. Same contract: throw rather than
   * under-report. Optional — an audit built without the registry treats
   * nothing as kept, exactly as before the entry could hold media.
   */
  readonly keptMediaKeys?: (keys: readonly string[]) => Promise<ReadonlySet<string>>
  /**
   * Only ever called in `'reclaim'` mode, and it must CONFIRM the blob is gone
   * before the row is forgotten — `MediaStore.deleteConfirmed`, never
   * `deleteByKey`, whose `deleteByKeyUnchecked` swallows the unlink error and
   * drops the row anyway. That converts an orphan (a row pointing at bytes)
   * into a silent leak (bytes nothing points at), which is strictly worse than
   * the state it was cleaning up.
   *
   * THROWS when it cannot confirm. The engine keeps the row, counts it, and
   * logs — a branch that accepts work and produces nothing says so.
   *
   * `row` is the index row the engine judged: raw-delete reclaimers re-assert
   * columns from it at delete time (D694 — object-events rowid reuse).
   */
  readonly reclaim: (
    collection: string,
    key: string,
    row: OrphanRow,
  ) => Promise<OrphanReclaimOutcome>
  /**
   * The GENERATION of each live event id in `table` — camera + the event's
   * own timestamp (D694). Optional: without it the audit keeps the pre-D694
   * id-only ownership probe. With it, media whose `deviceId` disagrees with
   * the live holder is an orphan even though the id is taken (cross-camera
   * reuse leftovers). Timestamp mismatch alone is NOT used to reclaim — D476
   * migrated rows are unproven to carry the event's own timestamp.
   */
  readonly eventGenerations?: (
    table: EventOwnerType,
    ids: readonly string[],
  ) => Promise<ReadonlyMap<string, EventGeneration>>
  readonly now: () => number
  readonly logger: IScopedLogger
  /**
   * Awaited after every page, so a long pass gives the thread back.
   *
   * `better-sqlite3` is SYNCHRONOUS and runs on hub-main's only thread: the
   * `await`s in this loop resolve as microtasks and never yield the macrotask
   * queue, so a reclaim over 74,700 rows would hold the thread for the whole
   * pass and stall live frames, WebRTC and the API. Measured cost of getting
   * this wrong elsewhere in the same process on 2026-08-14: a 30-second
   * recorder stall. Optional so specs stay synchronous; production passes a
   * `setImmediate` yield.
   */
  readonly breathe?: () => Promise<void>
}

export interface OrphanAuditLimits {
  readonly mode: OrphanAuditMode
  /** A row younger than this is never an orphan. Protective only. */
  readonly graceMs: number
  readonly pageSize: number
  /** Rows examined per scope per run — the pacing bound. */
  readonly maxRowsPerScope: number
  /** Rows reclaimed per scope per run — the blast-radius bound. */
  readonly maxReclaimPerScope: number
}

/**
 * Deliberately unhurried. One hour of grace is ~24× the shortest measured
 * retention window's resolution and far under the shortest window itself
 * (1 day on 104), so it can protect the write/index race without ever
 * shadowing a real prune.
 */
export const DEFAULT_ORPHAN_LIMITS: OrphanAuditLimits = {
  mode: 'report',
  graceMs: 60 * 60 * 1000,
  pageSize: 500,
  maxRowsPerScope: 20_000,
  maxReclaimPerScope: 2_000,
}

export type OrphanScopeStop =
  | 'exhausted'
  | 'row-ceiling'
  | 'reclaim-ceiling'
  | 'probe-failed'
  | 'page-stalled'
  /** {@link OrphanAuditDeps.stop} said so (shutdown) — resumes next run. */
  | 'stopped'

export interface OrphanScopeReport {
  readonly scope: string
  readonly collection: string
  /** The shard's value (`ownerKind`), or `null` for a whole-collection scope. */
  readonly shard: string | null
  /**
   * Rows the shard HOLDS, or `null` when it could not be measured. Never 0 for
   * "unknown" — see {@link OrphanAuditDeps.size}.
   */
  readonly collectionSize: number | null
  /** Did this pass walk the shard to its end? `stoppedBy === 'exhausted'`. */
  readonly coveredWholeShard: boolean
  readonly examined: number
  readonly orphans: number
  readonly reclaimed: number
  /** Orphans whose delete refused to confirm its blob — the row was KEPT. */
  readonly reclaimFailed: number
  readonly bytesReclaimed: number
  readonly exempt: number
  /** Rows owned by a writer's own bound — counted, never probed, never
   *  deleted. See the `writer-bounded` {@link OwnerRef}. */
  readonly writerBounded: number
  readonly withinGrace: number
  readonly unresolvable: number
  /** Devices the orphans belonged to — so a per-camera line can be logged. */
  readonly deviceIds: readonly number[]
  readonly stoppedBy: OrphanScopeStop
  /** Where the next run resumes. `0` means the scope was walked to the end. */
  readonly nextCursor: OrphanCursor
}

export interface OrphanAuditReport {
  readonly mode: OrphanAuditMode
  readonly scopes: readonly OrphanScopeReport[]
  readonly totalOrphans: number
  readonly totalReclaimed: number
  /** Orphans whose delete refused to confirm — rows kept, bytes not freed. */
  readonly totalReclaimFailed: number
  readonly totalBytesReclaimed: number
  /** Scopes this pass did NOT walk to the end. Non-zero means the sweep saw
   *  part of its collection — the fact whose absence hid D480 for ten days. */
  readonly scopesNotCovered: number
  readonly durationMs: number
}

interface ScopeTally {
  examined: number
  orphans: number
  reclaimed: number
  reclaimFailed: number
  bytesReclaimed: number
  exempt: number
  writerBounded: number
  withinGrace: number
  unresolvable: number
}

/** Split a page into the ownership questions it raises. */
interface PageQuestions {
  readonly trackIds: readonly string[]
  /** Event ids grouped by the TABLE the row named — never merged. */
  readonly eventIdsByTable: ReadonlyMap<EventOwnerType, readonly string[]>
}

function questionsFor(refs: readonly OwnerRef[]): PageQuestions {
  const trackIds = new Set<string>()
  const eventIds = new Map<EventOwnerType, Set<string>>()
  for (const ref of refs) {
    if (ref.kind === 'track') trackIds.add(ref.trackId)
    else if (ref.kind === 'event') {
      const perTable = eventIds.get(ref.table) ?? new Set<string>()
      perTable.add(ref.eventId)
      eventIds.set(ref.table, perTable)
    }
  }
  return {
    trackIds: [...trackIds],
    eventIdsByTable: new Map([...eventIds].map(([table, ids]) => [table, [...ids]])),
  }
}

/**
 * Walk ONE scope. Resumes at `cursor`, returns where the next run should pick
 * up. Never throws: a probe failure ends the scope with what it has.
 */
export async function auditScope(
  scope: OrphanScope,
  deps: OrphanAuditDeps,
  limits: OrphanAuditLimits,
  cursor: OrphanCursor,
): Promise<OrphanScopeReport> {
  const tally: ScopeTally = {
    examined: 0,
    orphans: 0,
    reclaimed: 0,
    reclaimFailed: 0,
    bytesReclaimed: 0,
    exempt: 0,
    writerBounded: 0,
    withinGrace: 0,
    unresolvable: 0,
  }
  const deviceIds = new Set<number>()
  const graceFloor = deps.now() - limits.graceMs
  let offset = typeof cursor === 'number' ? Math.max(0, cursor) : 0
  let keysetCursor: string | null = typeof cursor === 'string' ? cursor : null
  let keyed = keysetCursor !== null
  let stoppedBy: OrphanScopeStop = 'exhausted'
  // How much there IS to walk, asked once per pass and BEFORE the walk, so a
  // coverage claim has a denominator. A probe that cannot answer is `null`,
  // never 0 — an unmeasurable collection is not an empty one (D393).
  let collectionSize: number | null = null
  try {
    collectionSize = await deps.size(scope.collection, scope.shard)
  } catch (err) {
    deps.logger.warn('orphan audit: could not measure the scope — coverage is unknown', {
      meta: { collection: scope.collection, shard: scope.shard?.value ?? null, error: String(err) },
    })
  }

  for (;;) {
    if (tally.examined >= limits.maxRowsPerScope) {
      stoppedBy = 'row-ceiling'
      break
    }
    if (deps.stop?.() === true) {
      stoppedBy = 'stopped'
      break
    }
    const keyedPage =
      deps.pageKeyset === undefined
        ? null
        : await deps.pageKeyset(scope.collection, keysetCursor, limits.pageSize)
    keyed = keyedPage !== null
    const rows =
      keyedPage !== null
        ? keyedPage.rows
        : await deps.page(scope.collection, scope.shard, offset, limits.pageSize)
    if (rows.length === 0) {
      // Walked to the end — the next run starts over from the top, which is
      // what makes this idempotent AND resumable.
      offset = 0
      keysetCursor = null
      break
    }

    const refs = rows.map((row) => scope.resolve(row))
    const { trackIds, eventIdsByTable } = questionsFor(refs)
    let liveTracks: ReadonlySet<string>
    // Keyed by table: a `motion` row's id and an `object` row's id of the same
    // number are different rows, and merging the answers is the leak D480
    // measured at 100% of object- and audio-owned media.
    const liveEvents = new Map<EventOwnerType, ReadonlySet<string>>()
    const eventGens = new Map<EventOwnerType, ReadonlyMap<string, EventGeneration>>()
    let keptMedia: ReadonlySet<string> = new Set<string>()
    try {
      liveTracks = trackIds.length > 0 ? await deps.liveTrackIds(trackIds) : new Set<string>()
      if (deps.keptMediaKeys !== undefined && scope.collection === MEDIA_COLLECTION) {
        keptMedia = await deps.keptMediaKeys(rows.map((row) => row.key))
      }
      for (const [table, ids] of eventIdsByTable) {
        if (ids.length === 0) continue
        liveEvents.set(table, await deps.liveEventIds(table, ids))
        if (deps.eventGenerations !== undefined && scope.collection === MEDIA_COLLECTION) {
          eventGens.set(table, await deps.eventGenerations(table, ids))
        }
      }
    } catch (err) {
      // The one thing this must never do is read a failed answer as "dead".
      deps.logger.warn('orphan audit: liveness probe failed — scope abandoned for this run', {
        meta: { collection: scope.collection, offset, error: String(err) },
      })
      stoppedBy = 'probe-failed'
      break
    }

    let reclaimedInPage = 0
    let ceilingHit = false
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      const ref = refs[i]!
      tally.examined += 1

      if (ref.kind === 'exempt') {
        tally.exempt += 1
        continue
      }
      if (ref.kind === 'writer-bounded') {
        // Its owner keeps its own count. Nothing here is entitled to an
        // opinion about it — and pretending to have one is the mistake.
        tally.writerBounded += 1
        continue
      }
      if (ref.kind === 'unresolvable') {
        tally.unresolvable += 1
        continue
      }
      // A retired owner has no probe: its table is gone, so `false` is not a
      // failed read being mistaken for "dead" — it is the only answer there is.
      let live =
        ref.kind === 'track'
          ? liveTracks.has(ref.trackId) || keptMedia.has(row.key)
          : ref.kind === 'event'
            ? (liveEvents.get(ref.table)?.has(ref.eventId) ?? false)
            : false
      // D694: an event id that is LIVE on another camera does not own THIS
      // media row. Only a deviceId mismatch reclaims — a timestamp mismatch
      // alone would delete live media whose stamp the D476 migration did not
      // prove to carry the event's own timestamp.
      if (live && ref.kind === 'event' && scope.collection === MEDIA_COLLECTION) {
        const gen = eventGens.get(ref.table)?.get(ref.eventId)
        const mediaDeviceId = num(row.data, scope.deviceIdField)
        if (gen !== undefined && mediaDeviceId !== null && mediaDeviceId !== gen.deviceId) {
          live = false
        }
      }
      if (live) continue

      // The owner is gone. The grace window is the last thing between this row
      // and deletion, and it only ever saves.
      const ts = num(row.data, scope.timestampField)
      if (ts !== null && ts > graceFloor) {
        tally.withinGrace += 1
        continue
      }

      tally.orphans += 1
      const deviceId = num(row.data, scope.deviceIdField)
      if (deviceId !== null) deviceIds.add(deviceId)

      if (limits.mode !== 'reclaim') continue
      if (tally.reclaimed >= limits.maxReclaimPerScope) {
        ceilingHit = true
        break
      }
      try {
        const outcome = await deps.reclaim(scope.collection, row.key, row)
        if (outcome.rows === 0) {
          // The delete found nothing to delete. Not a reclaim, and not a
          // failure either — but it must not be counted as either one.
          continue
        }
        tally.reclaimed += 1
        reclaimedInPage += 1
        // The DELETE's own answer first; the index row's `sizeBytes` only when
        // the delete could not say. A byte count taken from the row while the
        // delete silently kept the blob is the dishonest number D480 named.
        const bytes =
          outcome.bytes ?? (scope.sizeField === null ? null : num(row.data, scope.sizeField))
        if (bytes !== null) tally.bytesReclaimed += bytes
      } catch (err) {
        // The row is KEPT — an orphan that could not be deleted stays an
        // orphan, visible to the next pass, rather than becoming a blob
        // nothing points at. WARN, not debug: this is work accepted and not
        // done, and the ten-day outage was silent at exactly this level.
        tally.reclaimFailed += 1
        deps.logger.warn(
          'orphan audit: reclaim failed — row KEPT (its blob could not be confirmed gone)',
          {
            ...(deviceId !== null ? { tags: { deviceId } } : {}),
            meta: {
              collection: scope.collection,
              shard: scope.shard?.value ?? null,
              key: row.key,
              error: String(err),
            },
          },
        )
      }
    }

    if (deps.breathe) await deps.breathe()

    if (ceilingHit) {
      stoppedBy = 'reclaim-ceiling'
      // Resume here next run rather than rescanning what was already judged.
      // A keyset scope resumes at THIS page's start: the rows past the ceiling
      // were not judged, and what this page reclaimed is gone from it.
      if (!keyed) offset += rows.length - reclaimedInPage
      break
    }

    if (keyedPage !== null) {
      // A keyset names the last row read: a reclaim behind it shifts nothing.
      if (keyedPage.nextCursor === null) {
        keysetCursor = null
        break
      }
      keysetCursor = keyedPage.nextCursor
      continue
    }

    // Advance past everything this page did NOT remove. Rows that were
    // reclaimed are gone from the result set, so they must not be skipped
    // again — this is the same arithmetic that keeps the track drain loop from
    // wedging on a row it will not delete.
    const advanced = rows.length - reclaimedInPage
    if (advanced === 0 && rows.length < limits.pageSize) {
      // Whole final page removed; nothing left behind it.
      offset = 0
      break
    }
    offset += advanced
  }

  const coveredWholeShard = stoppedBy === 'exhausted'

  // ── The two lines whose absence made a ten-day outage read as pacing ──
  //
  // `stoppedBy=row-ceiling nextCursor=20000` against a 532 384-row collection
  // is not pacing, it is a sweep of the head. It only reads as pacing because
  // nothing anywhere said how big the collection was.
  if (!coveredWholeShard && collectionSize !== null && tally.examined < collectionSize) {
    deps.logger.warn('orphan audit: pass did not cover its scope — the rest has NOT been judged', {
      meta: {
        collection: scope.collection,
        shard: scope.shard?.value ?? null,
        examined: tally.examined,
        collectionSize,
        coveragePercent: Math.round((tally.examined / collectionSize) * 1000) / 10,
        stoppedBy,
        nextCursor: keyed ? (keysetCursor ?? 0) : offset,
      },
    })
  }
  // A reclaim-mode pass that FOUND orphans and freed no bytes is not a success.
  // This is the D304 argument one level down: that record fixed the mode while
  // the ceiling kept the effect, and `bytesReclaimed=0` was logged at INFO for
  // ten days against a 9.6 GiB backlog. A scope with NO size field frees 0
  // bytes by construction, so for it the signal is "reclaimed nothing" — the
  // WARN used to fire on every successful plates/object-events pass, beside a
  // `reclaimed` that contradicted it (D695 T7 review L1).
  const freedNothing = scope.sizeField === null ? tally.reclaimed === 0 : tally.bytesReclaimed === 0
  if (limits.mode === 'reclaim' && tally.orphans > 0 && freedNothing) {
    deps.logger.warn('orphan audit: reclaim pass freed no bytes against a standing backlog', {
      meta: {
        collection: scope.collection,
        shard: scope.shard?.value ?? null,
        orphans: tally.orphans,
        reclaimed: tally.reclaimed,
        reclaimFailed: tally.reclaimFailed,
      },
    })
  }

  return {
    scope: scope.id,
    collection: scope.collection,
    shard: scope.shard?.value ?? null,
    collectionSize,
    coveredWholeShard,
    examined: tally.examined,
    orphans: tally.orphans,
    reclaimed: tally.reclaimed,
    reclaimFailed: tally.reclaimFailed,
    bytesReclaimed: tally.bytesReclaimed,
    exempt: tally.exempt,
    writerBounded: tally.writerBounded,
    withinGrace: tally.withinGrace,
    unresolvable: tally.unresolvable,
    deviceIds: [...deviceIds],
    stoppedBy,
    nextCursor: keyed ? (keysetCursor ?? 0) : offset,
  }
}

/**
 * Run every scope, resuming each from its persisted cursor. Returns the report
 * AND the cursors the caller should persist for the next run.
 */
export async function runOrphanAudit(input: {
  readonly scopes: readonly OrphanScope[]
  readonly deps: OrphanAuditDeps
  readonly limits: OrphanAuditLimits
  readonly cursors: ReadonlyMap<string, OrphanCursor>
}): Promise<{ report: OrphanAuditReport; cursors: ReadonlyMap<string, OrphanCursor> }> {
  const started = input.deps.now()
  const reports: OrphanScopeReport[] = []
  const next = new Map<string, OrphanCursor>()
  for (const scope of input.scopes) {
    const report = await auditScope(
      scope,
      input.deps,
      input.limits,
      input.cursors.get(scope.id) ?? 0,
    )
    reports.push(report)
    next.set(scope.id, report.nextCursor)
  }
  const report: OrphanAuditReport = {
    mode: input.limits.mode,
    scopes: reports,
    totalOrphans: reports.reduce((a, r) => a + r.orphans, 0),
    totalReclaimed: reports.reduce((a, r) => a + r.reclaimed, 0),
    totalReclaimFailed: reports.reduce((a, r) => a + r.reclaimFailed, 0),
    scopesNotCovered: reports.filter((r) => !r.coveredWholeShard).length,
    totalBytesReclaimed: reports.reduce((a, r) => a + r.bytesReclaimed, 0),
    durationMs: Math.max(0, input.deps.now() - started),
  }
  return { report, cursors: next }
}
