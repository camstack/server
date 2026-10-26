/**
 * EventStore — per-kind event collections for motion / object / audio.
 *
 * Three SQL-backed collections with independent schemas, declared once
 * in onInitialize via `declareCollection` (P4). Each has typed
 * (deviceId, timestamp) indexes so the UI timeline gets sub-linear
 * queries even at high volume.
 *
 * Collection names:
 *   - pipeline-analytics:motion-events
 *   - pipeline-analytics:object-events
 *   - pipeline-analytics:audio-events
 */

import type {
  AudioEvent,
  AudioEventDraft,
  EventOwnerType,
  IScopedLogger,
  LabelTier,
  MotionEvent,
  MotionEventDraft,
  MotionTriggeredBy,
  MutationFilter,
  ObjectEvent,
  ObjectEventDraft,
  SettingsStoreClient,
} from '@camstack/types'
import { MotionTriggeredBySchema } from '@camstack/types'
import { decodeMotionEdges, encodeMotionEdges } from './motion-edge-codec.js'
import { roundBbox } from './position-codec.js'
import type { TieredLabelPatch } from '../pipeline/label-tier.js'
import type { TrackCascadeLeafCount } from '../pipeline/delete-track-cascade.js'
import type { TrackFusionLeafCount, TrackFusionRequest } from '../pipeline/track-fusion-leaf.js'
import { readTieredLabelColumns, tieredLabelColumnData } from './tiered-label-columns.js'
import { audioDbfsByBucket, audioPeakByBucket } from './audio-level-density.js'
import { ANALYTICS_AUDIO_LEVEL_KEY } from './analytics-history-keys.js'
import type { EventLedgerCollection } from './event-ledger-collection.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per motion EPISODE, keyed per (deviceId, source) so the
 *     analyzer and a firmware/device-activity sensor on the SAME camera never
 *     share one episode (D475). INSERT on a rising edge with no episode open
 *     (durationMs: null, edges: [0]); a further rising edge inside the open
 *     episode does NOT insert — it extends the in-memory episode and re-arms
 *     the MOTION_CLOSE_AFTER_MS close timer. One UPDATE at close writes the
 *     final durationMs (lastOnAt - startedAt) and the encoded edges array.
 *     Replaces the pre-D475 scheme (one row off→on, then a heartbeat row
 *     every 5 s while motion stayed on) — MOTION_EVENT_HEARTBEAT_MS is gone."
 *   retention="a TERMINAL age-keyed root — no trackId. A motion row may own a
 *     still (`ownerKind: 'motion'`, `kind: 'snapshot'`) captured on the off→on
 *     visit so events-mode recordings have a videoclip thumbnail. Deleted by
 *     EventStore.evictTracklessBefore on the DEVICE's one retention window
 *     (follow-recordings horizon, or trackRetentionDays, default 7), which
 *     folds in MediaStore.deleteForEvents so the still leaves with the row.
 *     0 days = keep forever, and this table is the reason that setting is
 *     dangerous."
 */
export const MOTION_EVENTS_COLLECTION = 'pipeline-analytics:motion-events'
/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per detected object per processed frame — every tracked
 *     detection the frame processor emits, plus the appearance events and the
 *     synthetic package-drop events. Every row carries the trackId it belongs to.
 *     A package PICK-UP row also carries observedAt, when the parcel went,
 *     beside its timestamp, when the departure was concluded (D684)."
 *   retention="TRACK-OWNED: it has no clock of its own. Rows go only when their
 *     track goes, through EventStore.deleteByTracks — which folds in the deletion
 *     of the event's child crops so a caller cannot take the events and leave the
 *     media. A row whose track is already gone is an orphan and is collected by
 *     OWNERSHIP (orphan-audit.ts), never by age."
 */
export const OBJECT_EVENTS_COLLECTION = 'pipeline-analytics:object-events'
/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per accepted audio episode: the CLASSIFICATION path writes when
 *     a confident macro-class lands (coalesced per device so one sound is not one
 *     row per 32 ms chunk), the LEVEL path when the rolling-window detector sees a
 *     deviation past levelDeviationDb. A level-path row carries no class."
 *   retention="a TERMINAL age-keyed root, exactly like motion-events: swept by
 *     EventStore.evictTracklessBefore on the DEVICE's one retention window. No
 *     track owns it, so without that clock it would be immortal."
 */
export const AUDIO_EVENTS_COLLECTION = 'pipeline-analytics:audio-events'

/**
 * The COLLECTION each event table's owner type names — the mapping the
 * per-table liveness probe needs (D480).
 *
 * Typed as a total record over `EventOwnerType`, so a fourth event table
 * cannot be added without deciding where its rows live. The alternative, a
 * `switch` with a default, is how `event` covered three tables for a year.
 */
const EVENT_COLLECTION_BY_TABLE: Readonly<Record<EventOwnerType, string>> = {
  motion: MOTION_EVENTS_COLLECTION,
  object: OBJECT_EVENTS_COLLECTION,
  audio: AUDIO_EVENTS_COLLECTION,
}

/**
 * Maximum rows fetched per loop iteration in `pruneBefore`.
 *
 * This used to be documented as "matches the default row-limit the production
 * settings-store backend applies". **No such default existed** — the cap
 * schema was `limit: z.number().optional()` and an absent `limit` produced a
 * `SELECT` with no `LIMIT` at all. The comment described the right design and
 * therefore read as verification of it, which is how an unbounded read stayed
 * in the engine long enough to OOM hub-main on 2026-08-07.
 *
 * The engine now really does bound an unbounded query
 * (`SETTINGS_QUERY_DEFAULT_ROW_CAP`, and it WARNS when it bites). This page
 * size is deliberately an order of magnitude below it, so the loop below is
 * paced by its own bound and never by the engine's backstop.
 *
 * Exported so tests can build a query-capping fake that forces the loop.
 */
const PRUNE_PAGE_SIZE = 500

export const COMMON_BASE_COLUMNS = [
  // `INTEGER` makes this a SQLite ROWID ALIAS: the table's own B-tree is the
  // key, so the primary-key index stops existing (D474). The backend omits the
  // column from the INSERT and SQLite assigns it — which is why `insert` had to
  // learn `autoPrimaryKey` AND to return the assigned id first.
  { name: 'id', type: 'INTEGER' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'timestamp', type: 'INTEGER' as const, notNull: true },
] as const

export const MOTION_COLUMNS = [
  ...COMMON_BASE_COLUMNS,
  { name: 'regionCount', type: 'INTEGER' as const, notNull: true },
  { name: 'regions', type: 'JSON' as const },
  { name: 'frameWidth', type: 'INTEGER' as const },
  { name: 'frameHeight', type: 'INTEGER' as const },
  /**
   * `null` while the episode this row represents is still open; the final
   * `lastOnAt - startedAt` once closed (D475). DECLARED, not merely stamped —
   * the sqlite backend silently drops an undeclared key on every write, which
   * is exactly how `frameId` was written into the void for years (see
   * `OBJECT_COLUMNS.frameId`). Absent on a row written before D475: that
   * means "closed the old way", never "open" — only an explicit `null` here
   * means open.
   */
  { name: 'durationMs', type: 'INTEGER' as const },
  /**
   * Encoded rising-edge offsets for the episode — see `motion-edge-codec.ts`.
   * Written once, in the same UPDATE as `durationMs`, at close; a legacy or
   * still-open row has no value here, which the codec reads as `[]`.
   */
  { name: 'edges', type: 'TEXT' as const },
  /**
   * The first trigger of an ONBOARD episode (D672), JSON `{kind:'camera'} |
   * {kind:'sensor',deviceId}`. Declared, or the backend drops it on write (see
   * `durationMs`). Additive: the collection gains the column in place. Absent on
   * a legacy / analyzer / device-activity row means NOT RECORDED.
   */
  { name: 'triggeredBy', type: 'JSON' as const },
] as const

export const OBJECT_COLUMNS = [
  ...COMMON_BASE_COLUMNS,
  // Detection source ('pipeline' | 'onboard'). Nullable: legacy rows + the
  // ML path (which may omit it) read back as 'pipeline' at the cap layer.
  { name: 'source', type: 'TEXT' as const },
  /**
   * The SCENE key — every event of one processed frame shares it
   * (`frame-processor.ts`, stamped on every emitted event).
   *
   * It was documented on the cap from the day the collection existed ("lets a
   * consumer group co-occurring detections (e.g. 2 people + 1 dog) under one
   * full frame"), stamped by the producer, and read back by `slimObject` — with
   * no column to land in. The sqlite backend drops an undeclared key WITHOUT
   * ERROR (`if (decl.columns.has(k))`), so the value was written into the void
   * on every row ever persisted and the co-occurrence relation was unanswerable
   * from SQL. Additive and nullable: legacy rows keep reading `undefined`,
   * which is the truth about them.
   */
  { name: 'frameId', type: 'TEXT' as const },
  /**
   * The producer's own idempotence key (D474) — see `ObjectEvent.idempotencyKey`.
   *
   * DECLARED, not merely stamped: the sqlite backend drops an undeclared key
   * without error, which is exactly how `frameId` was written into the void on
   * every row ever persisted. Nullable — only the package detector sets it.
   */
  { name: 'idempotencyKey', type: 'TEXT' as const },
  { name: 'trackId', type: 'TEXT' as const, notNull: true },
  { name: 'className', type: 'TEXT' as const, notNull: true },
  // Tiered label (roadmap 4g) — the SAME six columns as the track row, because a
  // track and its events must not be able to disagree about what was seen. See
  // `TRACKS_COLUMNS` for the fingerprint caveat.
  { name: 'label', type: 'TEXT' as const },
  { name: 'labelScore', type: 'REAL' as const },
  { name: 'labelMeta', type: 'JSON' as const },
  { name: 'subLabel', type: 'TEXT' as const },
  { name: 'subLabelScore', type: 'REAL' as const },
  { name: 'subLabelMeta', type: 'JSON' as const },
  { name: 'confidence', type: 'REAL' as const, notNull: true },
  { name: 'bbox', type: 'JSON' as const },
  { name: 'zones', type: 'JSON' as const },
  { name: 'state', type: 'TEXT' as const },
  { name: 'frameWidth', type: 'INTEGER' as const },
  { name: 'frameHeight', type: 'INTEGER' as const },
  { name: 'mediaId', type: 'INTEGER' as const },
  // Parent track's key-event importance, propagated to every object event of the
  // track. Nullable: absent on legacy rows / before the track was scored.
  { name: 'importance', type: 'REAL' as const },
  /**
   * When a package PICK-UP happened, beside `timestamp` (when it was
   * CONCLUDED, five minutes later) — see `ObjectEvent.observedAt` (D684).
   *
   * DECLARED, or the backend drops it on write (see `frameId`). Additive: the
   * collection gains the column in place (`ALTER TABLE … ADD COLUMN`), and every
   * row written before it reads SQL NULL → absent after `stripNulls`, which is
   * the truth about it: the moment is unknown. Only the package detector sets it.
   */
  { name: 'observedAt', type: 'INTEGER' as const },
  /**
   * A package delivery written when an uncertain LLM confirm still emitted
   * (D931, before 2026-10-26). A confirm that does not say yes now writes no
   * row. BOOLEAN so a read of an old row comes back `true`. DECLARED, or the
   * backend drops the key on a row that still carries it (see `frameId`).
   */
  { name: 'packagePossible', type: 'BOOLEAN' as const },
  /**
   * The vision model's `{ package, confidence, reason }` when it said yes
   * (D931). JSON. A "no" is not a row. DECLARED for the same reason as
   * `packagePossible`.
   */
  { name: 'packageLlmVerdict', type: 'JSON' as const },
] as const

export const AUDIO_COLUMNS = [
  ...COMMON_BASE_COLUMNS,
  { name: 'rms', type: 'REAL' as const, notNull: true },
  { name: 'dbfs', type: 'REAL' as const, notNull: true },
  { name: 'classification', type: 'JSON' as const },
] as const

/**
 * The columns `slimMotion` reads. `id` is the primary key — always returned,
 * never part of a projection.
 *
 * What it leaves behind is the point: `regions` is a JSON array with one entry
 * per motion rectangle, and it is the only reason a motion row is not tiny.
 * `frameWidth` / `frameHeight` go with it — they exist to interpret `regions`
 * and mean nothing without it.
 */
const SLIM_MOTION_COLUMNS: readonly string[] = [
  'deviceId',
  'timestamp',
  'regionCount',
  'triggeredBy',
]

/**
 * The columns `slimObject` reads — and ONLY those.
 *
 * Four JSON columns are dropped (`bbox`, `zones`, `labelMeta`, `subLabelMeta`)
 * plus the numbers that only exist to argue about a value after the fact
 * (`confidence`, `labelScore`, `subLabelScore`) and the frame geometry that,
 * like motion's, is meaningless without the box it describes.
 *
 * `label` / `subLabel` stay because the timeline renders `subLabel ?? label`,
 * which cannot be evaluated from half a row. `frameId` / `trackId` /
 * `importance` stay because they are the grouping and sort keys the events page
 * needs — all three are light.
 *
 * ⚠ `slimObject` calls `readTieredLabelColumns`, which reads all SIX tiered
 * columns and returns the four unprojected ones as `undefined`. That is
 * harmless here only because `slimObject` uses exactly `label` and `subLabel`
 * from what it gets back. If it ever starts reading a score, this list is the
 * thing that has to learn about it — the failure would otherwise be a score
 * that reads as absent on every slim row.
 */
const SLIM_OBJECT_COLUMNS: readonly string[] = [
  'deviceId',
  'timestamp',
  'className',
  'frameId',
  'trackId',
  'importance',
  'label',
  'subLabel',
]

// AUDIO has NO slim column list, deliberately. `slimAudio` reads `deviceId`,
// `timestamp`, `rms`, `dbfs` and `classification` — every column
// `AUDIO_COLUMNS` declares. A projection there would narrow nothing while
// adding a way for the SELECT and the mapper to drift apart, so the audio slim
// branch stays a pure shape change. `event-store-projection.spec.ts` pins this
// so it does not get "fixed" for symmetry.

const COMMON_INDEXES = (prefix: string) => [
  { name: `idx_${prefix}_device_ts`, columns: ['deviceId', 'timestamp'] as const },
]

/**
 * The wire value `durationMs` carries for an OPEN episode (D475).
 *
 * The app-level contract is "`null` = open, a number = closed, absent = a
 * row from before this column existed" — but SQL has no way to tell "this
 * column was never given a value because the row predates it" from
 * "explicitly set to NULL": `declareCollection` adds the column via ALTER
 * TABLE, which backfills every existing row's `durationMs` with a real SQL
 * NULL, bit-for-bit the same NULL an open episode would write. Writing an
 * actual NULL for "open" would therefore make a brand-new open episode
 * indistinguishable from a five-year-old legacy row — exactly the failure
 * mode this constant exists to avoid. `insertMotion` writes this in place of
 * `null`; `queryMotion` translates it back to `null` on the way out, so
 * nothing outside this file ever sees the sentinel. `-1` is safe because a
 * real duration is never negative.
 */
const OPEN_EPISODE_SENTINEL = -1

/**
 * Event ids to delete, GROUPED by the table each id belongs to.
 *
 * D474 made an event id a per-table SQLite rowid alias, so a flat id list can
 * no longer say which of `motion` / `object` / `audio` an id names — the same
 * ambiguity D476 removed from the media-key grammar. Every producer of an id
 * set already knows which collection it queried (`evictTracklessBefore` reads
 * `MOTION_EVENTS_COLLECTION` and `AUDIO_EVENTS_COLLECTION` separately,
 * `deleteByTrack` only ever touches `OBJECT_EVENTS_COLLECTION`), so this is a
 * partial record rather than a fourth flat array — a caller supplies only the
 * kinds it actually collected.
 */
export type EventOwnedMediaIds = Partial<Record<EventOwnerType, readonly string[]>>

/** The subset of `MediaStore` the retention cascade needs so `deleteByTracks`
 *  can fold in deletion of the evicted events' owned media — the eventId set is
 *  local to this delete, so keeping media deletion HERE means a caller can never
 *  skip it. `MediaStore` satisfies this structurally (`deleteForEvents`). */
export interface EventOwnedMediaDeleter {
  deleteForEvents(ids: EventOwnedMediaIds): Promise<number>
}

/**
 * The key `insert` reports, narrowed to the ROWID these three collections use.
 *
 * `settingsStore.insert` answers `string | number` because the SAME method
 * serves TEXT-keyed collections, where it mints a UUID (D474). On the event
 * collections the primary key is an `INTEGER` rowid alias, so a string here is
 * not an event id at all — it means the table in front of us still has the old
 * TEXT key. Returning `null` says "no id", which is what every caller already
 * handles; the WARN says why, because a silent null would read as a failed
 * write (D474).
 */
function eventRowId(
  logger: IScopedLogger,
  operation: string,
  deviceId: number,
  key: string | number,
): number | null {
  if (typeof key === 'number') return key
  logger.warn(`${operation}: event key is not an INTEGER rowid`, {
    tags: { deviceId },
    meta: { returnedId: key },
  })
  return null
}

/** The tiers of the device-history audio level series the bar can read. */
export type AudioLevelResolution = 'raw' | '5m' | '1h'

export type AudioLevelHistoryQuery = {
  readonly deviceId: number
  readonly key: string
  readonly scope: string
  readonly from: number
  readonly to: number
  readonly resolution: AudioLevelResolution
  readonly maxPoints: number
}

/** `deviceHistory.query`, narrowed to what the level bar reads. */
export type AudioLevelHistoryReader = (input: AudioLevelHistoryQuery) => Promise<{
  readonly series: ReadonlyArray<{
    readonly scope: string
    readonly points: ReadonlyArray<{ readonly t: number; readonly max: number }>
  }>
}>

const RAW_RETENTION_MS = 7 * 86_400_000
const FIVE_MIN_RETENTION_MS = 14 * 86_400_000
const FIVE_MIN_MS = 300_000
const HOUR_MS = 3_600_000
/** The producer writes one raw point per window of this length. */
const AUDIO_LEVEL_POINT_MS = 10_000
const HISTORY_MAX_POINTS = 5000

/**
 * Pick the device-history tier for a density window: raw while the buckets are
 * finer than the 5m rollup, the window is inside raw retention and its points
 * fit one query; the 5m rollup while inside its retention; else 1h.
 */
function audioLevelResolution(
  q: { since: number; until: number; bucketMs: number },
  now: number,
): AudioLevelResolution {
  const rawFits = Math.ceil((q.until - q.since) / AUDIO_LEVEL_POINT_MS) <= HISTORY_MAX_POINTS
  if (q.bucketMs < FIVE_MIN_MS && rawFits && q.since >= now - RAW_RETENTION_MS) return 'raw'
  if (q.bucketMs < HOUR_MS && q.since >= now - FIVE_MIN_RETENTION_MS) return '5m'
  return '1h'
}

export interface EventStoreDeps {
  readonly store: SettingsStoreClient
  /**
   * Where the audio level bar is read from. Absent (an agent, a spec) ⇒ the
   * level comes from the audio events as before.
   */
  readonly audioLevelHistory?: AudioLevelHistoryReader
  readonly now?: () => number
  readonly logger: IScopedLogger
  /** The motion and audio kinds' ledgers (`ctx.records`, every node). */
  readonly motionLedger: EventLedgerCollection
  readonly audioLedger: EventLedgerCollection
  /** Optional media deleter. When present, `deleteByTracks` and
   *  `evictTracklessBefore` fold in deletion of the evicted events' event-owned
   *  media in lockstep. */
  readonly media?: EventOwnedMediaDeleter
  /**
   * Long-term-statistics tap for motion ACTIVITY.
   *
   * Deliberately fed from the call that already writes the row rather than
   * from a new subscription: the design's rule is "no new event topic, no new
   * subscriber" — an aggregator with its own feed is an aggregator that can
   * disagree with the events it claims to summarise. Synchronous and
   * infallible; it must never be able to fail an insert.
   */
  readonly onMotionSample?: (deviceId: number, regionCount: number, at: number) => void
}

export interface PruneBeforeInput {
  readonly deviceId: number
  readonly cutoffMs: number
}

export interface PruneBeforeResult {
  readonly counts: {
    readonly motion: number
    readonly object: number
    readonly audio: number
  }
  /** Flattened id list, kept for callers that only report a count. Never hand
   *  this to `MediaStore.deleteForEvents` — use {@link byKind} instead, which
   *  keeps each id with the table it came from (D476). */
  readonly ids: readonly string[]
  /** The same ids as {@link ids}, grouped by event table. */
  readonly byKind: EventOwnedMediaIds
}

export interface EventDensityQuery {
  readonly deviceId: number
  readonly since: number
  readonly until: number
  readonly bucketMs: number
}

export interface EventDensityBucket {
  readonly bucketStart: number
  readonly motion: number
  readonly object: number
  readonly audio: number
  /** Peak dBFS of the bucket; omitted when not measured, never 0 (D431). */
  readonly audioDbfs?: number
}

/**
 * How much of an event row to read.
 *
 * `slim` now means the engine does not FETCH the heavy columns, not that the
 * mapper declines to return them — see {@link SLIM_MOTION_COLUMNS} and
 * {@link SLIM_OBJECT_COLUMNS}. `full` (default) returns the complete row.
 */
export type EventProjection = 'full' | 'slim'

export interface EventQuery {
  readonly deviceId: number
  readonly since?: number
  readonly until?: number
  readonly limit?: number
  /** See {@link EventProjection}. `slim` also includes an (unset) `mediaUrl`
   *  placeholder for B5. */
  readonly projection?: EventProjection
}

export interface ObjectEventQuery extends EventQuery {
  readonly classFilter?: string
}

export class EventStore {
  private readonly store: SettingsStoreClient
  private readonly logger: IScopedLogger
  private readonly motionLedger: EventLedgerCollection
  private readonly audioLedger: EventLedgerCollection
  private readonly media?: EventOwnedMediaDeleter
  private readonly onMotionSample?: EventStoreDeps['onMotionSample']
  private readonly audioLevelHistory?: AudioLevelHistoryReader
  private readonly nowFn: () => number
  /** Cameras whose history read already failed once (log once per camera, D315). */
  private readonly levelFallbackLogged = new Set<number>()

  constructor(deps: EventStoreDeps) {
    this.store = deps.store
    this.logger = deps.logger
    this.motionLedger = deps.motionLedger
    this.audioLedger = deps.audioLedger
    this.media = deps.media
    this.onMotionSample = deps.onMotionSample
    this.audioLevelHistory = deps.audioLevelHistory
    this.nowFn = deps.now ?? ((): number => Date.now())
  }

  static async declareObjectCollection(store: SettingsStoreClient): Promise<void> {
    await store.declareCollection.mutate({
      collection: OBJECT_EVENTS_COLLECTION,
      database: 'events',
      columns: [...OBJECT_COLUMNS],
      indexes: [
        ...COMMON_INDEXES('object'),
        { name: 'idx_object_track', columns: ['trackId'] as const },
        { name: 'idx_object_frame', columns: ['frameId'] as const },
      ],
    })
  }

  // ── Writes ────────────────────────────────────────────────────────

  /**
   * Returns the ROWID SQLite assigned, or `null` when the write failed (D474).
   *
   * The caller needs it on the very next line — the notification centre reads
   * it and the marker-still path builds a media key from it — and with an
   * auto-assigned key the insert is the ONLY place it is knowable. A
   * placeholder would reach the event bus and the media keys.
   */
  async insertMotion(ev: MotionEventDraft): Promise<number | null> {
    // The LTS sample is taken BEFORE the write and independently of it: the
    // five-minute row is a summary, and a summary is the one thing allowed to
    // lose a sample (D8). A failed insert must not also cost the statistic.
    this.onMotionSample?.(ev.deviceId, ev.regionCount, ev.timestamp)
    // `durationMs: null` (open episode) is written as `OPEN_EPISODE_SENTINEL`
    // — see that constant's doc for why a real SQL NULL can't carry this
    // meaning (D475).
    const record: Record<string, unknown> = { ...ev }
    if (ev.durationMs === null) record['durationMs'] = OPEN_EPISODE_SENTINEL
    try {
      const inserted = await this.motionLedger.insert(record)
      if (inserted === null) {
        this.logger.warn('insertMotion: records insert returned null', {
          tags: { deviceId: ev.deviceId },
          meta: { timestamp: ev.timestamp },
        })
        return null
      }
      return eventRowId(this.logger, 'insertMotion', ev.deviceId, inserted)
    } catch (err) {
      this.logger.warn('insertMotion failed', {
        tags: { deviceId: ev.deviceId },
        meta: { timestamp: ev.timestamp, error: String(err) },
      })
      return null
    }
  }

  /**
   * The one place a motion EPISODE row is closed (D475). Writes `durationMs`
   * and the encoded `edges` in a single UPDATE — a row never gets a second
   * write after this one. Returns whether it landed; the caller
   * (`MotionEpisodeTracker`) logs the failure with the episode's `deviceId`
   * tag, because a `durationMs: null` row that never gets a reason is exactly
   * the silent-forever-open shape D475 exists to prevent.
   */
  async updateMotion(
    eventId: number,
    deviceId: number,
    patch: { readonly durationMs: number; readonly edges: readonly number[] },
  ): Promise<boolean> {
    try {
      await this.motionLedger.update(String(eventId), {
        durationMs: patch.durationMs,
        edges: encodeMotionEdges(patch.edges),
      })
      return true
    } catch (err) {
      this.logger.warn('updateMotion (episode close) failed', {
        tags: { deviceId },
        meta: { eventId, error: String(err) },
      })
      return false
    }
  }

  /**
   * The motion-activity LTS tap, exposed for a caller that extends an
   * already-open episode without inserting a new row (D475) — `insertMotion`
   * fires it on OPEN; this fires it on every further tick, so a long
   * continuous episode still samples activity at the same density the
   * pre-D475 heartbeat gave the aggregator, rather than once per episode.
   */
  noteMotionSample(deviceId: number, regionCount: number, at: number): void {
    this.onMotionSample?.(deviceId, regionCount, at)
  }

  /**
   * Returns the ROWID SQLite assigned, or `null` when the write failed (D474).
   *
   * The caller needs it on the very next line — the notification centre reads
   * it and the marker-still path builds a media key from it — and with an
   * auto-assigned key the insert is the ONLY place it is knowable. A
   * placeholder would reach the event bus and the media keys.
   */
  async insertObject(ev: ObjectEventDraft): Promise<number | null> {
    try {
      // Integer pixels (D471). `bbox` carried the same float tail as
      // `positions` — {"w":1089.6000000000001} — and is 18 % of this table.
      const rounded = 'bbox' in ev ? { ...ev, bbox: roundBbox(ev.bbox) } : ev
      const inserted = await this.store.insert.mutate({
        collection: OBJECT_EVENTS_COLLECTION,
        record: { data: rounded as Record<string, unknown> },
      })
      return eventRowId(this.logger, 'insertObject', ev.deviceId, inserted.id)
    } catch (err) {
      this.logger.warn('insertObject failed', {
        tags: { deviceId: ev.deviceId },
        meta: { timestamp: ev.timestamp, error: String(err) },
      })
      return null
    }
  }

  /**
   * Returns the ROWID SQLite assigned, or `null` when the write failed (D474).
   *
   * The caller needs it on the very next line — the notification centre reads
   * it and the marker-still path builds a media key from it — and with an
   * auto-assigned key the insert is the ONLY place it is knowable. A
   * placeholder would reach the event bus and the media keys.
   */
  async insertAudio(ev: AudioEventDraft): Promise<number | null> {
    try {
      const inserted = await this.audioLedger.insert(ev as Record<string, unknown>)
      if (inserted === null) {
        this.logger.warn('insertAudio: records insert returned null', {
          tags: { deviceId: ev.deviceId },
          meta: { timestamp: ev.timestamp },
        })
        return null
      }
      return eventRowId(this.logger, 'insertAudio', ev.deviceId, inserted)
    } catch (err) {
      this.logger.warn('insertAudio failed', {
        tags: { deviceId: ev.deviceId },
        meta: { timestamp: ev.timestamp, error: String(err) },
      })
      return null
    }
  }

  // ── Reads ────────────────────────────────────────────────────────

  /**
   * Collect the ids matching `filter`, then delete every matching row in ONE
   * statement. The shared body of every retention sweep here.
   *
   * The ids are still read because the callers delete each event's media in
   * lockstep and a bulk delete returns only a count. What is gone is the
   * per-row delete loop: ~7,200 round trips to prune a day of motion events,
   * each carrying every column of the row it deleted.
   *
   * Three properties, each of which cost a red test to learn:
   *
   *  - **the filter is used for BOTH halves**, so what is reported and what is
   *    removed cannot drift apart;
   *  - **paging carries an explicit offset over ROWS READ.** Deleting each page
   *    used to advance the cursor implicitly; reading without deleting re-reads
   *    page one forever. And a row with a non-string id yields no id but still
   *    occupies a place, so ids collected is the wrong cursor;
   *  - **only an EMPTY page ends the scan.** The store caps pages on its own
   *    (~500), so "fewer rows than requested" is normal, not the end — treating
   *    it as the end silently deletes just the first page while reporting a
   *    complete sweep;
   *  - **a delete that removed nothing reports NO ids.** Callers remove media
   *    against this list; claiming a deletion that did not happen would orphan
   *    media in the opposite direction.
   */
  private ledgerFor(collection: string): EventLedgerCollection | null {
    if (collection === MOTION_EVENTS_COLLECTION) return this.motionLedger
    if (collection === AUDIO_EVENTS_COLLECTION) return this.audioLedger
    return null
  }

  private async collectIds(collection: string, filter: MutationFilter): Promise<string[]> {
    const ledger = this.ledgerFor(collection)
    if (ledger !== null) return ledger.collectIds(filter)
    const ids: string[] = []
    let offset = 0
    for (;;) {
      const rows = await this.store.query.query({
        collection,
        filter: { ...filter, limit: PRUNE_PAGE_SIZE, offset },
      })
      if (rows.length === 0) break
      offset += rows.length
      for (const row of rows) {
        if (typeof row.id === 'string') ids.push(row.id)
      }
    }
    return ids
  }

  private async drainMatching(collection: string, filter: MutationFilter): Promise<string[]> {
    const ledger = this.ledgerFor(collection)
    if (ledger !== null) return ledger.drainMatching(filter)
    const ids = await this.collectIds(collection, filter)
    if (ids.length === 0) return ids

    const { deleted } = await this.store.deleteWhere.mutate({ collection, filter })
    return deleted === 0 ? [] : ids
  }

  /**
   * Motion + audio ids for the device, without deleting. Object events cascade
   * with their track; these two kinds are the trackless roots disk reconcile
   * has to inspect after missing blobs are dropped.
   */
  async listTracklessIds(
    deviceId: number,
  ): Promise<{ motion: readonly string[]; audio: readonly string[] }> {
    const filter: MutationFilter = { where: { deviceId } }
    const [motion, audio] = await Promise.all([
      this.collectIds(MOTION_EVENTS_COLLECTION, filter),
      this.collectIds(AUDIO_EVENTS_COLLECTION, filter),
    ])
    return { motion, audio }
  }

  /**
   * Delete named rows from ONE event table. Media rows are already gone (disk
   * reconcile dropped the missing blobs first).
   *
   * It used to take a bare id list and delete it from the motion table AND the
   * audio table (`deleteByIds`), which was safe while event ids were UUIDs.
   * D474 made an event id a per-table rowid alias, so "delete 5" deleted a
   * motion visit and an unrelated audio episode — a WRONG delete, not a missed
   * reclaim, and on this hub every one of the 391 984 audio ids is also a
   * motion id. The table is now a parameter and there is no id-only door left
   * to call (D480).
   */
  async deleteByIdsIn(table: EventOwnerType, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    const collection = EVENT_COLLECTION_BY_TABLE[table]
    const ledger = this.ledgerFor(collection)
    if (ledger !== null) {
      await ledger.deleteByIds(ids)
      return
    }
    const filter: MutationFilter = { whereIn: { id: [...ids] } }
    await this.store.deleteWhere.mutate({ collection, filter })
  }

  /**
   * Spreadable `columns` for a slim read — omitted entirely for `full`.
   *
   * The projection is decided in ONE place per collection ({@link
   * SLIM_MOTION_COLUMNS} / {@link SLIM_OBJECT_COLUMNS}) because a projection is
   * a promise between the SELECT and the mapper: the day they disagree nothing
   * fails. SQLite returns the row without the column, `slimObject` reads
   * `data['className']`, gets `undefined`, and hands back an event whose class
   * is missing — indistinguishable from a row that never had one.
   */
  private slimColumns(
    projection: EventProjection | undefined,
    columns: readonly string[],
  ): { columns?: readonly string[] } {
    return projection === 'slim' ? { columns } : {}
  }

  private buildFilter(q: EventQuery): Record<string, unknown> {
    const filter: Record<string, unknown> = {
      where: { deviceId: q.deviceId },
      orderBy: { field: 'timestamp', direction: 'desc' },
    }
    if (q.since !== undefined || q.until !== undefined) {
      filter.whereBetween = { timestamp: [q.since ?? 0, q.until ?? Date.now()] }
    }
    if (q.limit !== undefined) filter.limit = q.limit
    return filter
  }

  async queryMotion(q: EventQuery): Promise<readonly MotionEvent[]> {
    const rows = await this.motionLedger.query(
      this.buildFilter(q),
      q.projection === 'slim' ? SLIM_MOTION_COLUMNS : undefined,
    )
    if (q.projection === 'slim') {
      return rows.map((r) => slimMotion(Number(r.id), stripNulls(r.data)))
    }
    return rows.map((r) => {
      // `edges` is stored as the encoded string `motion-edge-codec.ts` writes
      // at close (D475) — pull the raw value out and decode it back to
      // offsets here, the one place a full motion row is assembled. A row
      // that never closed or predates D475 has no value: `rawEdges` stays
      // `undefined`, and the event carries no `edges` key at all rather than
      // a `[]` that could be mistaken for "recorded and empty".
      //
      // `durationMs` needs the same treatment for the sentinel (D475): a
      // present-but-sentinel value means "open", a present real number means
      // "closed", and an ABSENT value (stripped by `stripNulls`, since a
      // legacy row's column is real SQL NULL) means "written before this
      // column existed" — never "open".
      const {
        edges: rawEdges,
        durationMs: rawDurationMs,
        triggeredBy: rawTriggeredBy,
        ...data
      } = stripNulls(r.data)
      const ev: MotionEvent = {
        // The column is an INTEGER rowid; `SettingsRecord.id` stays `string` for
        // the generic store, so the boundary converts (D474).
        id: Number(r.id),
        kind: 'motion',
        ...(data as Omit<MotionEvent, 'id' | 'kind' | 'edges' | 'durationMs' | 'triggeredBy'>),
        ...(rawDurationMs !== undefined
          ? {
              durationMs:
                rawDurationMs === OPEN_EPISODE_SENTINEL ? null : (rawDurationMs as number),
            }
          : {}),
        ...(rawEdges !== undefined ? { edges: decodeMotionEdges(rawEdges) } : {}),
        ...storedTriggeredBy(rawTriggeredBy),
      }
      return ev
    })
  }

  /**
   * Fetch every object event belonging to a SET of tracks, in one query.
   *
   * Semantic search needs exactly this: it ranks embeddings, ends up with a
   * few dozen winning trackIds, and wants their events. It used to get them by
   * querying each winner's DEVICE for up to 5,000 events and filtering
   * client-side, guarded by a comment stating "the event store doesn't support
   * trackId WHERE". That was not true — `trackId` has had its own index
   * (`idx_object_track`) since the table was declared, `setLabelForTrack` and
   * `peakForTrack` both filter on it, and `QueryFilter` has carried `whereIn`
   * all along. The comment made a limitation look real and cost a full-table
   * scan per camera on every search.
   *
   * Returns an empty array for an empty input rather than querying with an
   * empty `IN ()`, which some backends treat as "match everything".
   */
  async queryObjectByTrackIds(trackIds: readonly string[]): Promise<readonly ObjectEvent[]> {
    if (trackIds.length === 0) return []
    /**
     * PAGED, because this one is unbounded BY DESIGN: `trackIds` bounds the
     * tracks, nothing bounds the events per track, and the caller wants all of
     * them. The engine's defensive cap would truncate it at
     * `SETTINGS_QUERY_DEFAULT_ROW_CAP` — loudly, but truncated all the same,
     * and a search result missing its later events is a correctness bug rather
     * than a memory one. Owning the bound here keeps the engine cap as what it
     * is meant to be: a backstop nothing normally touches.
     */
    const out: ObjectEvent[] = []
    for (let offset = 0; ; offset += PRUNE_PAGE_SIZE) {
      const rows = await this.store.query.query({
        collection: OBJECT_EVENTS_COLLECTION,
        filter: {
          whereIn: { trackId: [...trackIds] },
          orderBy: { field: 'id', direction: 'asc' },
          limit: PRUNE_PAGE_SIZE,
          offset,
        },
      })
      if (rows.length === 0) break
      for (const r of rows) {
        out.push({
          // The column is an INTEGER rowid; `SettingsRecord.id` stays `string` for
          // the generic store, so the boundary converts (D474).
          id: Number(r.id),
          kind: 'object',
          ...(stripNulls(r.data) as Omit<ObjectEvent, 'id' | 'kind'>),
        })
      }
      if (rows.length < PRUNE_PAGE_SIZE) break
    }
    return out
  }

  async queryObject(q: ObjectEventQuery): Promise<readonly ObjectEvent[]> {
    const filter = this.buildFilter(q)
    if (q.classFilter !== undefined) {
      const where = filter.where as Record<string, unknown>
      where['className'] = q.classFilter
    }
    const rows = await this.store.query.query({
      collection: OBJECT_EVENTS_COLLECTION,
      filter,
      ...this.slimColumns(q.projection, SLIM_OBJECT_COLUMNS),
    })
    if (q.projection === 'slim') {
      return rows.map((r) => slimObject(Number(r.id), stripNulls(r.data)))
    }
    return rows.map((r) => {
      const ev: ObjectEvent = {
        // The column is an INTEGER rowid; `SettingsRecord.id` stays `string` for
        // the generic store, so the boundary converts (D474).
        id: Number(r.id),
        kind: 'object',
        ...(stripNulls(r.data) as Omit<ObjectEvent, 'id' | 'kind'>),
      }
      return ev
    })
  }

  /**
   * Cross-device object-event scan since a timestamp (ascending). Powers
   * the Notification Center's boot watermark reconcile + `testRule`
   * dry-runs — those operate over the WHOLE camera set, unlike the
   * per-device timeline queries above. Bounded by `limit` (newest kept).
   */
  async queryObjectSince(params: {
    since: number
    until?: number
    limit?: number
  }): Promise<readonly ObjectEvent[]> {
    const rows = await this.store.query.query({
      collection: OBJECT_EVENTS_COLLECTION,
      filter: {
        whereBetween: { timestamp: [params.since, params.until ?? Date.now()] },
        orderBy: { field: 'timestamp', direction: 'desc' },
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      },
    })
    return rows
      .map((r) => {
        const ev: ObjectEvent = {
          // The column is an INTEGER rowid; `SettingsRecord.id` stays `string` for
          // the generic store, so the boundary converts (D474).
          id: Number(r.id),
          kind: 'object',
          ...(stripNulls(r.data) as Omit<ObjectEvent, 'id' | 'kind'>),
        }
        return ev
      })
      .reverse()
  }

  async queryAudio(q: EventQuery): Promise<readonly AudioEvent[]> {
    const rows = await this.audioLedger.query(this.buildFilter(q))
    if (q.projection === 'slim') {
      return rows.map((r) => slimAudio(Number(r.id), stripNulls(r.data)))
    }
    return rows.map((r) => {
      const ev: AudioEvent = {
        // The column is an INTEGER rowid; `SettingsRecord.id` stays `string` for
        // the generic store, so the boundary converts (D474).
        id: Number(r.id),
        kind: 'audio',
        ...(stripNulls(r.data) as Omit<AudioEvent, 'id' | 'kind'>),
      }
      return ev
    })
  }

  /**
   * Resolve the OWNING track id for an object event id. Powers the event-media
   * resolver's track fallback: a new-style object event owns no crop, so its
   * `mediaUrl` degrades to the track's cadence media, addressed by this id.
   * Returns `null` when the id is not a persisted object event (e.g. a KeyEvent
   * whose id is already a track id) — best-effort.
   *
   * **D476: only an OBJECT event has a `trackId` at all** — motion and audio
   * rows carry no such column, so this probes `OBJECT_EVENTS_COLLECTION`
   * only, never the other two. That was already true structurally, but before
   * D474 an id that MISSED here was safely "not an object event" because
   * every id was a UUID, unique across all three tables. D474 made event ids
   * per-table rowid aliases, so a motion id can now coincide with an
   * UNRELATED object row of the same number — a probe that HITS is no longer
   * proof the caller's id names that object row.
   *
   * `ownerType`, when the caller already knows it (a `motion:`/`audio:`/
   * `object:` key was parsed rather than a bare legacy id), short-circuits to
   * `null` without querying for anything but `'object'` — the caller's one
   * remaining lever against the collision, since this method has nothing left
   * to guess once the kind is in the key. Its only caller today
   * (`readEventThumbnail` in `index.ts`) still reaches this with a bare,
   * kind-less id from a URL and cannot supply it — see the D476 ADR for why
   * that residual ambiguity is accepted rather than fixed here.
   */
  async getTrackIdForEvent(eventId: string, ownerType?: EventOwnerType): Promise<string | null> {
    if (ownerType !== undefined && ownerType !== 'object') return null
    try {
      const row = await this.store.get.query({
        collection: OBJECT_EVENTS_COLLECTION,
        key: eventId,
      })
      if (row !== null && typeof row === 'object' && 'trackId' in row) {
        const trackId = (row as Record<string, unknown>)['trackId']
        if (typeof trackId === 'string' && trackId.length > 0) return trackId
      }
      return null
    } catch (err) {
      this.logger.debug('getTrackIdForEvent failed', {
        meta: { eventId, error: String(err) },
      })
      return null
    }
  }

  /**
   * Project the TRACK's label decision onto every object event of that track.
   * Returns how many rows took it.
   *
   * ONE DECISION, EVERY ROW — and that is the correction, not the design it
   * replaced. This used to re-run `resolveTieredLabelWrite` per row against
   * that row's own tiers, on the theory that "the events of one track do not
   * all carry the same label". They do: a track has ONE subject, and every
   * read surface (the timeline, the event page, a notification body, a rule's
   * `identities` condition) shows the track's answer. Re-deciding per row meant
   * a row whose incumbent happened to outscore the track's winner kept a
   * different word, and the rows drifted apart from the track and from each
   * other — measured 2026-08-14 as 407 of 437 tracks whose event rows
   * disagreed with the track they belong to. A notification quoting one row and
   * a timeline quoting another then told the operator two different names for
   * the same person.
   *
   * The caller passes the patch the TRACK row accepted, so the two can never
   * disagree by construction. A refused track write projects nothing: nothing
   * changed, so there is nothing to copy.
   *
   * Used when face recognition, plate matching or a classifier answers after
   * the events were emitted.
   */
  async projectTrackLabel(trackId: string, patch: TieredLabelPatch): Promise<number> {
    const rows = await this.store.query.query({
      collection: OBJECT_EVENTS_COLLECTION,
      filter: { where: { trackId } },
    })
    const data = tieredLabelColumnData(patch)
    let updated = 0
    for (const row of rows) {
      try {
        await this.store.update.mutate({
          collection: OBJECT_EVENTS_COLLECTION,
          id: row.id,
          data,
        })
        updated++
      } catch (err) {
        this.logger.warn('projectTrackLabel update failed', {
          meta: { trackId, eventId: row.id, error: String(err) },
        })
      }
    }
    return updated
  }

  /**
   * Forward-only: stamp `importance` on every already-emitted object event of a
   * track. Returns the number of events updated. Best-effort per row. Mirrors
   * `setLabelForTrack`. Called when a track's key-event score is computed (at
   * expiry) or recomputed (late label) so an event row carries the parent
   * track's importance without a join.
   */
  async setImportanceForTrack(trackId: string, importance: number): Promise<number> {
    const rows = await this.store.query.query({
      collection: OBJECT_EVENTS_COLLECTION,
      filter: { where: { trackId } },
    })
    let updated = 0
    for (const row of rows) {
      try {
        await this.store.update.mutate({
          collection: OBJECT_EVENTS_COLLECTION,
          id: row.id,
          data: { importance },
        })
        updated++
      } catch (err) {
        this.logger.warn('setImportanceForTrack update failed', {
          meta: { trackId, eventId: row.id, error: String(err) },
        })
      }
    }
    return updated
  }

  /**
   * The track's highest-confidence object event, its bbox area (as a fraction of
   * frame area), and its representative event id — the SHARED per-track ranking
   * used for the best frame, read back from the persisted object events (index
   * `idx_object_track`). Returns zeros + undefined id when the track has none.
   * Used by the importance scorer at expiry and by `getKeyEvents` compute-on-read.
   *
   * `peakConfidence` + `peakBboxAreaFrac` always track the TRUE confidence peak
   * (over every crop-bearing row) — importance reads them.
   *
   * `bestEventId` treats the synthetic APPEARANCE / entry event (state
   * `'entered'`, Requirement 1) as a FLOOR: it represents the track only when no
   * genuine ACTIVITY event (any other state — a zone / stationary / moving
   * moment) exists. So a degenerate passer-by whose only crop-bearing event is
   * its appearance still gets a representative id, while a track that later
   * produced a real activity event surfaces THAT as its best. Within a tier the
   * highest confidence wins.
   */
  async peakForTrack(trackId: string): Promise<{
    peakConfidence: number
    peakBboxAreaFrac: number
    bestEventId: string | undefined
  }> {
    const rows = await this.store.query.query({
      collection: OBJECT_EVENTS_COLLECTION,
      filter: { where: { trackId } },
    })
    // Confidence peak over ALL crop-bearing rows (importance input, unchanged).
    let bestConf = -1
    let peakBboxAreaFrac = 0
    // Representative id, tiered: an ACTIVITY event (non-'entered' state) always
    // outranks an ENTRY event (appearance / entering, state 'entered'). Within a
    // tier, highest confidence wins.
    let activityConf = -1
    let activityId: string | undefined
    let entryConf = -1
    let entryId: string | undefined
    for (const row of rows) {
      // Only a row that MEASURED the subject is eligible — for the importance
      // peak and for `bestEventId` alike. A `state:'left'` departure is
      // resolved from the last known track precisely because the subject is
      // gone that frame: it used to carry a fabricated {0,0,0,0} (caught by
      // the zero-area test) and since 2026-09-07 carries NO bbox at all (D393).
      // "No bbox" used to be left eligible "for legacy rows", so the departure
      // — activity tier, stale last-real confidence — outranked the entry and
      // became the bestEventId of most tracks: a pointer at a row with no box
      // and no crop, which the CLIP rebuild then refused as missingBbox (D664).
      const bbox = row.data['bbox']
      if (bbox === null || typeof bbox !== 'object') continue
      const bw = 'w' in bbox && typeof bbox.w === 'number' ? bbox.w : 0
      const bh = 'h' in bbox && typeof bbox.h === 'number' ? bbox.h : 0
      if (bw <= 0 || bh <= 0) continue
      const conf = typeof row.data['confidence'] === 'number' ? row.data['confidence'] : 0
      if (conf > bestConf) {
        bestConf = conf
        peakBboxAreaFrac = bboxAreaFrac(row.data)
      }
      // An appearance / entry event is the representative FLOOR (state 'entered');
      // everything else is a genuine activity moment that outranks it.
      if (row.data['state'] === 'entered') {
        if (conf > entryConf) {
          entryConf = conf
          entryId = row.id
        }
      } else if (conf > activityConf) {
        activityConf = conf
        activityId = row.id
      }
    }
    return {
      peakConfidence: bestConf < 0 ? 0 : bestConf,
      peakBboxAreaFrac,
      bestEventId: activityId ?? entryId,
    }
  }

  /**
   * Clear ONE tier on every already-emitted object event of a track (sets the
   * tier's three columns to null so stripNulls/slimObject omit them on read).
   * Returns the number of events updated. Best-effort per row. Used by
   * unassignFace to revert an identity — which is a TIER-2 value, so clearing
   * tier 1 as well would take a sub-class nobody disputed with it.
   */
  async clearLabelForTrack(trackId: string, tier: LabelTier): Promise<number> {
    const rows = await this.store.query.query({
      collection: OBJECT_EVENTS_COLLECTION,
      filter: { where: { trackId } },
    })
    let updated = 0
    for (const row of rows) {
      try {
        await this.store.update.mutate({
          collection: OBJECT_EVENTS_COLLECTION,
          id: row.id,
          data:
            tier === 1
              ? { label: null, labelScore: null, labelMeta: null }
              : { subLabel: null, subLabelScore: null, subLabelMeta: null },
        })
        updated++
      } catch (err) {
        this.logger.warn('clearLabelForTrack update failed', {
          meta: { trackId, eventId: row.id, error: String(err) },
        })
      }
    }
    return updated
  }

  /**
   * Total persisted event rows (motion + object + audio) for a device — the
   * "rows" figure in the events-management footprint. Uses the indexed `count`
   * aggregate per collection, run in parallel.
   */
  async countForDevice(deviceId: number): Promise<number> {
    const [motion, object, audio] = await Promise.all([
      this.motionLedger.count({ where: { deviceId } }),
      this.store.count.query({
        collection: OBJECT_EVENTS_COLLECTION,
        filter: { where: { deviceId } },
      }),
      this.audioLedger.count({ where: { deviceId } }),
    ])
    return motion + object + audio
  }

  /**
   * Persisted event rows (motion + object + audio) for EVERY device that has
   * any — three round trips for the whole fleet.
   *
   * {@link countForDevice} answers one camera in three `COUNT(*)`s, which is
   * right for one camera and wrong in a loop: the events-management footprint
   * called it once per device, so the cost of "how many events does each camera
   * hold" grew with the camera count for a result that is a few dozen integers.
   *
   * A histogram on `deviceId` with `bucketSize: 1` is `GROUP BY deviceId`, and
   * every event collection already carries `idx_<kind>_device_ts`, which leads
   * with `deviceId` — so the planner serves each of these from a covering index
   * with no table access at all. `bucket` IS the deviceId (the column is
   * INTEGER, the bucket expression is `CAST((deviceId - 0) / 1 AS INTEGER)`).
   *
   * Not best-effort: a failure propagates. The one caller is sizing a deletion,
   * and a camera silently reported as holding zero events is the answer that
   * must never come from a read that did not happen.
   */
  async countByDevice(): Promise<Map<number, number>> {
    const [motionMap, objectBuckets, audioMap] = await Promise.all([
      this.motionLedger.histogramDevice(),
      this.store.histogram.query({
        collection: OBJECT_EVENTS_COLLECTION,
        field: 'deviceId',
        bucketSize: 1,
        origin: 0,
      }),
      this.audioLedger.histogramDevice(),
    ])
    const out = new Map<number, number>()
    for (const [deviceId, count] of motionMap) {
      out.set(deviceId, (out.get(deviceId) ?? 0) + count)
    }
    for (const bucket of objectBuckets) {
      if (bucket.count === 0 || !Number.isFinite(bucket.bucket)) continue
      out.set(bucket.bucket, (out.get(bucket.bucket) ?? 0) + bucket.count)
    }
    for (const [deviceId, count] of audioMap) {
      out.set(deviceId, (out.get(deviceId) ?? 0) + count)
    }
    return out
  }

  // ── Density (histogram aggregation) ─────────────────────────────

  /**
   * Return per-kind event counts in equal-width time buckets.
   *
   * Each bucket maps to a `bucketStart = since + i * bucketMs`.
   * Empty buckets (motion + object + audio all zero) are omitted so the
   * UI only processes non-trivial data points.
   *
   * All three collections are queried in parallel via `histogram` to
   * minimise latency.
   */
  async densityByKind(q: EventDensityQuery): Promise<readonly EventDensityBucket[]> {
    const runObject = async (): Promise<Map<number, number>> => {
      const rows = await this.store.histogram.query({
        collection: OBJECT_EVENTS_COLLECTION,
        field: 'timestamp',
        bucketSize: q.bucketMs,
        origin: q.since,
        filter: {
          where: { deviceId: q.deviceId },
          whereBetween: { timestamp: [q.since, q.until] },
        },
      })
      return new Map(rows.map((r) => [r.bucket, r.count]))
    }

    const [motionMap, objectMap, audioMap, audioDbfsMap] = await Promise.all([
      this.motionLedger.histogramTime({
        deviceId: q.deviceId,
        since: q.since,
        until: q.until,
        bucketMs: q.bucketMs,
      }),
      runObject(),
      this.audioLedger.histogramTime({
        deviceId: q.deviceId,
        since: q.since,
        until: q.until,
        bucketMs: q.bucketMs,
      }),
      // The LEVEL, not the count (D431). Aggregated HERE, where the samples
      // already are: one number per bucket crosses the wire instead of every
      // audio event in the window, which on a 24 h tape is thousands per
      // camera and was the reason the viewer painted a count instead.
      this.audioDbfsPerBucket(q),
    ])

    const buckets = Math.max(0, Math.ceil((q.until - q.since) / q.bucketMs))
    const out: EventDensityBucket[] = []
    for (let i = 0; i < buckets; i++) {
      const m = motionMap.get(i) ?? 0
      const o = objectMap.get(i) ?? 0
      const a = audioMap.get(i) ?? 0
      const dbfs = audioDbfsMap.get(i)
      // A bucket with a level is drawn even with no events: the bar is a
      // continuous level, not an event count.
      if (m + o + a === 0 && dbfs === undefined) continue
      out.push({
        bucketStart: q.since + i * q.bucketMs,
        motion: m,
        object: o,
        audio: a,
        // Omitted, never zeroed: a bucket nobody measured is not a silent one.
        ...(dbfs !== undefined ? { audioDbfs: dbfs } : {}),
      })
    }
    return out
  }

  /**
   * Energy-weighted mean dBFS per bucket index, for the buckets that have
   * audio. Reads the window's audio events once, `slim`, and folds them —
   * `histogram` can only count, and a level is not a count.
   *
   * A read that fails yields an EMPTY map, so the lane draws no level rather
   * than a wrong one: the density counts beside it are unaffected, and a
   * missing bar is the honest rendering of "not measured" (D431).
   */
  private async audioDbfsPerBucket(q: EventDensityQuery): Promise<Map<number, number>> {
    // Semantics (D431 follow-up): `audioDbfs` is the PEAK of the bucket, read
    // from the device-history level series — one query per device per call.
    // The audio events below are the fallback when that read fails or the
    // series has nothing; there the level is their energy-weighted mean.
    const history = this.audioLevelHistory
    if (history !== undefined) {
      try {
        const resolution = audioLevelResolution(q, this.nowFn())
        const res = await history({
          deviceId: q.deviceId,
          key: ANALYTICS_AUDIO_LEVEL_KEY,
          scope: '',
          from: q.since,
          to: q.until,
          resolution,
          maxPoints: HISTORY_MAX_POINTS,
        })
        const points = res.series.flatMap((s) => s.points)
        if (points.length > 0) return audioPeakByBucket(points, q.since, q.bucketMs)
      } catch (err) {
        if (!this.levelFallbackLogged.has(q.deviceId)) {
          this.levelFallbackLogged.add(q.deviceId)
          this.logger.warn(
            'density: audio level history unreadable — falling back to audio events',
            {
              tags: { deviceId: q.deviceId },
              meta: { error: String(err) },
            },
          )
        }
      }
    }
    try {
      const events = await this.queryAudio({
        deviceId: q.deviceId,
        since: q.since,
        until: q.until,
        projection: 'slim',
      })
      return audioDbfsByBucket(
        events.map((e) => ({ timestamp: e.timestamp, dbfs: e.dbfs })),
        q.since,
        q.bucketMs,
      )
    } catch (err) {
      this.logger.warn('density: audio level aggregation failed — the lane will draw no level', {
        tags: { deviceId: q.deviceId },
        meta: { error: String(err) },
      })
      return new Map()
    }
  }

  // ── Retention ────────────────────────────────────────────────────

  // (helper below)

  /**
   * Age-evict the TRACKLESS event kinds — motion and audio.
   *
   * **Object events are not here, and that is the point.** An object event is a
   * state transition OF A TRACK: it carries a `trackId`, it owns crops, and it
   * cannot mean anything once its track is gone. It used to be swept on its own
   * `retentionObjectDays` window, which disagreed with the track window
   * (measured: object events spanning 19.8 days against tracks at 7.0), and
   * every event that outlived its track left its crops behind as orphans.
   * Object events now leave exactly one way: with their track, through
   * {@link deleteByTracks} (D61).
   *
   * Motion and audio carry no `trackId` and are referenced by nothing — they
   * are terminal retention ROOTS, so an age window on them cannot contradict
   * anybody's (`retention/retention-model.ts`). A motion visit still is
   * event-owned media of that row and is deleted here in lockstep.
   *
   * **ONE cutoff for both kinds** (D62). They used to take a window each
   * (`retentionMotionDays` / `retentionAudioDays`), which is two clocks over
   * two entities that are always swept in the same pass, for the same device,
   * by the same caller — a divergence with nothing to gain from it. The window
   * is the device's, resolved once, and the same one the track sweep uses.
   *
   * Drains fully per kind: loops a page at a time (PRUNE_PAGE_SIZE) until no
   * stale rows remain. A single-page sweep would cap eviction at
   * PRUNE_PAGE_SIZE per run and a high-volume camera would out-produce it.
   */
  async evictTracklessBefore(params: {
    readonly cutoffMs: number
    /** Scope the sweep to ONE device (retention resolves the cutoff per-device
     *  — follow-recordings tracks each camera's own footage). */
    readonly deviceId?: number
  }): Promise<{ motion: readonly string[]; audio: readonly string[] }> {
    const batch = async (collection: string): Promise<string[]> =>
      this.drainMatching(collection, {
        ...(params.deviceId !== undefined ? { where: { deviceId: params.deviceId } } : {}),
        whereBetween: { timestamp: [0, params.cutoffMs] },
      })

    const motion = await batch(MOTION_EVENTS_COLLECTION)
    const audio = await batch(AUDIO_EVENTS_COLLECTION)
    if ((motion.length > 0 || audio.length > 0) && this.media !== undefined) {
      try {
        await this.media.deleteForEvents({ motion, audio })
      } catch (err) {
        this.logger.warn('EventStore.evictTracklessBefore: event media delete failed', {
          meta: { error: String(err) },
        })
      }
    }
    return { motion, audio }
  }

  /**
   * OPERATOR-INITIATED object-event deletion — the "delete events older than
   * X" button, not a retention policy.
   *
   * This is the one path that can still remove a track-owned entity without its
   * track, and it exists because the operator asked for exactly that with a
   * cutoff they typed. It is NOT on any timer, it is logged to the ops log with
   * `reason: 'manual'` / `'operator'`, and the orphan audit will report the
   * crops it leaves behind. The periodic sweep must never call it — the guard
   * `scripts/check-age-keyed-retention.ts` lists it explicitly as operator-only
   * for that reason (D61).
   */
  async pruneObjectEventsBefore(cutoffMs: number, deviceId?: number): Promise<readonly string[]> {
    return this.drainMatching(OBJECT_EVENTS_COLLECTION, {
      ...(deviceId !== undefined ? { where: { deviceId } } : {}),
      whereBetween: { timestamp: [0, cutoffMs] },
    })
  }

  /**
   * The SUBSET of `eventIds` that still exist IN ONE TABLE — the orphan
   * audit's liveness probe for event-owned media.
   *
   * It used to union the three event tables under one method, which was safe
   * while event ids were UUIDs. D474 made an event id a per-table rowid alias
   * and the ranges overlap completely: on the live hub all 100 051 object ids
   * and all 391 984 audio ids are ALSO motion ids, so the union answered
   * "live" for every object- and audio-owned media row in existence and no
   * such row could ever be reclaimed (D480). The union is GONE rather than
   * kept alongside this: a probe that can be called without naming a table is
   * a probe that will be.
   *
   * Motion and audio rows own stills too (`kind: 'snapshot'` on a motion
   * visit), which is why the caller resolves the table off the media row's own
   * `ownerKind` instead of assuming `object`.
   *
   * THROWS on a query failure rather than answering partially. A probe that
   * quietly under-reports here reads as "these events are gone", and the caller
   * deletes live crops on the strength of it.
   */
  async existingEventIdsIn(
    table: EventOwnerType,
    eventIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const collection = EVENT_COLLECTION_BY_TABLE[table]
    const ledger = this.ledgerFor(collection)
    const found = new Set<string>()
    for (let i = 0; i < eventIds.length; i += PRUNE_PAGE_SIZE) {
      const chunk = eventIds.slice(i, i + PRUNE_PAGE_SIZE)
      if (chunk.length === 0) continue
      const rows =
        ledger !== null
          ? await ledger.getManyByIds(chunk)
          : await this.store.query.query({
              collection,
              columns: ['id'],
              filter: { whereIn: { id: [...chunk] }, limit: chunk.length },
            })
      for (const row of rows) found.add(row.id)
    }
    return found
  }

  /**
   * The GENERATION of each live event in `table` among `eventIds` — its camera
   * and its own timestamp (D694). Same throw-on-failure contract as
   * {@link existingEventIdsIn}: a quiet under-report here would let the orphan
   * audit keep treating another camera's leftovers as owned.
   */
  async eventGenerationsIn(
    table: EventOwnerType,
    eventIds: readonly string[],
  ): Promise<ReadonlyMap<string, { deviceId: number; timestamp: number }>> {
    const collection = EVENT_COLLECTION_BY_TABLE[table]
    const ledger = this.ledgerFor(collection)
    const found = new Map<string, { deviceId: number; timestamp: number }>()
    for (let i = 0; i < eventIds.length; i += PRUNE_PAGE_SIZE) {
      const chunk = eventIds.slice(i, i + PRUNE_PAGE_SIZE)
      if (chunk.length === 0) continue
      const rows =
        ledger !== null
          ? await ledger.getManyByIds(chunk)
          : await this.store.query.query({
              collection,
              columns: ['id', 'deviceId', 'timestamp'],
              filter: { whereIn: { id: [...chunk] }, limit: chunk.length },
            })
      for (const row of rows) {
        const deviceId = row.data['deviceId']
        const timestamp = row.data['timestamp']
        if (typeof deviceId !== 'number' || !Number.isFinite(deviceId)) continue
        if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue
        found.set(row.id, { deviceId, timestamp })
      }
    }
    return found
  }

  /**
   * One event's generation, or `null` when the id is not live in `table`.
   * Used by the `/o/<eventOwner>/<id>` plane ladder to scope media to the
   * current holder (D694).
   */
  async eventGenerationOf(
    table: EventOwnerType,
    eventId: string,
  ): Promise<{ deviceId: number; timestamp: number } | null> {
    const map = await this.eventGenerationsIn(table, [eventId])
    return map.get(eventId) ?? null
  }

  /**
   * The SUBSET of `eventIds` that are MOTION events specifically.
   *
   * {@link existingEventIds} answers "is this event alive", which is the
   * orphan audit's question. The media reclaim asks a narrower one: *is this
   * event-owned snapshot a MOTION-VISIT still* — because the selection shape
   * (`ownerKind: 'motion', kind: 'snapshot'`) is not itself a guarantee.
   * Nothing structurally prevents another writer landing an event-owned
   * snapshot on an object or audio row, and the reclaim must not be the place
   * that discovers it. A per-page indexed `whereIn` on one table is cheap
   * where that mistake would not be.
   *
   * THROWS on a query failure, same contract and same reason.
   */
  async existingMotionEventIds(eventIds: readonly string[]): Promise<ReadonlySet<string>> {
    return this.existingEventIdsIn('motion', eventIds)
  }

  /**
   * Delete all events for a specific device with `timestamp < cutoffMs`
   * (exclusive upper bound) across all three kinds, returning the per-kind
   * deleted counts and the flattened list of deleted ids (so the caller can
   * delete thumbnails in lockstep via `MediaStore.deleteForEvents`).
   *
   * Filter shape: `where: { deviceId }` + `whereBetween: { timestamp: [0, cutoffMs - 1] }`
   * mirrors the inclusive `[lo, hi]` range the settings-store backend uses,
   * making `cutoffMs - 1` the last timestamp that qualifies (i.e. strictly < cutoffMs).
   *
   * This method loops per kind — repeatedly querying up to `PRUNE_PAGE_SIZE`
   * rows and deleting them — until a page returns 0 rows, so ALL matching rows
   * are deleted regardless of total count. The page size is this method's own
   * bound: the sentence that used to be here credited the settings-store cap
   * with a "default row limit (~500)" it did not have (see `PRUNE_PAGE_SIZE`).
   */
  async pruneBefore(input: PruneBeforeInput): Promise<PruneBeforeResult> {
    /**
     * The filter is written ONCE and used for both halves below, so the rows
     * reported and the rows deleted cannot drift apart. Inclusive `[0, cutoff-1]`
     * → selects timestamps strictly < `cutoffMs`.
     */
    const staleForDevice: MutationFilter = {
      where: { deviceId: input.deviceId },
      whereBetween: { timestamp: [0, input.cutoffMs - 1] },
    }

    const allForDevice = async (collection: string): Promise<string[]> =>
      this.drainMatching(collection, staleForDevice)

    const [motionIds, objectIds, audioIds] = await Promise.all([
      allForDevice(MOTION_EVENTS_COLLECTION),
      allForDevice(OBJECT_EVENTS_COLLECTION),
      allForDevice(AUDIO_EVENTS_COLLECTION),
    ])

    return {
      counts: {
        motion: motionIds.length,
        object: objectIds.length,
        audio: audioIds.length,
      },
      ids: [...motionIds, ...objectIds, ...audioIds],
      byKind: { motion: motionIds, object: objectIds, audio: audioIds },
    }
  }

  /**
   * Delete every OBJECT_EVENTS_COLLECTION row for a single track and RETURN the
   * deleted event ids so the caller can delete each event's media in lockstep
   * (the whole-track delete cascade). Motion/audio collections have no
   * `trackId` column and are never touched.
   *
   * Drains a page at a time — repeatedly querying up to `PRUNE_PAGE_SIZE` rows
   * for the track and deleting them — until a page returns 0 rows, so ALL of
   * the track's events are removed regardless of count. Mirrors the drain loop
   * in `pruneBefore`, including the infinite-loop guard (a non-empty page that
   * deletes nothing stops the loop). The bound is the explicit `limit` below,
   * not a settings-store default: there was never one (see `PRUNE_PAGE_SIZE`).
   */
  async deleteByTrack(trackId: string): Promise<readonly string[]> {
    const ids: string[] = []
    for (;;) {
      const rows = await this.store.query.query({
        collection: OBJECT_EVENTS_COLLECTION,
        filter: { where: { trackId }, limit: PRUNE_PAGE_SIZE },
      })
      if (rows.length === 0) break
      let deletedInPage = 0
      for (const row of rows) {
        const id = row.id
        if (typeof id !== 'string') continue
        try {
          await this.store.delete.mutate({ collection: OBJECT_EVENTS_COLLECTION, key: id })
          ids.push(id)
          deletedInPage++
        } catch {
          /* best-effort */
        }
      }
      // If nothing was deleted from a non-empty page, all remaining deletes are
      // failing — stop to avoid spinning forever.
      if (deletedInPage === 0) break
    }
    return ids
  }

  /**
   * `TrackScopedStore` contract for the retention cascade: delete every object
   * event of the given tracks AND (folded in) the event-owned media of those
   * events, so a caller can never skip the media wipe. Motion/audio collections
   * carry no `trackId` and are untouched. Reuses the paged `deleteByTrack` drain
   * per track and is per-track ISOLATED — a failure on one track never aborts
   * the others (mirrors the best-effort contract in §4 of the design).
   */
  async deleteByTracks(trackIds: readonly string[]): Promise<readonly TrackCascadeLeafCount[]> {
    const eventIds: string[] = []
    for (const trackId of trackIds) {
      try {
        const ids = await this.deleteByTrack(trackId)
        eventIds.push(...ids)
      } catch (err) {
        this.logger.warn('EventStore.deleteByTracks: track failed', {
          meta: { trackId, error: String(err) },
        })
      }
    }
    let mediaRows = 0
    if (eventIds.length > 0 && this.media !== undefined) {
      try {
        // `deleteByTrack` only ever drains `OBJECT_EVENTS_COLLECTION` — motion
        // and audio have no `trackId` column and are never touched here — so
        // every id collected above is an OBJECT event id.
        mediaRows = await this.media.deleteForEvents({ object: eventIds })
      } catch (err) {
        this.logger.warn('EventStore.deleteByTracks: event media delete failed', {
          meta: { error: String(err) },
        })
      }
    }
    // Two families, reported APART: this leg folds in event-OWNED media, and
    // blurring them into one number loses the ability to tell "the events went
    // and the blobs did not" from "both went".
    return [
      { family: 'events', rows: eventIds.length, bytes: 0 },
      { family: 'media', rows: mediaRows, bytes: 0 },
    ]
  }

  /** D683: a fused piece's object events belong to the survivor. Event ids
   *  are unchanged, so outbox `recordId`s and event-owned media stay valid. */
  async reassignTrack(req: TrackFusionRequest): Promise<readonly TrackFusionLeafCount[]> {
    const { updated } = await this.store.updateWhere.mutate({
      collection: OBJECT_EVENTS_COLLECTION,
      filter: { where: { trackId: req.absorbedId } },
      data: { trackId: req.survivorId },
    })
    return [{ family: 'events', moved: updated, dropped: 0 }]
  }
}

// ── Slim projection helpers ──────────────────────────────────────────
// Build lightweight event objects field-by-field (no casts). Heavy
// JSON fields (regions / bbox / zones) are intentionally omitted.
// mediaUrl is left unset — Task B5 will populate it.

/** What a stored `triggeredBy` contributes to a motion event. */
interface StoredTriggeredBy {
  readonly triggeredBy?: MotionTriggeredBy
}

/** A stored trigger that parses, or nothing — never a guessed camera (D393). */
function storedTriggeredBy(raw: unknown): StoredTriggeredBy {
  if (raw === undefined) return {}
  const parsed = MotionTriggeredBySchema.safeParse(raw)
  return parsed.success ? { triggeredBy: parsed.data } : {}
}

function slimMotion(id: number, data: Record<string, unknown>): MotionEvent {
  return {
    id,
    kind: 'motion',
    deviceId: data['deviceId'] as number,
    timestamp: data['timestamp'] as number,
    regionCount: data['regionCount'] as number,
    ...storedTriggeredBy(data['triggeredBy']),
    // regions / frameWidth / frameHeight intentionally omitted (slim)
    // mediaUrl left unset — B5 will populate
  }
}

function slimObject(id: number, data: Record<string, unknown>): ObjectEvent {
  const base: ObjectEvent = {
    id,
    kind: 'object',
    deviceId: data['deviceId'] as number,
    timestamp: data['timestamp'] as number,
    className: data['className'] as string,
    // confidence / bbox / zones / state intentionally omitted (slim, heavy JSON).
    // `frameId` + `trackId` ARE kept (light strings): they are the scene/track
    // grouping keys the gallery needs (track → frame-parent → children).
    ...(typeof data['frameId'] === 'string' ? { frameId: data['frameId'] } : {}),
    ...(typeof data['trackId'] === 'string' ? { trackId: data['trackId'] } : {}),
    // `importance` is a light number — keep it in the slim projection so the
    // events page can sort without a full read.
    ...(typeof data['importance'] === 'number' ? { importance: data['importance'] } : {}),
    // mediaUrl left unset — B5 will populate
  }
  // Both tiers ride the slim projection: they are short strings and the timeline
  // feed renders `subLabel ?? label`, which cannot be evaluated from half a row.
  // The scores + attributions do NOT — they are for arguing about a value after
  // the fact, never for rendering one.
  const tiered = readTieredLabelColumns(data)
  return {
    ...base,
    ...(tiered.label !== undefined ? { label: tiered.label } : {}),
    ...(tiered.subLabel !== undefined ? { subLabel: tiered.subLabel } : {}),
  }
}

function slimAudio(id: number, data: Record<string, unknown>): AudioEvent {
  // Audio has no heavy fields to drop; slim ≈ full but routes through
  // the projection branch so B5 can attach mediaUrl in one place.
  const base: AudioEvent = {
    id,
    kind: 'audio',
    deviceId: data['deviceId'] as number,
    timestamp: data['timestamp'] as number,
    rms: data['rms'] as number,
    dbfs: data['dbfs'] as number,
    // mediaUrl left unset — B5 will populate
  }
  if (data['classification'] !== null && data['classification'] !== undefined) {
    const c = data['classification'] as {
      className: string
      score: number
      originalClass?: string
    }
    return {
      ...base,
      classification: {
        className: c.className,
        score: c.score,
        ...(typeof c.originalClass === 'string' ? { originalClass: c.originalClass } : {}),
      },
    }
  }
  return base
}

// Peak-bbox area as a fraction of the frame area, from a stored object-event
// row. Returns 0 when bbox or frame dimensions are missing/degenerate.
function bboxAreaFrac(data: Record<string, unknown>): number {
  const bbox = data['bbox']
  const fw = data['frameWidth']
  const fh = data['frameHeight']
  if (bbox === null || typeof bbox !== 'object') return 0
  if (typeof fw !== 'number' || typeof fh !== 'number' || fw <= 0 || fh <= 0) return 0
  const w = 'w' in bbox && typeof bbox.w === 'number' ? bbox.w : 0
  const h = 'h' in bbox && typeof bbox.h === 'number' ? bbox.h : 0
  if (w <= 0 || h <= 0) return 0
  return (w * h) / (fw * fh)
}

// SQLite stores nullable columns as `null`; cap output schemas use
// `z.string().optional()` (= `string | undefined`) which rejects
// `null`. Drop null entries before spreading into the cap shape.
function stripNulls(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (v !== null) out[k] = v
  }
  return out
}
