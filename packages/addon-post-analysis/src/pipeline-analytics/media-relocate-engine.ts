/**
 * Event-media relocation engine (entity-routing spec, Phase 4) — the
 * analytics sibling of the recorder's footage mover. Each addon moves ONLY
 * what it owns (addons never touch each other's files).
 *
 * Per row: read blob from its CURRENT location → write to the target →
 * stamp `row.locationId` → delete the old blob. The row update lands between
 * the two blob operations, so a crash leaves the row pointing at a location
 * that still holds valid bytes (the old blob is only deleted after the row
 * points away from it). Rows already at the target are skipped — a re-run
 * RESUMES.
 *
 * Paging: timestamp-cursor over the media collection, with a seen-id set
 * bridging equal-timestamp boundaries. The PASS pages because it must visit
 * every row to act on it; that is not true of every question asked about this
 * collection, and `countUnstamped` no longer pages — see its docblock, and the
 * 60 s timeout that shape cost.
 *
 * (This header used to claim `WHERE locationId IS NULL` was inexpressible
 * through the store's filter. It was expressible, and that was the problem:
 * `where: { locationId: null }` compiled to `= NULL`, which matches nothing
 * and reports it as `0`. The filter layer now compiles it to `IS NULL`.)
 *
 * ── Three passes, one engine (see `MediaRelocateModeSchema`) ──────────────
 *
 * `move` is the historical pass. `seal` and `gallery` are the SAME walk with a
 * different row predicate and a different per-row action, deliberately not a
 * second mover: the walk, the cursor, the tie-bridging and the failure
 * accounting are the hard parts and they are already right here.
 *
 *   - `seal` exists because a row with `locationId: NULL` means "wherever
 *     `eventMedia` points NOW" (`media-store.ts:396`). A repoint moves that
 *     pointer and every NULL row starts reading from the new disk while its
 *     bytes are on the old one. `seal` is a ROW-ONLY pass — no blob is read,
 *     written or deleted — that nails those rows to the location they are
 *     actually on before anything repoints.
 *   - `gallery` is the inverse selection of `move`: only the retention-exempt
 *     enrolled-gallery rows, which `move` skips on purpose (D197).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  IScopedLogger,
  MediaRelocateMode,
  RelocatableMediaCount,
  RelocatableMediaCountInput,
  RelocateJob,
  RelocateMediaInput,
  SettingsStoreClient,
  UnstampedEventMediaCount,
  UnstampedRows,
} from '@camstack/types'
import type { MediaBlobStorage } from './location-aware-media-storage.js'
import { isRetentionExemptOwnerKind } from './retention/retention-model.js'
import { rowIsDurableRetrainCopy } from './retrain/retrain-frame-store.js'
import type { EventLedgerCollection } from './store/event-ledger-collection.js'
import { isMediaOwnerKind, MEDIA_COLLECTION, mediaRowLocation } from './store/media-store.js'

const PAGE_SIZE = 200
const DEFAULT_THROTTLE_MBPS = 40

export interface MediaRelocateDeps {
  /** The media index (`pipeline-analytics:media`) — a settings-store table. */
  readonly store: SettingsStoreClient
  /**
   * The retrain-frame ledger — the SAME handle `RetrainFrameStore` reads
   * (`wireRetrainFrameLedger`): the `retrain-frames` records kind. The legacy
   * `pipeline-analytics:retrain-frames` table is undeclared and dropped
   * offline, so a store read of it fails forever.
   */
  readonly retrainFrameLedger: Pick<EventLedgerCollection, 'query' | 'update'>
  readonly storage: MediaBlobStorage
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly newId: () => string
  /** Validate the target id and (implicitly) warm its root resolution. */
  readonly resolveTargetRoot: (locationId: string) => Promise<string>
  readonly onFinished?: (job: RelocateJob) => void
  readonly sleep?: (ms: number) => Promise<void>
}

interface MutableJob {
  jobId: string
  state: RelocateJob['state']
  mode: MediaRelocateMode
  fromLocationId: string
  toLocationId: string
  deviceId: number | null
  filesMoved: number
  bytesMoved: number
  /**
   * The **M** of "I saw N of M" — how many rows this pass selected when it
   * started, `null` until the pre-count lands (and if the pre-count fails).
   *
   * The footage lane has had a denominator since D295 made `filesTotal` the
   * ledger census. This lane had none: `filesTotal` was hard-coded `null`, so a
   * media drain reported a count against nothing and an operator could not tell
   * a pass that moved everything from one that moved a tenth.
   */
  filesTotal: number | null
  startedAt: number
  finishedAt: number | null
  error: string | null
  cancelRequested: boolean
}

/** What a pass touches, reported on the job so an ops-log row says which of the
 *  three passes ran without anyone reading this file. */
function entitiesFor(mode: MediaRelocateMode): readonly string[] {
  if (mode === 'seal') return ['mediaRows', 'retrainFrameRows']
  if (mode === 'gallery') return ['galleryMedia']
  return ['media', 'retrainFrames']
}

function snapshot(j: MutableJob): RelocateJob {
  return {
    jobId: j.jobId,
    state: j.state,
    fromLocationId: j.fromLocationId,
    toLocationId: j.toLocationId,
    deviceId: j.deviceId,
    entities: [...entitiesFor(j.mode)],
    filesMoved: j.filesMoved,
    bytesMoved: j.bytesMoved,
    filesTotal: j.filesTotal,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
  }
}

/**
 * The column both walked collections use for the storage location.
 *
 * Named once because it is now a QUERY PREDICATE (`where: { [it]: null }`) as
 * well as a row field. A predicate naming a column the collection cannot
 * express is refused by `count` rather than dropped, so a rename that misses
 * one site fails loudly instead of counting the whole table.
 */
const LOCATION_ID_FIELD = 'locationId'

/**
 * Unstamped rows claimed per bulk seal statement.
 *
 * Bounds two things at once: the number of bound parameters in the `IN` list,
 * and how long one `UPDATE` holds the write lock on the database every process
 * in the cluster reads configuration through. Deliberately well under SQLite's
 * variable ceiling, and small enough that a cancel lands within one statement.
 */
const SEAL_BATCH_SIZE = 500

/**
 * Rows one CENSUS may visit before it answers `null`.
 *
 * A census is the read-only question behind `storageMigration.residue` — "how
 * much would a pass still act on". It is NOT the pass: a pass walks the whole
 * collection because it has to touch every row, and pays for that walk once,
 * under an operator's explicit start.
 *
 * 20 000 rows is 100 round trips at {@link PAGE_SIZE} — ~26 ms of engine time
 * on a healthy store, and a ceiling that cannot become the cluster's queue. A
 * collection larger than this is one a WALK cannot answer questions about; the
 * honest reply is "I could not answer" (D295), and the structural fix is an
 * indexed `COUNT(*)`, which needs `locationId` sealed first and is deliberately
 * not smuggled in behind a bound.
 */
export const MEDIA_CENSUS_ROW_BUDGET = 20_000

/**
 * Wall clock one CENSUS may spend before it answers `null`.
 *
 * The row budget bounds a healthy store; this one bounds a sick store, where
 * 100 round trips at a 16 s queue depth is 27 minutes. Read through
 * `deps.now`, so it is deterministic under test and does not need a timer.
 */
export const MEDIA_CENSUS_DEADLINE_MS = 20_000

/**
 * What one census may spend, and what it has spent.
 *
 * Explicit rather than folded into the `stop` callback: `stop` means "someone
 * asked me to stop" and the budget means "I am not allowed to continue", and a
 * pass passes `null` here because a pass is allowed to walk the whole
 * collection. Two concepts, two parameters — the walk that ran unbounded for
 * a day did so because ONE `stop: () => false` stood for both.
 */
class CensusBudget {
  private rows = 0
  private readonly deadlineAt: number

  constructor(
    private readonly now: () => number,
    private readonly maxRows: number,
    maxMs: number,
  ) {
    this.deadlineAt = now() + maxMs
  }

  get rowsVisited(): number {
    return this.rows
  }

  /** Visit one row. `true` means the budget is spent and the census must stop. */
  spend(): boolean {
    this.rows += 1
    if (this.rows > this.maxRows) return true
    // Once per page rather than once per row: `now` is a dependency and a
    // census visits 20 000 rows, so asking it per row buys nothing.
    return this.rows % PAGE_SIZE === 0 && this.now() >= this.deadlineAt
  }
}

/**
 * A census in flight — what a second caller joins, and what retires it.
 *
 * `abort` is the stop signal the runaway did not have. An aborted HTTP request
 * does not reach the generator, the browser tab closing does not, and a UI
 * change does not: on 2026-08-31 roughly 500 censuses survived all three and
 * only a runner respawn cleared them.
 */
interface CensusRun {
  readonly promise: Promise<RelocatableMediaCount>
  abort(): void
}

/**
 * True when the row names NO location — the population `seal` exists for.
 *
 * Deliberately NOT `mediaRowLocation(data) === DEFAULT_MEDIA_LOCATION`: that
 * helper collapses "unstamped" and "stamped with the bare type ref" into one
 * answer, and only the first is a row whose meaning changes under a repoint.
 *
 * The in-JS twin of the `IS NULL` predicate {@link MediaRelocateEngine.countUnstamped}
 * sends. It stays because the PASS still walks rows and must decide per row;
 * the two must agree, and `unstamped-count-matches-the-pass` asserts they do.
 */
function rowIsUnstamped(data: Record<string, unknown>): boolean {
  const id = data[LOCATION_ID_FIELD]
  return !(typeof id === 'string' && id.length > 0)
}

/** True for the enrolled-gallery rows `move` skips and `gallery` selects. */
function rowIsGallery(data: Record<string, unknown>): boolean {
  const ownerKind = String(data['ownerKind'] ?? '')
  return isMediaOwnerKind(ownerKind) && isRetentionExemptOwnerKind(ownerKind)
}

/**
 * One collection to walk. `media` is the settings-store media index, paged by
 * `timestamp`; `retrainFrames` is the retrain-frame ledger (records on a hub),
 * read whole — it holds only operator-selected frames.
 */
type RelocateCollection = { readonly lane: 'media' } | { readonly lane: 'retrainFrames' }

/**
 * Which collections a pass walks.
 *
 * ONE derivation, shared by the pass and by its pre-count. Two lists would let
 * an M counted over both collections face an N moved across one — the shape
 * D295 calls "a guard nobody believes".
 */
function collectionsFor(mode: MediaRelocateMode): readonly RelocateCollection[] {
  if (mode === 'gallery') return [{ lane: 'media' }]
  return [
    { lane: 'media' },
    // Retraining copies taken before D781 still live under the eventMedia
    // root, in their own collection/path prefix. They must move and have their
    // location stamped before the default can be repointed, otherwise a
    // trained dataset silently becomes unreadable after the old root drains.
    // Copies on the durable `retrainMedia` tenant are never selected.
    { lane: 'retrainFrames' },
  ]
}

/**
 * Does this pass act on this row at all?
 *
 * A free function of `(mode, target)` rather than a method on the job, so the
 * pre-count that produces `filesTotal` and the walk that produces `filesMoved`
 * ask the SAME question. A separately-written predicate is how a denominator
 * ends up counting a different population than the numerator.
 */
function selectsRow(
  mode: MediaRelocateMode,
  toLocationId: string,
  data: Record<string, unknown>,
  isRetrain: boolean,
  fromLocationId?: string,
): boolean {
  if (
    fromLocationId !== undefined &&
    fromLocationId !== '*' &&
    mediaRowLocation(data) !== fromLocationId
  ) {
    return false
  }
  if (mode === 'seal') return rowIsUnstamped(data)
  if (mediaRowLocation(data) === toLocationId) return false
  // Retrain frames are never gallery rows — they live under the eventMedia
  // root by construction — so the gallery pass never touches that collection.
  if (mode === 'gallery') return !isRetrain && rowIsGallery(data)
  // The enrolled gallery is NOT event media and does not follow it. Its blobs
  // live on `galleryMedia` precisely so a footage move — or a footage WIPE —
  // cannot reach them (D197); dragging them onto the new eventMedia target
  // would undo that in one pass. The same holds for a retrain copy already on
  // its durable tenant (D781); only a pre-D781 copy still on eventMedia moves.
  if (isRetrain) return !rowIsDurableRetrainCopy(data)
  return !rowIsGallery(data)
}

export class MediaRelocateEngine {
  private readonly jobs = new Map<string, MutableJob>()

  /** Censuses in flight, keyed by the QUESTION — see {@link countSelectable}. */
  private readonly censuses = new Map<string, CensusRun>()

  constructor(private readonly deps: MediaRelocateDeps) {}

  /**
   * Retire every census in flight. They answer `null`, and stop reading.
   *
   * @returns how many were retired.
   */
  cancelCensuses(reason: string): number {
    const retired = this.censuses.size
    if (retired === 0) return 0
    for (const run of this.censuses.values()) run.abort()
    this.deps.logger.info('media relocate: standing censuses retired', {
      meta: { retired, reason },
    })
    return retired
  }

  list(): readonly RelocateJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(snapshot)
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || job.state !== 'running') return false
    job.cancelRequested = true
    return true
  }

  /**
   * Rows that still carry no `locationId`, per collection.
   *
   * Read-only, and the ONLY answer the migration planner's non-blocking gate
   * is allowed to trust: it is measured here, against the rows themselves,
   * rather than inferred from "a seal job reported done" — a seal that failed
   * some rows still reports a terminal state.
   *
   * ── Why this is not the walk the rest of this file uses ──────────────────
   *
   * It used to be. It paged both collections through {@link pageRows} — 200
   * rows per RPC, ordered by `timestamp`, a column that leads no index — and
   * counted `rowIsUnstamped` in JS. On the live hub that is ~6 300 round trips
   * over 1 254 576 rows, each paying its own sort, and it hit the 60 s RPC
   * deadline **every time it was called since it shipped**. The gate it exists
   * to serve could therefore never open, and 152 GB of event media could not
   * be migrated.
   *
   * The walk is right for the PASS, which must visit every row to act on it.
   * It was never right for a question the store can answer with a predicate,
   * and the predicate is now expressible: `where: { locationId: null }`
   * compiles to `IS NULL` (it used to compile to `= NULL`, which matches
   * nothing and reports it as an answer — the number the gate treats as "safe
   * to cut over"). With `idx_media_location` in place both statements read a
   * contiguous range from the head of a b-tree.
   *
   * The cheap question is asked FIRST and on its own. `present` is a single
   * seek and decides the gate; `rows` is a second statement and only decorates
   * the refusal. So a count that cannot be taken still leaves a usable answer
   * — `{ present: true, rows: null }` refuses just as hard — and `null` never
   * degrades into `0`.
   */
  async countUnstamped(): Promise<UnstampedEventMediaCount> {
    try {
      const media = await this.countUnstampedIn(MEDIA_COLLECTION)
      const retrainFrames = await this.countUnstampedRetrainFrames()
      return {
        media,
        retrainFrames,
        anyPresent: media.present || retrainFrames.present,
        total:
          media.rows === null || retrainFrames.rows === null
            ? null
            : media.rows + retrainFrames.rows,
      }
    } catch (err) {
      // The existence probe itself failed, so nothing is known about this
      // collection — not "none", which is what a swallowed error would say to
      // a gate that opens on zero.
      this.deps.logger.warn(
        'event-media seal gate: could not determine whether any row is unstamped — a migration must treat this as unknown, never as sealed',
        { meta: { error: String(err) } },
      )
      return null
    }
  }

  /**
   * One collection's unstamped population: existence, then size.
   *
   * The `limit: 1` probe is deliberately a `query` and not a `count`: a count
   * of a million matching rows still walks a million index entries, while the
   * probe stops at the first one. Absence is proved by the same seek finding
   * nothing, which is where the index earns its keep — after a seal, the range
   * is empty and the answer is one b-tree descent.
   */
  private async countUnstampedIn(collection: string): Promise<UnstampedRows> {
    const probe = await this.deps.store.query.query({
      collection,
      filter: { where: { [LOCATION_ID_FIELD]: null }, limit: 1 },
      columns: [LOCATION_ID_FIELD],
    })
    if (probe.length === 0) return { present: false, rows: 0 }
    try {
      const rows = await this.deps.store.count.query({
        collection,
        filter: { where: { [LOCATION_ID_FIELD]: null } },
      })
      return { present: true, rows }
    } catch (err) {
      // Known to be non-empty, unknown how large. That is still a refusal, and
      // saying so beats inventing a number or throwing away the fact we have.
      this.deps.logger.warn(
        'event-media seal gate: unstamped rows exist but could not be counted — reporting the population as unknown, not as empty',
        { meta: { collection, error: String(err) } },
      )
      return { present: true, rows: null }
    }
  }

  /**
   * The retrain lane's unstamped population. The ledger's records `where` is
   * equality-only (a `null` predicate is dropped, which would count the whole
   * dataset), so the rows are read and judged by {@link rowIsUnstamped} — the
   * dataset is operator-selected and small.
   */
  private async countUnstampedRetrainFrames(): Promise<UnstampedRows> {
    const rows = (await this.deps.retrainFrameLedger.query({})).filter((row) =>
      rowIsUnstamped(row.data),
    ).length
    return { present: rows > 0, rows }
  }

  /** Every row of one lane, oldest-first. */
  private rowsOf(
    collection: RelocateCollection,
  ): AsyncGenerator<{ readonly id: string; readonly data: Record<string, unknown> }> {
    return collection.lane === 'media'
      ? this.pageRows(MEDIA_COLLECTION, 'timestamp')
      : this.retrainFrameRows()
  }

  /** The retrain-frame ledger, read whole and yielded oldest copy first. */
  private async *retrainFrameRows(): AsyncGenerator<{
    readonly id: string
    readonly data: Record<string, unknown>
  }> {
    const rows = await this.deps.retrainFrameLedger.query({})
    const ordered = rows.toSorted(
      (a, b) => Number(a.data['copiedAt'] ?? 0) - Number(b.data['copiedAt'] ?? 0),
    )
    for (const row of ordered) yield row
  }

  start(input: RelocateMediaInput): string {
    for (const j of this.jobs.values()) {
      if (j.state === 'running')
        throw new Error(`a media relocation is already running (${j.jobId})`)
    }
    // A pass is about to change the very number every standing census is
    // counting, and it takes its own denominator. Retiring them here is the one
    // moment the engine KNOWS their answers are worthless — and the census that
    // is retired says "unknown", never a stale number.
    this.cancelCensuses('a relocate pass started')
    const job: MutableJob = {
      jobId: this.deps.newId(),
      state: 'running',
      mode: input.mode ?? 'move',
      fromLocationId: input.fromLocationId ?? '*',
      toLocationId: input.toLocationId,
      deviceId: null,
      filesMoved: 0,
      bytesMoved: 0,
      filesTotal: null,
      startedAt: this.deps.now(),
      finishedAt: null,
      error: null,
      cancelRequested: false,
    }
    this.jobs.set(job.jobId, job)
    void this.run(job, input.throttleMbps ?? DEFAULT_THROTTLE_MBPS)
    return job.jobId
  }

  /**
   * Page one collection oldest-first, yielding every row exactly once.
   *
   * The cursor is `(orderField, offset-within-ties)` rather than a plain
   * offset: 201 rows sharing one timestamp is a real shape here (a burst of
   * snapshots for one track), and a plain `offset` walk over a collection being
   * mutated underneath is how rows get skipped. Rows only ever gain a
   * `locationId` during a pass — never a new order key — so appending inserts
   * land after the cursor and are picked up, and nothing is missed.
   */
  private async *pageRows(
    collection: string,
    orderField: string,
  ): AsyncGenerator<{ readonly id: string; readonly data: Record<string, unknown> }> {
    let cursor = 0
    let offsetAtCursor = 0
    for (;;) {
      const rows = await this.deps.store.query.query({
        collection,
        filter: {
          whereBetween: { [orderField]: [cursor, Number.MAX_SAFE_INTEGER] },
          orderBy: { field: orderField, direction: 'asc' },
          limit: PAGE_SIZE,
          offset: offsetAtCursor,
        },
      })
      if (rows.length === 0) return
      for (const row of rows) yield row
      const last = rows[rows.length - 1]
      if (last === undefined) return
      const lastKey = Number(last.data[orderField] ?? cursor)
      if (lastKey === cursor) {
        offsetAtCursor += rows.length
      } else {
        cursor = lastKey
        offsetAtCursor = rows.filter((row) => Number(row.data[orderField]) === lastKey).length
      }
      if (rows.length < PAGE_SIZE) return
    }
  }

  /**
   * How many rows a pass would still act on against `toLocationId`.
   *
   * The media lane's **M**, and — read on its own — its residue: "how much of
   * `eventMedia` is still not on the current default". Both come from here so
   * neither can drift from what the pass actually moves.
   *
   * `null` is "the count could not be taken", never `0`. A zero here reads as
   * "there is nothing left to move", which is precisely the claim a failed read
   * must not be allowed to make (D295).
   */
  async countSelectable(input: RelocatableMediaCountInput): Promise<RelocatableMediaCount> {
    const mode = input.mode ?? 'move'
    // The KEY IS THE QUESTION. A census keyed on anything coarser answers one
    // question with another one's number — the failure D312 fixed one layer
    // down, where a dropped predicate produced a real-looking count.
    const key = `${mode}|${input.toLocationId}|${input.fromLocationId ?? '*'}`
    const running = this.censuses.get(key)
    // A joiner sees the snapshot it would have seen anyway, and nothing
    // survives settlement — this is a single flight, not a cache.
    if (running !== undefined) return running.promise

    let aborted = false
    const budget = new CensusBudget(
      this.deps.now,
      MEDIA_CENSUS_ROW_BUDGET,
      MEDIA_CENSUS_DEADLINE_MS,
    )
    const promise = this.countSelected(
      mode,
      input.toLocationId,
      () => aborted,
      budget,
      input.fromLocationId,
    ).finally(() => {
      this.censuses.delete(key)
    })
    this.censuses.set(key, {
      promise,
      abort: () => {
        aborted = true
      },
    })
    return promise
  }

  /**
   * @param stop  someone asked this walk to stop (an operator cancel, or
   *   {@link cancelCensuses}). Answers `null`.
   * @param budget what this walk is allowed to spend, or `null` for a PASS —
   *   a pass walks the whole collection because it must touch every row, and
   *   an operator started it explicitly.
   */
  private async countSelected(
    mode: MediaRelocateMode,
    toLocationId: string,
    stop: () => boolean,
    budget: CensusBudget | null,
    fromLocationId?: string,
  ): Promise<RelocatableMediaCount> {
    try {
      // A seal selects exactly `locationId IS NULL`, which the store can answer
      // with a predicate — the same one `countUnstamped` already asks, over the
      // same index. Walking the collection to produce this number meant the
      // pass read the WHOLE table once before stamping anything, on top of
      // reading it again to do the stamping.
      //
      // `move` and `gallery` keep the walk. Their predicate is not one the
      // store can express: `mediaRowLocation` folds NULL into the default
      // location before comparing (so `whereNot: { locationId: target }` has
      // the wrong meaning when the target IS the default), and "not an enrolled
      // gallery owner" needs a NOT IN over three `ownerKind` values, which the
      // filter vocabulary has no form for. Neither has a measured cost problem;
      // inventing a predicate that ALMOST matches would.
      if (mode === 'seal') {
        let sealable = 0
        for (const collection of collectionsFor(mode)) {
          if (stop()) return null
          sealable +=
            collection.lane === 'media'
              ? await this.deps.store.count.query({
                  collection: MEDIA_COLLECTION,
                  filter: { where: { [LOCATION_ID_FIELD]: null } },
                })
              : ((await this.countUnstampedRetrainFrames()).rows ?? 0)
        }
        return { rows: sealable }
      }
      let rows = 0
      for (const collection of collectionsFor(mode)) {
        const isRetrain = collection.lane === 'retrainFrames'
        for await (const row of this.rowsOf(collection)) {
          if (stop()) {
            this.deps.logger.warn(
              'media relocate: census stopped before it finished — reporting the residue as unknown, not as empty',
              { meta: { mode, toLocationId, collection: collection.lane } },
            )
            return null
          }
          // Returning here closes the generator, so the walk stops READING —
          // the budget is a stop signal, not a filter applied to rows already
          // fetched. That distinction is the whole defect: ~500 walks with no
          // stop signal survived the tab, the HTTP abort and the UI change.
          if (budget !== null && budget.spend()) {
            this.deps.logger.warn(
              'media relocate: census exceeded its budget — this collection is larger than a walk can answer',
              {
                meta: {
                  mode,
                  toLocationId,
                  collection: collection.lane,
                  rowsVisited: budget.rowsVisited,
                  rowBudget: MEDIA_CENSUS_ROW_BUDGET,
                  deadlineMs: MEDIA_CENSUS_DEADLINE_MS,
                },
              },
            )
            return null
          }
          if (selectsRow(mode, toLocationId, row.data, isRetrain, fromLocationId)) rows++
        }
      }
      return { rows }
    } catch (err) {
      this.deps.logger.warn(
        'media relocate: row count failed — this pass cannot say how much of the collection it saw',
        { meta: { mode, toLocationId, error: String(err) } },
      )
      return null
    }
  }

  private async run(job: MutableJob, throttleMbps: number): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    const bytesPerMs = (throttleMbps * 1024 * 1024) / 1000
    try {
      // Fail fast on an unknown target — before touching a single row. A seal
      // stamps this id onto rows, so an id nobody can resolve is exactly as
      // destructive there as it is in a move.
      await this.deps.resolveTargetRoot(job.toLocationId)
      let failedRows = 0
      /** Selected rows that name no blob path. Counted and reported ONCE per
       *  pass rather than per row: a row with no path names no bytes anywhere,
       *  so there is nothing a repoint can orphan — but a pass that steps over
       *  rows in silence reads as "there were none", which is how a migration
       *  gets believed. */
      let pathlessRows = 0

      // The denominator, before the first byte. One extra ROW walk (no blobs,
      // no array I/O) buys an operator "3 588 of 136 885" instead of a bare
      // count against nothing — the difference between a five-hour operation
      // that can be managed and one that can only be waited out. A walk that
      // fails leaves `filesTotal` null, which renders as "unknown", never 0.
      // `budget: null` — a PASS is allowed the whole collection. It is about to
      // walk every row anyway, an operator started it explicitly, and its stop
      // signal is that operator's cancel.
      job.filesTotal =
        (
          await this.countSelected(
            job.mode,
            job.toLocationId,
            () => job.cancelRequested,
            null,
            job.fromLocationId,
          )
        )?.rows ?? null

      // A seal moves no bytes. It never walks.
      if (job.mode === 'seal') {
        for (const collection of collectionsFor(job.mode)) {
          if (job.cancelRequested) break
          await this.sealCollection(collection, job)
        }
        job.state = job.cancelRequested ? 'cancelled' : 'done'
        return
      }

      for (const collection of collectionsFor(job.mode)) {
        if (job.cancelRequested) break
        const isRetrain = collection.lane === 'retrainFrames'
        for await (const row of this.rowsOf(collection)) {
          if (job.cancelRequested) break
          const data = row.data
          if (!selectsRow(job.mode, job.toLocationId, data, isRetrain, job.fromLocationId)) continue
          const from = mediaRowLocation(data)
          const relativePath = String(data['path'] ?? '')
          if (relativePath.length === 0) {
            pathlessRows++
            continue
          }
          try {
            if (await this.samePhysicalLocation(from, job.toLocationId)) {
              await this.stamp(collection, row.id, data, job.toLocationId)
              continue
            }
            const bytes = await this.deps.storage.read({ location: from, relativePath })
            await this.deps.storage.write({
              location: job.toLocationId,
              relativePath,
              data: bytes,
            })
            const verified = await this.deps.storage.read({
              location: job.toLocationId,
              relativePath,
            })
            if (verified.length !== bytes.length) {
              throw new Error(`relocated media size mismatch for ${relativePath}`)
            }
            await this.stamp(collection, row.id, data, job.toLocationId)
            await this.deps.storage.delete({ location: from, relativePath })
            job.filesMoved++
            job.bytesMoved += bytes.length
            await sleep(bytes.length / bytesPerMs)
          } catch (err) {
            // Keep scanning so one failure does not hide later corrupt rows,
            // but never claim a successful migration while any selected blob
            // failed its copy→row-stamp→delete sequence.
            failedRows++
            this.deps.logger.debug('media relocate row failed', {
              meta: { collection: collection.lane, key: row.id, error: String(err) },
            })
          }
        }
      }
      if (pathlessRows > 0) {
        this.deps.logger.warn('media relocate stepped over rows that name no blob path', {
          meta: { jobId: job.jobId, mode: job.mode, rows: pathlessRows },
        })
      }
      if (failedRows > 0) {
        throw new Error(`event-media ${job.mode} left ${failedRows} row(s) unmoved`)
      }
      job.state = job.cancelRequested ? 'cancelled' : 'done'
    } catch (err) {
      job.state = 'failed'
      job.error = err instanceof Error ? err.message : String(err)
      this.deps.logger.warn('media relocate job failed', {
        meta: { jobId: job.jobId, mode: job.mode, error: job.error },
      })
    } finally {
      job.finishedAt = this.deps.now()
      this.deps.onFinished?.(snapshot(job))
    }
  }

  /**
   * Stamp every unstamped row of one collection with the job's target, in
   * bounded bulk statements.
   *
   * ## What this replaced
   *
   * A per-row loop: page the whole collection through {@link pageRows}, then
   * one `store.set.mutate` per selected row — a full-row UPSERT rewriting every
   * column to change one field, one RPC each, plus a second full walk before it
   * to produce the denominator. Measured on the live hub against the 464 902
   * unstamped rows: **2.3 rows/s, falling to 0.7 rows/s under a competing
   * drain**, i.e. over two and a half days for a metadata stamp that reads no
   * file and moves no byte. It was cancelled. This is the write-side twin of
   * the read-side walk {@link countUnstamped} retired, and the fourth instance
   * of the same pattern found in one day — work looped over the door instead of
   * pushed into the statement.
   *
   * ## The shape
   *
   * Probe the indexed `IS NULL` range for a batch of ids, then ONE
   * `updateWhere` over those ids. Two round trips per {@link SEAL_BATCH_SIZE}
   * rows instead of one write per row.
   *
   * The probe carries no cursor and needs none: the predicate CONSUMES itself.
   * A stamped row leaves the range, so the next probe returns the next batch,
   * and a run that is interrupted anywhere simply resumes on what is left. That
   * is also why the seal is idempotent (a second run probes an empty range and
   * stamps nothing) and why it cannot repoint a row that already names a
   * different location — `IS NULL` never selects one.
   *
   * A single unbounded `UPDATE … WHERE locationId IS NULL` would be one
   * statement instead of ~1 860, and is not used: half a million row rewrites,
   * each maintaining four indexes, is an unbounded statement holding the write
   * lock on a database the whole cluster reads configuration through, under an
   * RPC deadline that must not be raised. Batching bounds the statement, keeps
   * `cancel` responsive between batches, and keeps `filesMoved` honest.
   *
   * ## The termination guard
   *
   * If the probe finds rows and the update reports **0**, this THROWS. That is
   * not defensive noise: it is precisely what a backend compiling
   * `locationId = NULL` does — matches nothing, reports success (D312) — and
   * against it a self-consuming loop never terminates and a non-looping one
   * reports a completed seal having stamped nothing. Zero unstamped rows is the
   * single value the migration gate reads as "safe to cut over".
   */
  private async sealCollection(lane: RelocateCollection, job: MutableJob): Promise<void> {
    if (lane.lane === 'retrainFrames') {
      // The ledger cannot express `IS NULL` on records (its `where` is
      // equality-only), so the small retrain dataset is judged row by row.
      for (const row of await this.deps.retrainFrameLedger.query({})) {
        if (job.cancelRequested) return
        if (!rowIsUnstamped(row.data)) continue
        await this.deps.retrainFrameLedger.update(row.id, {
          [LOCATION_ID_FIELD]: job.toLocationId,
        })
        job.filesMoved += 1
      }
      return
    }
    const collection = MEDIA_COLLECTION
    for (;;) {
      if (job.cancelRequested) return
      const batch = await this.deps.store.query.query({
        collection,
        filter: { where: { [LOCATION_ID_FIELD]: null }, limit: SEAL_BATCH_SIZE },
        columns: [LOCATION_ID_FIELD],
      })
      if (batch.length === 0) return
      const { updated } = await this.deps.store.updateWhere.mutate({
        collection,
        filter: { whereIn: { id: batch.map((row) => row.id) } },
        data: { [LOCATION_ID_FIELD]: job.toLocationId },
      })
      if (updated === 0) {
        throw new Error(
          `event-media seal stamped 0 of ${batch.length} unstamped row(s) in "${collection}" — the bulk predicate matched nothing, so the population cannot be sealed`,
        )
      }
      job.filesMoved += updated
    }
  }

  private async stamp(
    lane: RelocateCollection,
    key: string,
    data: Record<string, unknown>,
    locationId: string,
  ): Promise<void> {
    if (lane.lane === 'retrainFrames') {
      await this.deps.retrainFrameLedger.update(key, { [LOCATION_ID_FIELD]: locationId })
      return
    }
    await this.deps.store.set.mutate({
      collection: MEDIA_COLLECTION,
      key,
      value: { ...data, locationId },
    })
  }

  private async samePhysicalLocation(from: string, to: string): Promise<boolean> {
    if (from === to) return true
    try {
      const [fromRoot, toRoot] = await Promise.all([
        this.deps.resolveTargetRoot(from),
        this.deps.resolveTargetRoot(to),
      ])
      const [fromStat, toStat] = await Promise.all([fs.stat(fromRoot), fs.stat(toRoot)])
      if (fromStat.dev === toStat.dev && fromStat.ino === toStat.ino) return true
      const [fromReal, toReal] = await Promise.all([
        fs.realpath(path.resolve(fromRoot)),
        fs.realpath(path.resolve(toRoot)),
      ])
      return fromReal === toReal
    } catch {
      return false
    }
  }
}
