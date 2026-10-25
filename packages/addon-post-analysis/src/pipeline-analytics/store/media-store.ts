/**
 * MediaStore — unified filesystem persistence for crops, thumbnails and
 * track snapshots. Replaces three scattered systems the old addon used
 * (EventPersistenceService `events/{eventId}/`, TrackTrailService
 * `debug-trails/{trackId}/`, ThumbnailExtractor `recording_thumbnails`).
 *
 * All media lives under the CAMERA directory of the shared recordings root:
 *   <storage:eventMedia>/<deviceId>/events/<ownerKind>/<ownerId>/<kind>-<ts>.jpg
 *
 * (The `eventMedia` location resolves to the recordings root itself, so events
 * sit next to the camera's `high|mid|low` segment trees and `strips/` — one
 * per-camera subtree for everything. Migrated one-shot on 2026-07-29 from the
 * legacy `eventMedia/pipeline-analytics/<deviceId>/…` layout.)
 *
 * where:
 *   - `ownerKind` is a TABLE — `track` | `face` | `identity` | `plate` |
 *     `vehicle` | `scene` | `motion` | `object` | `audio` (D476;
 *     `event` covered the last three at once and is no longer a valid owner
 *     kind — see `@camstack/types` `media-owner-key.ts`)
 *   - `ownerId` is the row id in that table (a trackId, faceId, or — since
 *     D474 — a per-table numeric event id)
 *   - `kind` is the `MediaKind` (derived from the canonical `MediaFileKind`
 *     enum — crop / thumbnail / snapshot / firstFrame / lastFrame / fullFrame /
 *     fullFrameBoxed)
 *   - `ts` is the frame timestamp in ms
 *
 * The store tracks per-entry metadata in a typed collection
 * `pipeline-analytics:media` so retention can walk the index without
 * listing the FS, and queries by owner don't need a glob pattern.
 */

import type {
  EventMediaKindBreakdown,
  EventMediaKindFootprint,
  IScopedLogger,
  MediaFileBytes,
  MediaFileKind,
  MediaFileRef,
  SettingsStoreClient,
} from '@camstack/types'
import { EVENT_OWNER_TYPES, MediaFileKindEnum } from '@camstack/types'
import type { MediaBlobStorage } from '../location-aware-media-storage.js'
import type { MediaWriteGate } from '../media-write-gate.js'
import type { TrackCascadeLeafCount } from '../pipeline/delete-track-cascade.js'
import {
  isRowData,
  type TrackFusionLeafCount,
  type TrackFusionRequest,
  type TrackMediaOwnerKind,
} from '../pipeline/track-fusion-leaf.js'
import type { EventOwnedMediaIds } from './event-store.js'
// Value import, and safe: `retention-model.ts` imports only the `OwnerKind`
// TYPE from here, so the cycle is erased at runtime.
import {
  isRetentionExemptOwnerKind,
  RETENTION_EXEMPT_OWNER_KINDS,
} from '../retention/retention-model.js'
import { type PressureEscalation, StoragePressureTracker } from './storage-pressure.js'

/** Rows removed and on-disk bytes released by one media delete. */
export interface MediaDeleteCount {
  readonly rows: number
  readonly bytes: number
}

/** The owner a media row names. */
export interface MediaOwnerRef {
  readonly ownerKind: OwnerKind
  readonly ownerId: string
}

/** One row a bulk reclaim is considering — index columns only, never a blob. */
export interface MediaReclaimCandidate {
  readonly mediaId: number
  readonly ownerId: string
  readonly timestamp: number
  readonly sizeBytes: number
}

/** Media kinds a stored blob can be — derived from the canonical `MediaFileKind`
 *  cap enum (`@camstack/types`) so the write side never drifts from the read
 *  side. Includes the full-resolution detail images `fullFrame` (clear) +
 *  `fullFrameBoxed` (boxed). */
export type MediaKind = MediaFileKind

/**
 * `scene` is its own owner kind rather than borrowing `event`.
 *
 * Scene reference thumbnails were written as `ownerKind: 'event'` with an
 * `ownerId` of `scene-<monitorId>-…`, which resolves through
 * `resolveMediaOwner` to `{ kind: 'event', eventId: 'scene-…' }` — an event row
 * that has never existed. The orphan audit therefore classified every
 * operator-captured reference picture as collectable. It is the same class of
 * mistake `identity` and `vehicle` are exempt for: a blob the OPERATOR curated,
 * which nothing else can regenerate and no cascade owns.
 *
 * `event` was DROPPED and replaced by `motion` / `object` / `audio` (D476).
 * `event` used to cover all three event tables under one owner kind, which was
 * safe while event ids were UUIDs (unique across tables). D474 made an event
 * id a per-table SQLite rowid alias, so `event:5` stopped naming one row —
 * three different rows, one per table, can all be `5`. This is the AUTHORITY
 * on what may own media; `MEDIA_OWNER_TYPES` in
 * `@camstack/types/media/media-owner-key.ts` must cover every member here —
 * `scripts` / `__tests__/owner-kinds-authority.spec.ts` guards the two lists
 * staying married.
 */
export const OWNER_KINDS = [
  'track',
  'face',
  'identity',
  'plate',
  'vehicle',
  'scene',
  'motion',
  'object',
  'audio',
  // A notification summary MOSAIC (D480). See `SUMMARY_MOSAIC_OWNER_KIND` for
  // why it is a kind of its own and not a borrowed one.
  'mosaic',
] as const

export type OwnerKind = (typeof OWNER_KINDS)[number]

/**
 * The notification digest's group shot — a kind of its own, at last.
 *
 * `summary-producer.ts` files a mosaic under a SYNTHETIC id
 * (`summary-<ruleId>-<windowEndMs>`) that no table has ever held. It was
 * written as `ownerKind: 'event'` — which is the `scene-…` mistake this file
 * already documents two paragraphs up, verbatim, one owner kind later — and
 * D476 moved it to `'object'`, its own docblock flagging the choice as
 * pragmatic. Both are ids in a namespace the writer does not own, and the
 * consequence was measured: 675 delivered mosaics (271 MiB on camera 101, one
 * rule, growing ~27 MiB/day) that no probe could resolve and no sweep could
 * ever collect.
 *
 * A mosaic's lifetime is therefore its WRITER's business:
 * `summary-mosaic.ts` keeps the newest {@link SUMMARY_MOSAIC_MAX_PER_RULE} per
 * rule and deletes the rest through `deleteConfirmed`, exactly as
 * `boundReferences` bounds a scene's reference pictures. The orphan audit
 * resolves this kind to `writer-bounded`: it counts the rows and never has an
 * opinion about them, because there is no table to ask.
 *
 * Deliberately NOT retention-EXEMPT: an exempt kind is an enrolment product
 * and `locationForOwnerKind` files it on the gallery volume. A mosaic lives
 * where event media lives (the operator's directive), so it must stay out of
 * `RETENTION_EXEMPT_OWNER_KINDS`.
 */
export const SUMMARY_MOSAIC_OWNER_KIND = 'mosaic'

/**
 * Owner kinds whose rows are bounded by their WRITER and have no owner table.
 *
 * Three answers the audit can give a row are easy to confuse, so they are
 * separate: `exempt` (enrolment — never touched, lives on the gallery volume),
 * `writer-bounded` (this — counted, never probed, never deleted), and
 * `unresolvable` (the row does not say who owns it).
 */
const WRITER_BOUNDED_OWNER_KINDS: readonly OwnerKind[] = [SUMMARY_MOSAIC_OWNER_KIND]

/** Is this an owner kind whose writer bounds it? See {@link WRITER_BOUNDED_OWNER_KINDS}. */
export function isWriterBoundedOwnerKind(value: OwnerKind): boolean {
  return WRITER_BOUNDED_OWNER_KINDS.includes(value)
}

/** A stored blob with the camera the row names — the data plane's share
 *  scope is checked against it (`event-media-handler.ts`). */
export interface OwnedMediaFileBytes extends MediaFileBytes {
  readonly deviceId: number
}

/** The same blob as {@link OwnedMediaFileBytes} but as BYTES — what an in-process
 *  reader wants. No base64 string is ever built for it (D867). */
export interface OwnedMediaBytes {
  readonly mediaId: number
  readonly kind: MediaKind
  readonly bytes: Buffer
  readonly sizeBytes: number
  readonly timestamp: number
  readonly deviceId: number
}

/**
 * Owner kinds that NOTHING may write any more, but whose rows can still be on
 * disk from before the owning code was deleted.
 *
 * `'group'` is the co-moving group entity, removed on 2026-09-01 together with
 * `pipeline-analytics:track-groups` / `:track-group-members`
 * ([D183](../../../../../docs/decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)).
 * The tables are gone (dropped on every hub), so a group-owned
 * media row can never be claimed again: `resolveMediaOwner` maps it to
 * `{ kind: 'retired-owner' }` and the orphan audit reclaims it under the same
 * grace window and ceilings as any other orphan.
 *
 * `'summary'` is the same case one entity later: the session summary (the
 * proximity group, D489/D490) was deleted on 2026-09-29 (D680) with
 * `pipeline-analytics:summaries` / `:summary-members`. Its group shots were
 * `summary`-owned media rows; they are reclaimed the same way.
 *
 * Deliberately NOT a member of {@link OWNER_KINDS}: the type is what stops a
 * new writer, and this list is only what the READ side must still recognise.
 */
export const RETIRED_OWNER_KINDS: readonly string[] = [
  'group',
  'summary',
  /**
   * `'event'` — the owner kind D476 DROPPED, split into `motion` / `object` /
   * `audio`. The D474 migration rewrote the 299 883 rows whose event resolved;
   * what remains on the live hub is 676 rows / 271 MiB that resolve to nothing
   * (675 legacy summary mosaics filed under a synthetic id, plus one genuine
   * cascade escape). With `'event'` in neither `OWNER_KINDS` nor this list,
   * `resolveMediaOwner` answered `unresolvable` and bound #4 ("an unresolvable
   * row is left alone") made them permanently immortal — reachable and
   * unreclaimable, having been unreachable and reclaimable.
   *
   * ORDER IS LOAD-BEARING (D480): this entry is only safe because
   * {@link SUMMARY_MOSAIC_OWNER_KIND} landed FIRST and the writer no longer
   * files a mosaic under a borrowed kind. Retiring `'event'` while mosaics
   * were still being written into it would have pointed a bounded,
   * byte-deleting sweep at 271 MiB of already-delivered notification images,
   * silently.
   */
  'event',
]

/** Is this an owner kind whose owning code is gone? See {@link RETIRED_OWNER_KINDS}. */
export function isRetiredMediaOwnerKind(value: string): boolean {
  return RETIRED_OWNER_KINDS.includes(value)
}

/**
 * Narrow an arbitrary string to an `OwnerKind`.
 *
 * Exists so a caller that builds owner scopes from data (the training-export
 * plan walks `track` / `face` / `plate` / `event` as strings) can reach the
 * store without a cast. The list is derived from `OWNER_KINDS`, so a new owner
 * kind is admitted here the moment it is declared there — a hand-written value
 * list would silently reject it, which is the failure `TrackSourceSchema` was
 * already bitten by on the track row.
 */
export function isMediaOwnerKind(value: string): value is OwnerKind {
  return OWNER_KINDS.some((kind) => kind === value)
}

/**
 * WHERE a track's `thumbnail` bytes came from — the vocabulary the stand-in
 * upgrade ladder ranks (D276).
 *
 *  - `native`  — a subject-boxed cut of a native surface: the live
 *                wide-central-square capture or the close-time / late
 *                keyFrame derive. The terminal rank: never replaced by the
 *                paths below.
 *  - `raster`  — an honest sub-native SUBJECT crop (the ≤640 detection-raster
 *                zero-media fallback, the hierarchy display crop). Shows the
 *                subject, so it beats a detail stand-in — but a native cut
 *                may still replace it.
 *  - `standin` — a DETAIL crop standing in for the subject (the face-crop
 *                copy). Acceptable only while nothing better exists
 *                (operator decision, 2026-08-28): anything above replaces it.
 *
 * A row with NO provenance (every row written before the column existed)
 * ranks as `native`: the pre-column population is overwhelmingly live native
 * captures, and an upgrade path must never overwrite a row it cannot
 * classify. That choice is also what makes the fix forward-only — see D276.
 */
export const MEDIA_PROVENANCES = ['native', 'raster', 'standin'] as const
export type MediaProvenance = (typeof MEDIA_PROVENANCES)[number]

const MEDIA_PROVENANCE_RANK: Readonly<Record<MediaProvenance, number>> = {
  standin: 0,
  raster: 1,
  native: 2,
}

/** Rank of a stored row's provenance; absent (legacy row) ranks as `native`. */
export function mediaProvenanceRank(provenance: MediaProvenance | undefined): number {
  return MEDIA_PROVENANCE_RANK[provenance ?? 'native']
}

function parseMediaProvenance(value: unknown): MediaProvenance | undefined {
  return MEDIA_PROVENANCES.find((provenance) => provenance === value)
}

/** A stored media row as this addon reads it back: the STORED shape
 *  (`MediaFileBytes` — ref + bytes, never a wire shape) plus the
 *  store-internal provenance (never published on a cap output). */
export interface StoredMediaFile extends MediaFileBytes {
  readonly provenance?: MediaProvenance
}

/**
 * WHERE THE SUBJECT WAS, on the frame this row's blob shows — travelling with
 * the media instead of being paired to it afterwards (D510).
 *
 * The box is in DETECTION-frame coordinates (`frameWidth` × `frameHeight`),
 * the same space `TrackSnapshot.position.bbox` and `ParkSubject` use, because
 * the stored image is some SCALE of that frame and a consumer maps through the
 * ratio (`planSubjectView`). That is also the invariant that decides which
 * write sites may carry one:
 *
 * **A row carries a subject box only when its blob is the WHOLE frame.** A
 * crop (`thumbnail`, `crop`, `faceCrop`, `plateCrop`) is cut with a rectangle
 * that is NOT persisted — `displayCrop` derives it and keeps nothing — so a
 * frame-space box on a crop row would place the rectangle somewhere the
 * subject is not, with total confidence. No box at all is the honest answer
 * there, and the reader falls back to the snapshot pairing it already had.
 *
 * NULL on a row means exactly "this write site did not record one" — every row
 * written before the column existed, and every crop. There is no migration:
 * the column is forward-only, like `provenance` above.
 */
export interface MediaSubjectBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** The detection frame the box was measured on. */
  readonly frameWidth: number
  readonly frameHeight: number
}

/**
 * Read one back off a row. `undefined` for a NULL column, for anything that is
 * not the shape above, and for a degenerate box — a row that cannot say where
 * the subject was must read as "did not record one", never as a box at the
 * origin.
 */
export function parseMediaSubjectBox(value: unknown): MediaSubjectBox | undefined {
  const raw: unknown = typeof value === 'string' ? safeJsonParse(value) : value
  if (raw === null || typeof raw !== 'object') return undefined
  const box: Record<string, unknown> = { ...raw }
  const nums: readonly (keyof MediaSubjectBox)[] = ['x', 'y', 'w', 'h', 'frameWidth', 'frameHeight']
  for (const key of nums) {
    const n = box[key]
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
  }
  const out = {
    x: Number(box['x']),
    y: Number(box['y']),
    w: Number(box['w']),
    h: Number(box['h']),
    frameWidth: Number(box['frameWidth']),
    frameHeight: Number(box['frameHeight']),
  }
  if (out.w <= 0 || out.h <= 0 || out.frameWidth <= 0 || out.frameHeight <= 0) return undefined
  return out
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A media row that KNOWS where its subject was — index only, no blob read.
 *  See {@link MediaStore.listSubjectBoxesByOwner}. */
export interface MediaSubjectBoxRow {
  readonly mediaId: number
  readonly kind: MediaKind
  readonly timestamp: number
  readonly subjectBox: MediaSubjectBox
}

export interface MediaPutInput {
  readonly deviceId: number
  readonly ownerKind: OwnerKind
  readonly ownerId: string
  readonly kind: MediaKind
  readonly timestamp: number
  readonly data: Buffer
  /** Provenance of a `thumbnail` write (see {@link MediaProvenance}). Omitted
   *  for every other kind — and for legacy callers — the row stores NULL,
   *  which reads back as rank-`native` (never auto-replaced). */
  readonly provenance?: MediaProvenance
  /** Where the SUBJECT was on this frame — only ever set by a write site whose
   *  blob is the WHOLE frame. See {@link MediaSubjectBox}. */
  readonly subjectBox?: MediaSubjectBox
}

export interface MediaReownInput {
  readonly fromOwnerKind: OwnerKind
  readonly fromOwnerId: string
  readonly toOwnerKind: OwnerKind
  readonly toOwnerId: string
  readonly mediaId: number
}

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per blob written through put / putReplacing — a track's
 *     keyFrame, thumbnail, firstFrame and lastFrame (UPSERTED on a deterministic
 *     id, so one per track+kind however many captures race), its periodic
 *     snapshots, each event's crop and full frames, a motion visit's still
 *     (`kind: snapshot` on ownerKind event), and the buffered face/plate
 *     crops. A row is also REOWNED here (not rewritten) when the operator enrols a
 *     face or a plate, which is what moves it out of retention's reach."
 *   retention="no age sweep of its own — MediaStore.evictBefore was deleted (D59)
 *     because it aged rows out from under tracks that were still inside their own
 *     window. Rows leave with their owner: MediaStore.deleteByTracks for track and
 *     face-/plate- prefixed crops, EventStore.deleteByTracks for the event
 *     children. ownerKind 'identity' and 'vehicle' are EXEMPT forever. Anything
 *     left behind is collected by the ownership-based orphan audit — which exists
 *     because 5,598 keyFrame rows outlived their tracks."
 */
export const MEDIA_COLLECTION = 'pipeline-analytics:media'

/** Owner-id prefix for a track's buffered FACE crop. Invariant established by
 *  the face recognizer (`face-recognizer.ts`): `faceId === 'face-' + trackId`
 *  (one buffered face per track), so a track's face crops are owned by
 *  `face-<trackId>`. Used by `deleteByTracks` to derive the face crop owners of
 *  a set of tracks without a `trackId` column on media rows. */
export const FACE_MEDIA_OWNER_PREFIX = 'face-'

/** Owner-id prefix for a track's buffered PLATE crop. Invariant established by
 *  the plate recognizer (`plate-recognizer.ts`): `plateId === 'plate-' + trackId`
 *  (one buffered plate per track), so a track's plate crops are owned by
 *  `plate-<trackId>`. Used by `deleteByTracks` to derive the plate crop owners
 *  of a set of tracks without a `trackId` column on media rows. */
export const PLATE_MEDIA_OWNER_PREFIX = 'plate-'

/** Rows fetched per page when the orphan audit walks the media index. */
export const MEDIA_AUDIT_PAGE_SIZE = 500

/** Owner ids per `whereIn` chunk in {@link MediaStore.ownersWithMedia}. */
const MEDIA_PRESENCE_OWNER_CHUNK = 200

/** Index rows per page inside one presence chunk. Must stay under
 *  `SETTINGS_QUERY_DEFAULT_ROW_CAP` (2 000) so the engine's backstop can never
 *  silently truncate a page — an owner reported absent because a cap bit would
 *  DELETE a live thumbnail from the surface. */
const MEDIA_PRESENCE_PAGE_SIZE = 1_000

/**
 * Kinds that hold exactly ONE row per `(ownerKind, ownerId)` — the current
 * "best"/rolling/first artefact, never a filmstrip. Their row id + blob path are
 * DETERMINISTIC (`owner:kind`, NO timestamp) and written via an UPSERT
 * (`store.set`, atomic `INSERT … ON CONFLICT DO UPDATE`), so N concurrent
 * captures for the same `(track, kind)` all address the SAME row/blob — one can
 * never become thirteen regardless of interleaving (RC-1). Accumulating kinds
 * (`snapshot`, event `crop`/`fullFrame*`, `faceCrop`/`plateCrop`) keep their
 * per-instance timestamped id so the filmstrip / per-event / per-enrollment rows
 * still accumulate.
 */
export const SINGLE_INSTANCE_KINDS: ReadonlySet<MediaKind> = new Set<MediaKind>([
  'keyFrame',
  'keyFrameSmall',
  'thumbnail',
  'thumbnailSmall',
  'firstFrame',
  'lastFrame',
  // The clean twin of the rolling `lastFrame` (D654) — rolls with it.
  'lastSceneFrame',
])

function isSingleInstanceKind(kind: MediaKind): boolean {
  return SINGLE_INSTANCE_KINDS.has(kind)
}

/**
 * The `slotTs` value that means "THE single row for this `(owner, kind)`".
 *
 * `0`, and it is safe because it is never a real capture: a frame timestamp is
 * ms since the epoch. It is not a sentinel a reader has to know about either —
 * `slotTs` is only ever compared, never interpreted.
 *
 * Why a column at all: the uniqueness rule has two halves (one row per
 * `(owner, kind)` for {@link SINGLE_INSTANCE_KINDS}, one per
 * `(owner, kind, timestamp)` for the rest), and a UNIQUE index can express
 * exactly one. SQLite could express two with two PARTIAL indexes — and that
 * would put a second spelling of `SINGLE_INSTANCE_KINDS` inside DDL, as a
 * `kind IN (…)` predicate that nothing keeps in step with the TypeScript set.
 * Folding the rule into one derived column instead (see {@link slotTsFor})
 * leaves ONE spelling, in the one function, and one plain index over it. It is
 * also the cheaper shape: ~8 bytes a row against the ~43 a stored composite
 * key would cost (measured: `avg(length(id))` = 43.4 over 528 559 live rows).
 */
export const SINGLE_SLOT_TS = 0

/**
 * The columns that identify a write SLOT — the `ON CONFLICT` target of every
 * media write, and the columns of `idx_media_slot`.
 *
 * Declared ONCE and spread into both the index and the upsert: the two must
 * name the same columns in the same order or SQLite cannot resolve the
 * conflict target, and it says so by refusing the statement — at runtime, on
 * the first capture after a deploy.
 */
const MEDIA_SLOT_COLUMNS = ['ownerKind', 'ownerId', 'kind', 'slotTs'] as const

export const MEDIA_COLUMNS = [
  /**
   * The row's own address — an `INTEGER PRIMARY KEY`, so it IS the rowid and
   * the primary-key index ceases to exist (D482; the same move D474 made on
   * the event tables). Measured on a 2026-09-12 copy of the live hub: the
   * TEXT key's `sqlite_autoindex` was 28.0 MB over 528 559 rows.
   *
   * SQLite assigns it, which is why `put` cannot know it before the write and
   * why the store needed `upsert`.
   */
  { name: 'id', type: 'INTEGER' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'ownerKind', type: 'TEXT' as const, notNull: true },
  { name: 'ownerId', type: 'TEXT' as const, notNull: true },
  { name: 'kind', type: 'TEXT' as const, notNull: true },
  { name: 'timestamp', type: 'INTEGER' as const, notNull: true },
  /** The write SLOT's timestamp — see {@link SINGLE_SLOT_TS} / {@link slotTsFor}.
   *  Equal to `timestamp` for an accumulating kind, {@link SINGLE_SLOT_TS} for a
   *  single-instance one. Never read as a time. */
  { name: 'slotTs', type: 'INTEGER' as const, notNull: true, defaultValue: 0 },
  { name: 'path', type: 'TEXT' as const, notNull: true },
  { name: 'sizeBytes', type: 'INTEGER' as const, notNull: true },
  /** Storage location holding the blob. NULL = the default `eventMedia`
   *  location (every pre-Phase-3 row, and every write until multi-location
   *  events exist) — the relocate mover stamps real ids as it moves blobs. */
  { name: 'locationId', type: 'TEXT' as const },
  /** {@link MediaProvenance} of a `thumbnail` row. NULL = written before the
   *  column existed OR by a non-thumbnail path; reads as rank-`native`. */
  { name: 'provenance', type: 'TEXT' as const },
  /**
   * {@link MediaSubjectBox}, JSON, on a row whose blob is the WHOLE frame.
   *
   * NULL = written before the column existed, OR by a write site that cuts a
   * crop (which cannot state a frame-space box — see {@link MediaSubjectBox}),
   * OR by one that draws its own box into the pixels. No migration and none
   * possible: the box is only knowable at the instant of capture. Rows from
   * before this column keep being paired with the nearest `TrackSnapshot`,
   * exactly as they were.
   *
   * Not indexed. It is read by `(ownerKind, ownerId)` — the range
   * `idx_media_owner` already serves — and a track holds a handful of rows, so
   * an index over it would buy nothing and cost a b-tree on a table taking
   * ~92 k rows/day.
   */
  { name: 'subjectBox', type: 'TEXT' as const },
] as const

export const MEDIA_INDEXES = [
  /**
   * The write SLOT — the row's uniqueness CONSTRAINT, and the `ON CONFLICT`
   * target every media write upserts against (D482).
   *
   * This index IS the idempotence that `media.id` used to carry. Under the old
   * composite key, `buildKey` omitted the timestamp for
   * {@link SINGLE_INSTANCE_KINDS} so a re-capture produced the SAME id and
   * overwrote the one row (RC-1); the id has stopped encoding anything, so the
   * rule moved here, over the {@link slotTsFor} column. Lose this index and the
   * upsert has no target: SQLite refuses the statement outright rather than
   * inserting duplicates, which is the failure mode you want — loud, on the
   * first write.
   *
   * It leads with `(ownerKind, ownerId)`, the same prefix as
   * `idx_media_owner`, but does NOT replace it: an extra two columns of key
   * make the per-owner range scan wider for no gain, and the narrower index is
   * what `listByOwner` and `listInfoByOwner` use. (D481, read for this table:
   * a narrower index is dropped only when the wider one is MEASURED serving
   * its queries.)
   */
  { name: 'idx_media_slot', columns: MEDIA_SLOT_COLUMNS, unique: true },
  { name: 'idx_media_owner', columns: ['ownerKind', 'ownerId'] as const },
  { name: 'idx_media_device_ts', columns: ['deviceId', 'timestamp'] as const },
  /**
   * The `locationId IS NULL` seal gate — see `media-relocate-engine.ts`.
   *
   * NULLs sort FIRST in a SQLite index, so `WHERE locationId IS NULL` is a
   * contiguous range from the head of the b-tree: its cost is proportional to
   * the ANSWER, not to the table. That is the property the gate needs. The
   * question it must answer fastest is "are there none left", and with this
   * index that is one seek that immediately falls off the end of an empty
   * range — regardless of how many million stamped rows sit behind it.
   *
   * **What it costs.** One extra b-tree maintained by every insert into a
   * table taking ~92 k rows/day, and roughly 25 bytes of index per row (~30 MB
   * at 1.25 M rows). At ~1 insert/s sustained that maintenance is noise
   * against the JPEG write the same call performs. The one-off cost is real
   * and worth naming: the FIRST declare after this ships builds the index over
   * every existing row, on a recordings volume that is currently saturated —
   * expect the analytics addon's boot to stall for tens of seconds to a couple
   * of minutes, once.
   *
   * A PARTIAL index (`WHERE locationId IS NULL`) would be smaller still and
   * would cost nothing at all once sealed. It is not used because
   * `CollectionIndexSchema` has no predicate and the schema fingerprint does
   * not hash one — adding both to serve one query is a bigger change than the
   * query deserves, and the plain index already makes the gate O(log n).
   */
  { name: 'idx_media_location', columns: ['locationId'] as const },
  /**
   * The events-management footprint — `GROUP BY deviceId` and
   * `SUM(sizeBytes) WHERE deviceId = ?`. See {@link MediaStore.footprintByDevice}.
   *
   * **Why not `idx_media_device_ts`.** That index already leads with
   * `deviceId`, so it can find the range — but it does not carry `sizeBytes`,
   * so the sum has to fetch the table row behind every index entry it visits.
   * Over the whole collection that is one scattered read of the entire ~1.25 M
   * row table (`path` alone is ~80 characters per row) on the volume the
   * recorder is writing to. With `sizeBytes` in the index the planner never
   * touches the table: `SCAN … USING COVERING INDEX idx_media_device_size`.
   *
   * It has to be a NEW index rather than a third column on the existing one.
   * `declareCollection` emits `CREATE INDEX IF NOT EXISTS` keyed on the index
   * NAME, so widening `idx_media_device_ts` in place would be a silent no-op on
   * every hub that already has it — the declaration would read as done and the
   * query would still hit the table.
   *
   * **What it costs.** ~19 bytes of index per row (two integers plus the
   * rowid), so ~24 MB at 1.25 M rows, plus one more b-tree maintained by every
   * insert into a table taking ~92 k rows/day. At ~1 insert/s that maintenance
   * is noise beside the JPEG write the same call performs. The cost that is not
   * noise is the one-off: the first `declareCollection` after this ships builds
   * the index over every existing row. Do not deploy it beside a running drain
   * or seal — the same caveat `idx_media_location` carries, for the same
   * reason.
   */
  { name: 'idx_media_device_size', columns: ['deviceId', 'sizeBytes'] as const },
  /**
   * The per-KIND footprint — `COUNT(*)`/`SUM(sizeBytes) WHERE kind = ?`, and
   * the same scoped to one camera. See {@link MediaStore.footprintByKind}.
   *
   * `kind` leads no existing index, so without this each of the thirteen
   * per-kind questions is a full table scan and the breakdown costs thirteen of
   * them. With it, each kind is a contiguous covering range and the thirteen
   * together scan the index once — the cost of the whole breakdown is one pass
   * over ~36 MB of index instead of thirteen passes over the table.
   *
   * `deviceId` sits between `kind` and `sizeBytes` so the per-camera variant
   * (`WHERE kind = ? AND deviceId = ?`) stays covering too, for ~3 bytes a row
   * more than `(kind, sizeBytes)` would cost. Without it that query finds its
   * range from the index and then reads the table for every row in it.
   *
   * ~29 bytes of index per row, so ~36 MB at 1.25 M rows, and one more b-tree
   * on every insert. Same one-off caveat as the two indexes above: the first
   * declare builds it over every existing row, so do not ship it beside a
   * running drain or seal.
   */
  {
    name: 'idx_media_kind_device_size',
    columns: ['kind', 'deviceId', 'sizeBytes'] as const,
  },
  /**
   * The per-LOCATION footprint — `COUNT(*)`/`SUM(sizeBytes) WHERE locationId
   * = ?`, and the legacy `locationId IS NULL` half of the same question. See
   * {@link MediaStore.footprintByLocation} (D388) and D447.
   *
   * **Why not `idx_media_location`.** It leads with `locationId`, so it finds
   * the range — and then, exactly as the `idx_media_device_size` note above
   * describes for `deviceId`, fetches the table row behind every entry to read
   * `sizeBytes`. Every row of the store is on SOME location, so the range is
   * the table: measured 2026-09-10/11 on `hub/sqlite-settings`, 4 128–6 962 ms
   * per statement, every five minutes (the occupancy refresh), all night —
   * `plan=["SEARCH … USING INDEX idx_media_location (locationId=?)"]` on every
   * WARN. That thread is synchronous, so every configuration read in the
   * cluster queued behind it: the orchestrator's `configMs=6640` at 23:26:11
   * is this statement's 6 002 ms at 23:26:10.
   *
   * With `sizeBytes` in the index the planner never touches the table
   * (`USING COVERING INDEX idx_media_location_size`), and the seal gate keeps
   * its own narrower index. Same shape, same one-off caveat as its two
   * siblings: ~30 bytes a row, one more b-tree per insert, and the first
   * `declareCollection` after this ships builds it over every existing row —
   * do not deploy it beside a running drain or seal.
   */
  { name: 'idx_media_location_size', columns: ['locationId', 'sizeBytes'] as const },
] as const

export interface MediaStoreDeps {
  readonly storage: MediaBlobStorage
  readonly store: SettingsStoreClient
  readonly logger: IScopedLogger
  readonly writeGate?: MediaWriteGate
  /**
   * Resolves the writable `eventMedia` location a NEW footage-class blob
   * (never the exempt/gallery path — that always names `GALLERY_MEDIA_LOCATION`)
   * should land on. Absent keeps the pre-2026-08-26 behaviour: always the bare
   * `eventMedia` type ref. Injected by the addon (`media-locations.ts` +
   * `pickWritableMediaLocation`) so a location the operator marked `readOnly`
   * (drain) is never a write target.
   */
  readonly resolveEventMediaLocation?: (deviceId: number) => Promise<string>
}

/** The storage location of a media row/record: its stamped `locationId`, or
 *  the default `eventMedia` location for NULL (pre-multi-location) rows. */
export const DEFAULT_MEDIA_LOCATION = 'eventMedia'

/**
 * Where the ENROLLED gallery's bytes live — and why it is not `eventMedia`.
 *
 * `eventMedia` is declared `defaultsTo: 'recordings'`, so on every default
 * install detection crops sit inside the FOOTAGE volume. Footage is the
 * disposable class by construction: quota-capped (`maxUsedGb`), wipeable per
 * camera from the recordings UI, and replaceable with another disk.
 * `RETENTION_EXEMPT_OWNER_KINDS` meanwhile declares `identity` / `vehicle` /
 * `scene` media immortal, and every sweep in this addon honours it. (An
 * earlier version of this note also claimed "quota eviction" reached across
 * classes on a shared volume — the operator challenged that and was right:
 * `StoragePressureManager.sweep()` calls `evict({ locationId, targetBytes })`
 * per location, so eviction is scoped to a location's own class. The only
 * same-disk coupling is scheduling — a co-hosted location that already
 * relieved the disk this tick makes the other skip its turn; nobody deletes
 * the other's files.)
 *
 * Those two facts contradicted each other, and the contradiction was measured:
 * on 2026-08-17 the recordings volume was wiped and every
 * `<deviceId>/events/identity/**` blob went with it, along with the scene
 * reference photographs and the retrain dataset. 28 of 32 gallery samples lost
 * their pixels permanently — their `identity-samples` rows and their
 * `coverMediaKey` survived intact, so the gallery kept *claiming* images it no
 * longer had. Nothing reported it: the disk-wins reconcile deliberately does
 * not probe exempt owner kinds, so the exemption is precisely what stopped
 * anyone noticing the exempt bytes were already gone.
 *
 * The lesson is not "add another sweep guard" — every sweep already had one.
 * It is that **an exemption enforced only in software is void on a volume
 * whose contract is disposal.** The gallery's row lives on the data volume;
 * its blob belongs there too, and now does. See D197.
 *
 * And why it is not the addon's data dir either: from 2026-08-31 to 2026-09-04
 * the gallery was pinned to `<dataDir>/gallery` (873b73e2c). The operator's
 * rule of 2026-09-04 — *"le cartelle addons non devono trasportare nulla"* [the addons folders must not carry anything] —
 * reversed that: media in an addon dir is swept into every system backup,
 * sits on the constrained appdata disk, and is invisible to every
 * storage-location surface (occupancy, relocation, the locations UI).
 *
 * Since 2026-09-04 the gallery is the THIRD TENANT of the shared `artifacts`
 * class ("no nessuna eccezione. Rimane li in artifacts." [no, no exception. It stays there in artifacts.]): its bytes live at
 * `<artifactsRoot>/gallery/…` ({@link GALLERY_TENANT_SUBPATH}). This ref is
 * therefore no longer a declared storage class — it is the rows' PERMANENT
 * `locationId` value, which the media-storage wiring maps to the tenant
 * subtree (`storage.resolve('artifacts', 'gallery')`). Rows are deliberately
 * NEVER restamped for the move: remapping the ref instead of rewriting rows
 * is what makes a missing-count disaster (a boot that reads every enrolled
 * sample as gone and lets stage 2 delete it) unrepresentable. Retention: the
 * gallery has NONE — enrolled samples survive every sweep, and no
 * media-class retention may ever be mapped to the artifacts class (D341).
 */
export const GALLERY_MEDIA_LOCATION = 'galleryMedia'

/**
 * The gallery's tenant subtree inside the `artifacts` class root — TOP-LEVEL,
 * not inside the per-camera buckets, because an enrolled sample's lifecycle is
 * not the camera's: a camera discard removes `<deviceId>/…` operational
 * artifacts and must NEVER remove curation work that merely originated from
 * that camera. (`<deviceId>` under `gallery/` is the capture provenance the
 * rows' relativePaths already carry, bucket `0` for photo enrolment.)
 */
export const GALLERY_TENANT_SUBPATH = 'gallery'

/**
 * The location ref rows were stamped with while the gallery lived in the
 * addon data dir (2026-08-31 → 2026-09-04). No storage location of this type
 * exists, so the media-storage wiring resolves it to `<dataDir>/gallery`
 * directly — READ-side only, so pre-cutover rows keep serving pixels and the
 * boot reconcile ({@link MediaStore.relocateExemptMediaToGallery}) can move
 * them onto `galleryMedia` (copy → verify → restamp → delete source). Remove
 * this alias once no `pipeline-analytics:media` row carries it anywhere in
 * the fleet.
 */
export const LEGACY_ADDON_DATA_GALLERY_LOCATION = 'addon-data'

/**
 * The location a new blob is written to, derived from its owner kind.
 *
 * DERIVED, never a second hand-written list: the predicate is the same
 * `RETENTION_EXEMPT_OWNER_KINDS` the sweeps read, so a kind declared exempt
 * tomorrow is physically protected the same day. `gallery-media-survives-a-footage-wipe.spec.ts`
 * asserts the mapping in both directions across `OWNER_KINDS`.
 */
export function locationForOwnerKind(ownerKind: OwnerKind): string {
  return isRetentionExemptOwnerKind(ownerKind) ? GALLERY_MEDIA_LOCATION : DEFAULT_MEDIA_LOCATION
}

export function mediaRowLocation(data: Record<string, unknown> | undefined): string {
  const id = data?.['locationId']
  return typeof id === 'string' && id.length > 0 ? id : DEFAULT_MEDIA_LOCATION
}

/**
 * The row's write SLOT, in one place (D482).
 *
 * This is the ONLY expression of the two-part uniqueness rule, and everything
 * that depends on idempotence depends on this function alone:
 *
 *  - a {@link SINGLE_INSTANCE_KINDS} write slots at {@link SINGLE_SLOT_TS}, so
 *    a re-capture of the same `(owner, kind)` lands on the SAME row however
 *    many captures race (RC-1);
 *  - every other kind slots at its frame timestamp, so the filmstrip, the
 *    per-event crops and the per-enrolment samples still accumulate.
 *
 * It used to be the shape of the row's ID (`buildKey` omitted the timestamp
 * segment for a single-instance kind), which is why the id could not become a
 * surrogate until the rule had somewhere else to live.
 */
export function slotTsFor(params: Pick<MediaPutInput, 'kind' | 'timestamp'>): number {
  return isSingleInstanceKind(params.kind) ? SINGLE_SLOT_TS : params.timestamp
}

function buildPath(params: MediaPutInput): string {
  const base = `${params.deviceId}/events/${params.ownerKind}/${params.ownerId}`
  // Deterministic blob path for single-instance kinds (stable across recaptures)
  // so the overwrite reuses the SAME file; timestamped path otherwise.
  return isSingleInstanceKind(params.kind)
    ? `${base}/${params.kind}.jpg`
    : `${base}/${params.kind}-${params.timestamp}.jpg`
}

export class MediaStore {
  /** Turns repeated out-of-space write failures into ONE escalation with a
   *  count — see `storage-pressure.ts` for what five hours of silent media loss
   *  cost. */
  private readonly pressure = new StoragePressureTracker()
  /** Optional hook so the owner can ask retention to reclaim space. Left
   *  undefined by default: deciding there IS pressure and DELETING recordings
   *  are separate powers on purpose. */
  onStoragePressure?: (p: PressureEscalation) => void

  private readonly storage: MediaBlobStorage
  private readonly store: SettingsStoreClient
  private readonly logger: IScopedLogger
  private readonly writeGate: MediaWriteGate | undefined
  private readonly resolveEventMediaLocation: ((deviceId: number) => Promise<string>) | undefined

  constructor(deps: MediaStoreDeps) {
    this.storage = deps.storage
    this.store = deps.store
    this.logger = deps.logger
    this.writeGate = deps.writeGate
    this.resolveEventMediaLocation = deps.resolveEventMediaLocation
  }

  private gated<T>(mutation: () => Promise<T>): Promise<T> {
    return this.writeGate ? this.writeGate.run(mutation) : mutation()
  }

  static async declare(store: SettingsStoreClient): Promise<void> {
    await store.declareCollection.mutate({
      collection: MEDIA_COLLECTION,
      database: 'events',
      columns: [...MEDIA_COLUMNS],
      indexes: [...MEDIA_INDEXES],
    })
  }

  /** Persist a media blob and register its metadata row. Returns the row's own
   *  id (`MediaFileRef.mediaId`), which is what callers store as reference
   *  (D482) — never a key that embeds the owner. */
  async put(params: MediaPutInput): Promise<number> {
    if (this.writeGate) return this.writeGate.run(() => this.putUnchecked(params))
    return this.putUnchecked(params)
  }

  private async putUnchecked(params: MediaPutInput): Promise<number> {
    const slotTs = slotTsFor(params)
    const path = buildPath(params)
    const staticLocation = locationForOwnerKind(params.ownerKind)
    // Only the footage-class (`eventMedia`) path is readOnly-aware — the
    // gallery path always names `GALLERY_MEDIA_LOCATION` and is untouched.
    const location =
      staticLocation === DEFAULT_MEDIA_LOCATION && this.resolveEventMediaLocation
        ? await this.resolveEventMediaLocation(params.deviceId)
        : staticLocation
    const record = {
      deviceId: params.deviceId,
      ownerKind: params.ownerKind,
      ownerId: params.ownerId,
      kind: params.kind,
      timestamp: params.timestamp,
      slotTs,
      path,
      sizeBytes: params.data.length,
      // Multi-location prep (Phase 3): footage-class writes land on the default
      // location until the relocate mover moves them; NULL means exactly that.
      // An ENROLLED-gallery write NAMES its location instead — a NULL there
      // would mean "wherever eventMedia points today", and a repoint would
      // silently re-aim it at the footage volume it was moved off (D197).
      // A readOnly-drain reroute (`resolveEventMediaLocation` picked a
      // location OTHER than the type ref) also NAMES its location for the
      // same reason: a NULL row must never mean "wherever eventMedia points",
      // once that could point at the readOnly location this blob was
      // deliberately routed away from.
      locationId: location === DEFAULT_MEDIA_LOCATION ? null : location,
      provenance: params.provenance ?? null,
      // The box travels WITH the frame (D510). Stringified here and nowhere
      // else: one spelling in, one in `parseMediaSubjectBox` out.
      subjectBox: params.subjectBox === undefined ? null : JSON.stringify(params.subjectBox),
    }
    try {
      await this.storage.write({ location, relativePath: path, data: params.data })
      // ONE statement, both rules (D482): `INSERT … ON CONFLICT(slot) DO UPDATE
      // … RETURNING id`, against `idx_media_slot`. A re-capture of a
      // single-instance kind collapses onto the one row however many captures
      // race (RC-1, previously carried by a deterministic id); an accumulating
      // kind slots at its own timestamp and inserts. There is no read-then-write
      // and so no window between them, and the id comes back from the statement
      // that wrote it — the only place an auto key is knowable.
      const { id } = await this.store.upsert.mutate({
        collection: MEDIA_COLLECTION,
        conflict: [...MEDIA_SLOT_COLUMNS],
        record: { data: record },
      })
      if (typeof id !== 'number') {
        // A string here means the table in front of us is still TEXT-keyed:
        // the media collection was not rebuilt with an `INTEGER PRIMARY KEY`.
        // Refuse rather than hand back an address nothing can resolve — the
        // same discipline `EventStore` applies to its three tables (D474).
        this.logger.error('media put: collection is still TEXT-keyed — media is NOT addressable', {
          tags: { deviceId: params.deviceId },
          meta: {
            id,
            ownerKind: params.ownerKind,
            ownerId: params.ownerId,
            kind: params.kind,
            hint: 'pipeline-analytics:media must be rebuilt with an INTEGER PRIMARY KEY',
          },
        })
        throw new Error(
          `MediaStore.put: "${MEDIA_COLLECTION}" returned a TEXT id (${id}) — the table has not been rebuilt with an INTEGER PRIMARY KEY`,
        )
      }
      this.pressure.noteSuccess()
      return id
    } catch (err) {
      this.logger.warn('media put failed', {
        tags: { deviceId: params.deviceId },
        meta: {
          ownerKind: params.ownerKind,
          ownerId: params.ownerId,
          kind: params.kind,
          slotTs,
          error: String(err),
        },
      })
      // A per-key WARN is a receipt, not an alarm. On 2026-08-02 the disk filled
      // and every new track was stored with positions, a class and ZERO
      // snapshots for five hours — each loss logged, nothing saying "this
      // camera has stopped storing media". Escalate the CONDITION, once, with a
      // count and the devices it touched.
      const pressure = this.pressure.record(err, params.deviceId)
      if (pressure) {
        this.logger.error('media storage is out of space — media is being LOST', {
          tags: { deviceId: params.deviceId },
          meta: {
            failures: pressure.failures,
            devices: pressure.deviceIds,
            first: pressure.first,
            hint: 'retention prunes by age and cannot see a full disk — free space or shorten retention',
          },
        })
        this.onStoragePressure?.(pressure)
      }
      throw err
    }
  }

  /**
   * Overwrite semantics: keep exactly ONE media entry per (ownerKind, ownerId,
   * kind). Used for the rolling `lastFrame` and the best `thumbnail` per track —
   * each new capture replaces the previous one (blob + index row) rather than
   * accumulating a filmstrip the way `put` does.
   *
   * These kinds are {@link SINGLE_INSTANCE_KINDS}, so `put` writes them to the
   * single `slotTs: SINGLE_SLOT_TS` slot via an UPSERT — N concurrent racing
   * calls therefore all collapse onto the SAME row (RC-1), no query/insert/delete
   * interleaving can leave survivors. The query+delete pass below is retained
   * ONLY to reap LEGACY timestamped rows/blobs written before the slot scheme
   * (transition back-compat); once migrated it is a no-op.
   */
  async putReplacing(params: MediaPutInput): Promise<number> {
    return this.gated(() => this.putReplacingUnchecked(params))
  }

  private async putReplacingUnchecked(params: MediaPutInput): Promise<number> {
    const existing = await this.store.query.query({
      collection: MEDIA_COLLECTION,
      filter: {
        where: { ownerKind: params.ownerKind, ownerId: params.ownerId, kind: params.kind },
      },
    })
    const newId = await this.putUnchecked(params)
    for (const row of existing) {
      // `SettingsRecord.id` is the generic store's shape and stays a string
      // (D474); the comparison is against the id the write answered with.
      if (Number(row.id) === newId) continue // the upsert landed on this row
      const rowData = row.data as Record<string, unknown>
      const path = String(rowData['path'] ?? '')
      if (path) {
        try {
          await this.storage.delete({ location: mediaRowLocation(rowData), relativePath: path })
        } catch {
          /* best-effort */
        }
      }
      try {
        await this.store.delete.mutate({ collection: MEDIA_COLLECTION, key: row.id })
      } catch (err) {
        this.logger.debug('media putReplacing: stale row delete failed', {
          meta: { mediaId: row.id, error: String(err) },
        })
      }
    }
    return newId
  }

  /**
   * Promote an existing `snapshot` blob to be the track's single `lastFrame`
   * (operator "genuinely-last view" policy, see `last-frame-promotion.ts`).
   *
   * Both kinds share the SAME 960-boxed rendering, so promotion re-writes the
   * snapshot's bytes into the single-instance `lastFrame` slot (`putReplacing`,
   * which overwrites any held `lastFrame` blob + row) and then removes the
   * promoted `snapshot` row + blob — so there is exactly ONE genuinely-last view
   * and no duplicate snapshot/lastFrame pair. The `lastFrame` write lands BEFORE
   * the snapshot delete, so the view is never momentarily absent. Returns the new
   * `lastFrame` key.
   *
   * `keepSource: true` (short-track keyFrameSmall fallback, 2026-07-23): copy
   * the bytes into the `lastFrame` slot WITHOUT deleting the source row — used
   * when the source is the track's `keyFrameSmall`, which must keep serving its
   * own kind.
   */
  async promoteToLastFrame(input: {
    readonly deviceId: number
    readonly trackId: string
    readonly snapshot: MediaFileBytes
    readonly keepSource?: boolean
  }): Promise<number> {
    return this.gated(() => this.promoteToLastFrameUnchecked(input))
  }

  private async promoteToLastFrameUnchecked(input: {
    readonly deviceId: number
    readonly trackId: string
    readonly snapshot: MediaFileBytes
    readonly keepSource?: boolean
  }): Promise<number> {
    const data = Buffer.from(input.snapshot.base64, 'base64')
    const newId = await this.putReplacingUnchecked({
      deviceId: input.deviceId,
      ownerKind: 'track',
      ownerId: input.trackId,
      kind: 'lastFrame',
      timestamp: input.snapshot.timestamp,
      data,
    })
    if (input.keepSource !== true) await this.deleteByIdUnchecked(input.snapshot.mediaId)
    return newId
  }

  /**
   * Exchange the bytes+instant held in the `firstFrame` and `lastFrame` slots
   * (close-time ordering repair, see `pipeline/first-last-frame-order.ts`).
   *
   * Both are single-instance kinds, so each `putReplacing` overwrites the slot
   * it names — the two rows end up holding each other's blob and timestamp.
   * Nothing is deleted and nothing is re-encoded: both blobs are already the
   * track's own stored pixels and the only thing wrong with them is which slot
   * they sit in. The `lastFrame` write lands first so the "ultimo" tile is
   * never momentarily the older view a viewer just refuted.
   */
  async swapFirstAndLastFrame(input: {
    readonly deviceId: number
    readonly trackId: string
    readonly firstFrame: MediaFileBytes
    readonly lastFrame: MediaFileBytes
  }): Promise<void> {
    await this.gated(async () => {
      await this.putReplacingUnchecked({
        deviceId: input.deviceId,
        ownerKind: 'track',
        ownerId: input.trackId,
        kind: 'lastFrame',
        timestamp: input.firstFrame.timestamp,
        data: Buffer.from(input.firstFrame.base64, 'base64'),
      })
      await this.putReplacingUnchecked({
        deviceId: input.deviceId,
        ownerKind: 'track',
        ownerId: input.trackId,
        kind: 'firstFrame',
        timestamp: input.lastFrame.timestamp,
        data: Buffer.from(input.lastFrame.base64, 'base64'),
      })
    })
  }

  /**
   * Fetch one media entry by its OWN id (D482). Returns null if the id is not
   * in the index or if the blob is missing from storage.
   *
   * `store.get` takes a string key — that is the generic store's shape, shared
   * with every TEXT-keyed collection (D474) — and SQLite applies the column's
   * INTEGER affinity to the comparison, so `'5'` finds row 5. The conversion
   * happens HERE and nowhere else.
   */
  async getById(mediaId: number): Promise<OwnedMediaFileBytes | null> {
    const found = await this.getBytesById(mediaId)
    if (found === null) return null
    const { bytes, ...rest } = found
    return { ...rest, base64: bytes.toString('base64') }
  }

  /**
   * {@link getById} WITHOUT the base64 round trip: the blob as the storage
   * engine read it. Every in-process reader (key-frame derive, retrain and
   * export readers, face re-embed) used to take `base64` and decode it straight
   * back — a 0.4–0.8 MB string plus a second buffer per read (D867). `getById`
   * stays for the callers that cross a wire.
   */
  async getBytesById(mediaId: number): Promise<OwnedMediaBytes | null> {
    const row = await this.store.get.query({
      collection: MEDIA_COLLECTION,
      key: String(mediaId),
    })
    if (!row) return null
    const data = row as Record<string, unknown>
    const path = String(data['path'])
    const timestamp = Number(data['timestamp'])
    const sizeBytes = Number(data['sizeBytes'])
    const kind = String(data['kind']) as MediaKind
    try {
      const buf = await this.storage.read({ location: mediaRowLocation(data), relativePath: path })
      return {
        mediaId,
        kind,
        bytes: buf,
        sizeBytes,
        timestamp,
        deviceId: Number(data['deviceId']),
      }
    } catch (err) {
      // The 404 the event-media plane answers with. Silent until 2026-09-08,
      // when it took a disk walk to discover the JPEGs were on the volume all
      // along — see `listByOwner` for the same branch and the same reasoning.
      this.logger.warn('media read failed — row kept, blob not served', {
        tags: { deviceId: Number(data['deviceId']) },
        meta: { mediaId, path, location: mediaRowLocation(data), error: String(err) },
      })
      return null
    }
  }

  /**
   * Can this row's blob be SERVED? The question `getById` answers in bytes,
   * asked without fetching any.
   *
   * False covers both permanent causes — no row, and a row whose blob cannot be
   * reached (deleted, or on a storage location the row names and the cluster no
   * longer has). They are one answer here because they are one answer to the
   * viewer: the tile is blank. Which of the two it is belongs in the log line
   * above, not in a boolean.
   */
  async blobServable(mediaId: number): Promise<boolean> {
    try {
      const state = await this.referencedBlobState(mediaId)
      return state === 'exists'
    } catch {
      return false
    }
  }

  /**
   * Delete a single media entry by its own id (D482).
   * Deletes the blob from storage (best-effort) and removes the index row.
   */
  async deleteById(mediaId: number): Promise<void> {
    await this.gated(() => this.deleteByIdUnchecked(mediaId))
  }

  private async deleteByIdUnchecked(mediaId: number): Promise<void> {
    const key = String(mediaId)
    const row = await this.store.get.query({ collection: MEDIA_COLLECTION, key })
    if (!row) return
    const data = row as Record<string, unknown>
    const path = String(data['path'] ?? '')
    if (path) {
      try {
        await this.storage.delete({ location: mediaRowLocation(data), relativePath: path })
      } catch {
        /* best-effort */
      }
    }
    try {
      await this.store.delete.mutate({ collection: MEDIA_COLLECTION, key })
    } catch (err) {
      this.logger.debug('media deleteById failed', { meta: { mediaId, error: String(err) } })
    }
  }

  /**
   * Delete one row and its blob, and CONFIRM the blob is gone before the row
   * is forgotten (D148, read for this store).
   *
   * Every other delete on this class is best-effort: `deleteByIdUnchecked`
   * swallows the unlink error and drops the row anyway, and the underlying
   * `fs.rm(…, { force: true })` cannot distinguish "removed it" from "there
   * was nothing there". That is tolerable for a cascade whose whole subtree is
   * going, and it is NOT tolerable for a bulk reclaim: a row deleted while its
   * blob survives is 95 KiB that nothing will ever name again — the orphan
   * class this codebase has spent the week sweeping.
   *
   * So the order is: unlink, re-probe, and only then delete the row. A probe
   * that cannot answer (unreachable volume) THROWS, exactly like
   * {@link referencedBlobState} — the caller must refuse, not assume absence.
   *
   * A row with no `path` is a row whose blob was never written; there is
   * nothing to confirm and the row is removable.
   */
  async deleteConfirmed(mediaId: number): Promise<MediaDeleteCount> {
    const key = String(mediaId)
    return this.gated(async () => {
      const row = await this.store.get.query({ collection: MEDIA_COLLECTION, key })
      if (!row) return { rows: 0, bytes: 0 }
      const data = row as Record<string, unknown>
      const relativePath = String(data['path'] ?? '')
      const bytes = Number(data['sizeBytes'] ?? 0)
      if (relativePath.length > 0) {
        const location = mediaRowLocation(data)
        await this.storage.delete({ location, relativePath })
        if (this.storage.exists) {
          const stillThere = await this.storage.exists({ location, relativePath })
          if (stillThere) {
            throw new Error(`media blob survived its delete: ${key} (${relativePath})`)
          }
        } else {
          // No `exists` probe on this storage: prove absence the only other
          // way, by failing to read it. A read that SUCCEEDS is the failure.
          let readable = false
          try {
            await this.storage.read({ location, relativePath })
            readable = true
          } catch {
            /* unreadable === gone, which is what we asked for */
          }
          if (readable) throw new Error(`media blob survived its delete: ${key} (${relativePath})`)
        }
      }
      await this.store.delete.mutate({ collection: MEDIA_COLLECTION, key })
      return { rows: 1, bytes: Number.isFinite(bytes) ? bytes : 0 }
    })
  }

  /**
   * A page of media rows of ONE kind for ONE device, timestamp-ascending from
   * `afterMs`. The reclaim's cursor.
   *
   * `(deviceId, timestamp)` is `idx_media_device_ts`, so this is an index
   * range scan — unlike a fleet-wide `kind = 'snapshot'` predicate, which has
   * no index at all (`MEDIA_INDEXES`) and would table-scan 1.26 M rows on
   * hub-main's single synchronous SQLite thread.
   */
  async pageByKindForDevice(input: {
    readonly deviceId: number
    readonly ownerKind: OwnerKind
    readonly kind: MediaKind
    readonly afterMs: number
    readonly limit: number
  }): Promise<readonly MediaReclaimCandidate[]> {
    const rows = await this.store.query.query({
      collection: MEDIA_COLLECTION,
      columns: ['id', 'ownerId', 'timestamp', 'sizeBytes'],
      filter: {
        where: { deviceId: input.deviceId, ownerKind: input.ownerKind, kind: input.kind },
        whereBetween: { timestamp: [input.afterMs, Number.MAX_SAFE_INTEGER] },
        orderBy: { field: 'timestamp', direction: 'asc' },
        limit: input.limit,
      },
    })
    return rows.map((row) => {
      const data = row.data as Record<string, unknown>
      return {
        mediaId: Number(row.id),
        ownerId: String(data['ownerId'] ?? ''),
        timestamp: Number(data['timestamp'] ?? 0),
        sizeBytes: Number(data['sizeBytes'] ?? 0),
      }
    })
  }

  /**
   * `deviceId` is the AUTHORIZATION filter: every media row is stamped with
   * its device at write time, so scoping the query by it makes a media read
   * for a device the caller cannot name return nothing — the DB itself
   * enforces the boundary, no post-hoc ownership check to forget.
   *
   * `kinds` is the WORK filter, and it belongs here rather than on the answer.
   * Every row this returns has had its blob read off disk and base64-encoded,
   * so a caller that filters afterwards has already paid for every kind it is
   * about to discard: measured on the live hub, one track's six kinds are
   * 3 597 219 bytes and `thumbnailSmall` is 31 155 of them, and asking for the
   * small one alone cost exactly as much as asking for all six. `kind` is a
   * real column (see {@link MEDIA_COLUMNS}), so the narrowing happens in the
   * query and the blobs of the other kinds are never opened.
   *
   * Absent (or empty) means every kind — the back-compat default, and the
   * honest answer for a caller that has not decided what it needs.
   */
  async listByOwner(
    ownerKind: OwnerKind,
    ownerId: string,
    deviceId?: number,
    kinds?: readonly MediaKind[],
  ): Promise<readonly StoredMediaFile[]> {
    const rows = await this.store.query.query({
      collection: MEDIA_COLLECTION,
      filter: {
        where: deviceId === undefined ? { ownerKind, ownerId } : { ownerKind, ownerId, deviceId },
        ...(kinds !== undefined && kinds.length > 0 ? { whereIn: { kind: [...kinds] } } : {}),
        orderBy: { field: 'timestamp', direction: 'asc' },
      },
    })
    const files: StoredMediaFile[] = []
    for (const row of rows) {
      const data = row.data as Record<string, unknown>
      const path = String(data['path'])
      const timestamp = Number(data['timestamp'])
      const sizeBytes = Number(data['sizeBytes'])
      const kind = String(data['kind']) as MediaKind
      const provenance = parseMediaProvenance(data['provenance'])
      try {
        const buf = await this.storage.read({
          location: mediaRowLocation(data),
          relativePath: path,
        })
        files.push({
          mediaId: Number(row.id),
          kind,
          base64: buf.toString('base64'),
          sizeBytes,
          timestamp,
          ...(provenance !== undefined ? { provenance } : {}),
        })
      } catch (err) {
        // D391: this branch DROPS a tile the caller asked for, and the caller
        // cannot tell the difference between "no such row" and "the row is
        // there and its bytes are not" — which is how five tracks reported six
        // media each and served 404 for every one of them, with nothing in the
        // log. `deviceId` and `location` are the two facts that identify the
        // cause: a row naming a storage location that no longer resolves reads
        // exactly like a deleted blob from here.
        this.logger.warn('media read failed — row kept, blob not served', {
          tags: { deviceId: Number(data['deviceId']) },
          meta: {
            mediaId: Number(row.id),
            path,
            location: mediaRowLocation(data),
            error: String(err),
          },
        })
      }
    }
    return files
  }

  /**
   * The same rows as {@link listByOwner}, WITHOUT reading a single blob.
   *
   * This is not `listByOwner` with a field dropped — that would still read
   * every blob off disk and base64-encode it before discarding it. Measured on
   * a 140 s track: 23 files, 7.67 MB read and ~10 MB of string allocated, to
   * answer a question the index rows already contain.
   *
   * `kind`, `sizeBytes` and `timestamp` all live on the index row. Nothing is
   * persisted at track close to make this cheap, deliberately: media is written
   * throughout a track's life AND after it (late enrichment adds face/plate
   * crops), and retention deletes it later — a manifest frozen at close would
   * advertise tiles that 404 and hide ones that exist.
   */
  async listInfoByOwner(
    ownerKind: OwnerKind,
    ownerId: string,
    deviceId?: number,
  ): Promise<readonly MediaFileRef[]> {
    const rows = await this.store.query.query({
      collection: MEDIA_COLLECTION,
      filter: {
        where: deviceId === undefined ? { ownerKind, ownerId } : { ownerKind, ownerId, deviceId },
        orderBy: { field: 'timestamp', direction: 'asc' },
      },
    })
    return rows.map((row) => {
      const data = row.data as Record<string, unknown>
      return {
        mediaId: Number(row.id),
        kind: String(data['kind']) as MediaKind,
        sizeBytes: Number(data['sizeBytes']),
        timestamp: Number(data['timestamp']),
      }
    })
  }

  /**
   * The owner's media rows that KNOW where their subject was — index only, no
   * blob is opened (D510).
   *
   * Every row it returns satisfies the {@link MediaSubjectBox} invariant: its
   * blob is the whole frame and the box was recorded on THAT frame, so a
   * consumer needs no timestamp pairing at all. Rows with a NULL or unreadable
   * column are simply absent — an empty answer means "nothing here can say",
   * which is the truth about every row written before the column existed, and
   * the caller falls back to whatever it did before.
   *
   * `deviceId` is the same AUTHORIZATION filter {@link listByOwner} applies.
   */
  async listSubjectBoxesByOwner(
    ownerKind: OwnerKind,
    ownerId: string,
    deviceId?: number,
  ): Promise<readonly MediaSubjectBoxRow[]> {
    const rows = await this.store.query.query({
      collection: MEDIA_COLLECTION,
      filter: {
        where: deviceId === undefined ? { ownerKind, ownerId } : { ownerKind, ownerId, deviceId },
        orderBy: { field: 'timestamp', direction: 'asc' },
      },
    })
    const out: MediaSubjectBoxRow[] = []
    for (const row of rows) {
      const data = row.data as Record<string, unknown>
      const subjectBox = parseMediaSubjectBox(data['subjectBox'])
      if (subjectBox === undefined) continue
      out.push({
        mediaId: Number(row.id),
        kind: String(data['kind']) as MediaKind,
        timestamp: Number(data['timestamp']),
        subjectBox,
      })
    }
    return out
  }

  /**
   * Provenance of a track's stored `thumbnail`, from the index row alone (no
   * blob read). `null` = the track has no thumbnail row at all; a row with a
   * NULL column answers `native` (legacy rank — see {@link MediaProvenance}).
   *
   * This is the late-upgrade gate (D276): a caller about to replace a closed
   * track's tile asks THIS question and backs off from `native` — so a live
   * capture or an operator-era row is never overwritten by an upgrade.
   */
  async trackThumbnailProvenance(
    ownerId: string,
    deviceId?: number,
  ): Promise<MediaProvenance | null> {
    const rows = await this.store.query.query({
      collection: MEDIA_COLLECTION,
      filter: {
        where:
          deviceId === undefined
            ? { ownerKind: 'track', ownerId, kind: 'thumbnail' }
            : { ownerKind: 'track', ownerId, kind: 'thumbnail', deviceId },
        limit: 1,
      },
    })
    const row = rows[0]
    if (row === undefined) return null
    const data = row.data as Record<string, unknown>
    return parseMediaProvenance(data['provenance']) ?? 'native'
  }

  /**
   * Which of `ownerIds` hold at least ONE media row — index only, no blob is
   * opened, no base64 is allocated.
   *
   * This is the licence `videoclips` needs to publish a `thumbnail`. The
   * event-media URL is stamped from a template for every event in the system,
   * so "the plane is up" was being served as "there are bytes": 64 of one
   * camera's 179 clips pointed at a 404 on 2026-08-17.
   *
   * Batched by `whereIn` and paged by offset. NOT `listInfoByOwner` in a loop:
   * that is one query per owner, which is the N+1 this exists to prevent (and
   * `queryObjectByTrackIds` already records what believing `whereIn` was
   * unavailable cost the search path).
   *
   * `deviceId` is the AUTHORIZATION filter, exactly as in `listByOwner`.
   *
   * THROWS on a query failure rather than answering partially — a probe that
   * quietly under-reports reads as "these owners have nothing", and the caller
   * drops thumbnails that exist.
   */
  async ownersWithMedia(
    ownerKind: OwnerKind,
    ownerIds: readonly string[],
    deviceId: number,
  ): Promise<ReadonlySet<string>> {
    const found = new Set<string>()
    const unique = [...new Set(ownerIds)]
    for (let i = 0; i < unique.length; i += MEDIA_PRESENCE_OWNER_CHUNK) {
      const chunk = unique.slice(i, i + MEDIA_PRESENCE_OWNER_CHUNK)
      const answered = new Set<string>()
      for (let offset = 0; ; offset += MEDIA_PRESENCE_PAGE_SIZE) {
        const rows = await this.store.query.query({
          collection: MEDIA_COLLECTION,
          filter: {
            where: { ownerKind, deviceId },
            whereIn: { ownerId: chunk },
            orderBy: { field: 'ownerId', direction: 'asc' },
            limit: MEDIA_PRESENCE_PAGE_SIZE,
            offset,
          },
        })
        for (const row of rows) {
          const ownerId = (row.data as Record<string, unknown>)['ownerId']
          if (typeof ownerId === 'string') answered.add(ownerId)
        }
        // Short page = the chunk is exhausted. Every owner already answered =
        // the remaining pages can only repeat them.
        if (rows.length < MEDIA_PRESENCE_PAGE_SIZE || answered.size >= chunk.length) break
      }
      for (const ownerId of answered) found.add(ownerId)
    }
    return found
  }

  /**
   * Delete all media (blobs + index rows) for the given owners of one kind.
   * Best-effort per row; returns the number of index rows removed.
   */
  async deleteForOwner(ownerKind: OwnerKind, ownerIds: readonly string[]): Promise<number> {
    return (await this.gated(() => this.deleteForOwnerUnchecked(ownerKind, ownerIds))).rows
  }

  /**
   * The same delete, reporting the BYTES it released as well as the row count.
   *
   * `sizeBytes` is already on the index row, so the number costs nothing — it
   * was simply never returned, which is why every retention ops-log row this
   * addon has ever written says `bytesReclaimed: 0` (D161).
   */
  async deleteForOwnerCounted(
    ownerKind: OwnerKind,
    ownerIds: readonly string[],
    spare?: ReadonlySet<number>,
  ): Promise<MediaDeleteCount> {
    return this.gated(() => this.deleteForOwnerUnchecked(ownerKind, ownerIds, spare))
  }

  /**
   * Who owns a media row — kind and id — or `null` for an unknown id. The
   * stationary registry asks this before releasing an entry's key frame
   * (D547): the row is still `track`-owned by a track whose row is gone, and
   * only when no track row owns it is the entry the last thing vouching for it.
   */
  async ownerOf(mediaId: number): Promise<MediaOwnerRef | null> {
    const row = await this.store.get.query({ collection: MEDIA_COLLECTION, key: String(mediaId) })
    if (!row) return null
    const data = row as Record<string, unknown>
    const ownerKind = String(data['ownerKind'] ?? '')
    const ownerId = String(data['ownerId'] ?? '')
    if (!isMediaOwnerKind(ownerKind) || ownerId === '') return null
    return { ownerKind, ownerId }
  }

  private async deleteForOwnerUnchecked(
    ownerKind: OwnerKind,
    ownerIds: readonly string[],
    spare?: ReadonlySet<number>,
  ): Promise<MediaDeleteCount> {
    let rows = 0
    let bytes = 0
    for (const ownerId of ownerIds) {
      const found = await this.store.query.query({
        collection: MEDIA_COLLECTION,
        filter: { where: { ownerKind, ownerId } },
      })
      for (const row of found) {
        if (spare !== undefined && spare.has(Number(row.id))) continue
        const rowData = row.data as Record<string, unknown>
        const path = String(rowData['path'] ?? '')
        const sizeBytes = Number(rowData['sizeBytes'])
        try {
          if (path)
            await this.storage.delete({ location: mediaRowLocation(rowData), relativePath: path })
        } catch {
          /* best-effort */
        }
        try {
          await this.store.delete.mutate({ collection: MEDIA_COLLECTION, key: row.id })
          rows++
          if (Number.isFinite(sizeBytes)) bytes += sizeBytes
        } catch (err) {
          this.logger.debug('media delete-for-owner failed', {
            meta: { mediaId: Number(row.id), error: String(err) },
          })
        }
      }
    }
    return { rows, bytes }
  }

  /**
   * On-demand footprint aggregation for the events-management UI: rows and
   * summed `sizeBytes` per camera, across the whole media collection.
   *
   * ## Why this is a histogram plus one aggregate per camera
   *
   * It used to page the ENTIRE collection — `ORDER BY id LIMIT 1000 OFFSET n`,
   * no predicate — and add `sizeBytes` up in JS. SQLite honours an OFFSET by
   * stepping over `n` entries, so the walk is quadratic in the table: at the
   * live hub's 1.25 M rows that is ~1 250 round trips and ~780 M index steps,
   * with every row serialised across an RPC boundary and rebuilt in V8 to be
   * added to a number. It timed out at 60 s on every call it ever made, and it
   * is the only thing that can size the surplus-media deletion it gates.
   *
   * The answer is at most a few dozen `(deviceId, rows, bytes)` triples.
   *
   *  - The DEVICE SET comes from a histogram on `deviceId` with `bucketSize: 1`
   *    — `GROUP BY deviceId`, served from `idx_media_device_size` as a covering
   *    scan, the same trick `TrackStore.listDeviceIds` already uses (D56).
   *    `bucket` IS the deviceId: the column is INTEGER and the bucket
   *    expression is `CAST((deviceId - 0) / 1 AS INTEGER)`.
   *  - The NUMBERS come from one `aggregate` per camera — `COUNT(*)` and
   *    `SUM(sizeBytes)` in a single statement over an indexed `deviceId` range.
   *
   * Both figures for a camera come from the SAME statement deliberately. Taking
   * `rows` from the histogram and `bytes` from the aggregate would let a write
   * landing between the two produce a footprint whose row count and byte count
   * describe different populations — a disagreement an operator sizing a
   * deletion has no way to detect.
   *
   * A read that fails THROWS. It must never degrade to a zero: "this camera
   * holds nothing" is precisely the claim a failed measurement must not be
   * allowed to make to something about to delete (D295, D312).
   */
  async footprintByDevice(): Promise<Map<number, { bytes: number; rows: number }>> {
    const buckets = await this.store.histogram.query({
      collection: MEDIA_COLLECTION,
      field: 'deviceId',
      bucketSize: 1,
      origin: 0,
    })
    const out = new Map<number, { bytes: number; rows: number }>()
    for (const bucket of buckets) {
      if (bucket.count === 0 || !Number.isFinite(bucket.bucket)) continue
      const deviceId = bucket.bucket
      const agg = await this.store.aggregate.query({
        collection: MEDIA_COLLECTION,
        fields: [{ as: 'bytes', field: 'sizeBytes', op: 'sum' }],
        filter: { where: { deviceId } },
      })
      if (agg.count === 0) continue
      const bytes = agg.values['bytes']
      out.set(deviceId, { bytes: bytes ?? 0, rows: agg.count })
    }
    return out
  }

  /**
   * Bytes this store holds on each of the named storage locations (D388).
   *
   * One indexed aggregate per location (`idx_media_location`), plus one for the
   * legacy NULL-stamped rows — `locationId IS NULL` means "wherever the bare
   * `eventMedia` type ref resolves", and the CALLER attributes those, because
   * resolving a bare type ref is the orchestrator's rule and not this store's.
   *
   * A location this store holds nothing on is OMITTED, never reported as zero:
   * the difference between "we hold nothing here" and "nobody asked" is the
   * whole point of the occupancy contract, and only the caller can tell which
   * it is. A read that fails THROWS rather than degrading to zeros — the same
   * rule `footprintByDevice` follows, for the same reason.
   */
  async footprintByLocation(
    locationIds: readonly string[],
  ): Promise<{ byLocation: Map<string, number>; legacyNullBytes: number }> {
    const byLocation = new Map<string, number>()
    for (const locationId of locationIds) {
      const agg = await this.store.aggregate.query({
        collection: MEDIA_COLLECTION,
        fields: [{ as: 'bytes', field: 'sizeBytes', op: 'sum' }],
        filter: { where: { locationId } },
      })
      const bytes = agg.values['bytes'] ?? 0
      if (agg.count === 0 || bytes <= 0) continue
      byLocation.set(locationId, bytes)
    }
    const legacy = await this.store.aggregate.query({
      collection: MEDIA_COLLECTION,
      fields: [{ as: 'bytes', field: 'sizeBytes', op: 'sum' }],
      filter: { where: { locationId: null } },
    })
    return { byLocation, legacyNullBytes: legacy.count === 0 ? 0 : (legacy.values['bytes'] ?? 0) }
  }

  /**
   * The media footprint broken down by KIND — fleet-wide, or for one camera.
   *
   * `footprintByDevice` answers "how much is where"; this answers "how much is
   * WHAT", which is the axis a deletion decision turns on. The deletable set
   * (the periodic `snapshot` filmstrip, the surplus per-edge motion stills) and
   * the keep set (`firstFrame`, rolling `lastFrame`, `thumbnail` /
   * `thumbnailSmall`, `keyFrame` / `keyFrameSmall`, the face and plate buffers,
   * gallery media, the CLIP `crop`) are told apart by `kind` and by nothing
   * else. A byte total cannot size a deletion; this can.
   *
   * One `aggregate` per kind, each an indexed covering range on
   * `idx_media_kind_device_size`, plus ONE unfiltered aggregate for the totals.
   *
   * That last statement is the point of the design and not a spare round trip.
   * `MediaFileKindEnum.options` is the closed set the writers use, but the
   * TABLE is not closed: a row written by a retired path, or by a version that
   * knew a kind this one does not, matches no per-kind query. Adding the kinds
   * up to produce the total would make such a row invisible and the denominator
   * quietly too small — the failure mode that matters most here, because the
   * caller is about to delete against it. So the total is measured
   * independently and the difference is REPORTED as `unaccounted*` rather than
   * being absorbed.
   */
  async footprintByKind(deviceId?: number): Promise<EventMediaKindBreakdown> {
    const scope = deviceId === undefined ? undefined : { where: { deviceId } }
    const fields = [{ as: 'bytes', field: 'sizeBytes', op: 'sum' }] as const
    const totals = await this.store.aggregate.query({
      collection: MEDIA_COLLECTION,
      fields: [...fields],
      ...(scope === undefined ? {} : { filter: scope }),
    })
    const kinds: EventMediaKindFootprint[] = []
    let countedRows = 0
    let countedBytes = 0
    for (const kind of MediaFileKindEnum.options) {
      const agg = await this.store.aggregate.query({
        collection: MEDIA_COLLECTION,
        fields: [...fields],
        filter: { where: { kind, ...(deviceId === undefined ? {} : { deviceId }) } },
      })
      if (agg.count === 0) continue
      const bytes = agg.values['bytes'] ?? 0
      countedRows += agg.count
      countedBytes += bytes
      kinds.push({ kind, rows: agg.count, bytes })
    }
    kinds.sort((a, b) => b.bytes - a.bytes)
    const totalBytes = totals.values['bytes'] ?? 0
    return {
      totalRows: totals.count,
      totalBytes,
      kinds,
      unaccountedRows: totals.count - countedRows,
      unaccountedBytes: totalBytes - countedBytes,
    }
  }

  /** Move a single media entry from one owner to another.
   *  The new copy is written before the old one is removed.
   *  The old-entry deletion is best-effort: on failure a warning is logged
   *  and the method still returns the new key. */
  async reown(input: MediaReownInput): Promise<number> {
    return this.gated(() => this.reownUnchecked(input))
  }

  private async reownUnchecked(input: MediaReownInput): Promise<number> {
    const { fromOwnerKind, fromOwnerId, toOwnerKind, toOwnerId, mediaId } = input
    const key = String(mediaId)

    // 1. Look up the existing row by id.
    const rows = await this.store.query.query({
      collection: MEDIA_COLLECTION,
      filter: { where: { ownerKind: fromOwnerKind, ownerId: fromOwnerId } },
    })
    const row = rows.find((r) => r.id === key)
    if (!row) {
      throw new Error(`MediaStore.reown: media row not found: ${mediaId}`)
    }
    const meta = row.data as Record<string, unknown>
    const oldPath = String(meta['path'])
    const deviceId = Number(meta['deviceId'])
    const kind = String(meta['kind']) as MediaKind
    const timestamp = Number(meta['timestamp'])

    // 2. Guard: destination path must differ from source path.
    const newPath = buildPath({
      deviceId,
      ownerKind: toOwnerKind,
      ownerId: toOwnerId,
      kind,
      timestamp,
      data: Buffer.alloc(0),
    })
    if (newPath === oldPath) {
      throw new Error(`MediaStore.reown: source and destination paths are identical: ${oldPath}`)
    }

    // 3. Read the blob from the old location.
    const data = await this.storage.read({
      location: mediaRowLocation(meta),
      relativePath: oldPath,
    })

    // 4. Write to the new owner path (reuse put internals).
    const newParams: MediaPutInput = {
      deviceId,
      ownerKind: toOwnerKind,
      ownerId: toOwnerId,
      kind,
      timestamp,
      data,
    }
    const newId = await this.putUnchecked(newParams)

    // 5. Best-effort delete of the old blob + index row.
    try {
      await this.storage.delete({ location: mediaRowLocation(meta), relativePath: oldPath })
    } catch (err) {
      this.logger.warn('MediaStore.reown: old blob delete failed (best-effort)', {
        tags: { deviceId },
        meta: { mediaId, oldPath, error: String(err) },
      })
    }
    try {
      await this.store.delete.mutate({ collection: MEDIA_COLLECTION, key })
    } catch (err) {
      this.logger.warn('MediaStore.reown: old index row delete failed (best-effort)', {
        tags: { deviceId },
        meta: { mediaId, error: String(err) },
      })
    }

    return newId
  }

  /**
   * Delete event-owned media for evicted events, GROUPED by the table each id
   * came from (D476).
   *
   * There is no honest single-kind signature any more: `deleteForOwner` needs
   * ONE owner kind per call, and a flat id list can no longer say which of
   * `motion` / `object` / `audio` an id names — D474 made event ids per-table
   * rowids, so `motion:5` and `object:5` are different rows that both spell
   * `5`. Every caller (the retention cascade's per-track object-event sweep,
   * the trackless motion/audio sweep, the operator prune) already KNOWS which
   * table produced each id before it reaches here — the old flat signature
   * just threw that fact away. `ids` is a partial record so a caller supplies
   * only the kinds it actually collected.
   */
  async deleteForEvents(ids: EventOwnedMediaIds): Promise<number> {
    let total = 0
    for (const ownerType of EVENT_OWNER_TYPES) {
      const kindIds = ids[ownerType]
      if (kindIds !== undefined && kindIds.length > 0) {
        total += await this.deleteForOwner(ownerType, kindIds)
      }
    }
    return total
  }

  /** Delete all media owned by these tracks (keyFrame/snapshot/thumbnail). */
  async deleteForTracks(trackIds: readonly string[]): Promise<number> {
    return this.deleteForOwner('track', trackIds)
  }

  /**
   * `TrackScopedStore` contract for the retention cascade: delete all media
   * owned by the given tracks — the tracks' OWN media (`ownerKind:'track'`) plus
   * the UNassigned face crops (`ownerKind:'face'`, owner `face-<trackId>`).
   *
   * NEVER deletes `ownerKind:'identity'` or `ownerKind:'vehicle'` media: an
   * ENROLLED face/plate has its crop REOWNED to `identity`/`vehicle` at
   * assignment, so deleting only the `'face'`/`'plate'` owner removes unassigned
   * crops and leaves the enrolled gallery intact. Event-owned media
   * (`ownerKind:'motion'` / `'object'` / `'audio'`) is handled by `EventStore`
   * (which holds the per-kind event id sets — see {@link deleteForEvents}).
   * `deleteForOwner` is best-effort per row, so one bad row can't abort the
   * batch.
   */
  async deleteByTracks(
    trackIds: readonly string[],
    opts?: { readonly spare?: ReadonlySet<number> },
  ): Promise<readonly TrackCascadeLeafCount[]> {
    // `spare` (D547): the ONE row a stationary entry keeps when the tracks
    // that carried its evidence are disposed of at promotion. Left in place,
    // still `track`-owned; the orphan audit asks the registry before it calls
    // such a row an orphan (`keptMediaKeys`).
    const spare = opts?.spare
    const own = await this.gated(async () => {
      const tracks = await this.deleteForOwnerUnchecked('track', trackIds, spare)
      const faces = await this.deleteForOwnerUnchecked(
        'face',
        trackIds.map((id) => FACE_MEDIA_OWNER_PREFIX + id),
        spare,
      )
      return { rows: tracks.rows + faces.rows, bytes: tracks.bytes + faces.bytes }
    })
    const plates = await this.deleteForOwnerCounted(
      'plate',
      trackIds.map((id) => PLATE_MEDIA_OWNER_PREFIX + id),
      spare,
    )
    return [{ family: 'media', rows: own.rows + plates.rows, bytes: own.bytes + plates.bytes }]
  }

  /**
   * Move every enrolled-gallery blob that is still on the footage volume onto
   * {@link GALLERY_MEDIA_LOCATION}, and report what it could not save.
   *
   * Runs at boot, every boot, with no completion marker: it is a RECONCILE,
   * not a one-shot migration. Selection is by `ownerKind` over the three
   * exempt kinds — a handful of rows per install, not a scan — so an already
   * converged install costs three indexed queries and stops.
   *
   * Order per row is copy → verify → stamp → delete, so a crash anywhere
   * leaves the row pointing at bytes that exist. A row whose blob is ALREADY
   * gone is counted as `missing` here and then COLLECTED by the stage-2 sample
   * reconcile (`retention/gallery-reconcile.ts`): the operator's rule since
   * 2026-08-21 is that a reference whose blob is not on the filesystem is a
   * deleted reference — a pixel-less sample can never be re-embedded and
   * strands on every model flip (D199). This pass still reports the count,
   * per camera, so the loss is loud before it is collected.
   */
  async relocateExemptMediaToGallery(): Promise<GalleryRelocateResult> {
    let relocated = 0
    let missing = 0
    let failed = 0
    for (const ownerKind of RETENTION_EXEMPT_OWNER_KINDS) {
      const rows = await this.store.query.query({
        collection: MEDIA_COLLECTION,
        filter: { where: { ownerKind } },
      })
      for (const row of rows) {
        const data = row.data as Record<string, unknown>
        const from = mediaRowLocation(data)
        if (from === GALLERY_MEDIA_LOCATION) continue
        const relativePath = String(data['path'] ?? '')
        const deviceId = Number(data['deviceId'])
        if (relativePath.length === 0) continue

        let bytes: Buffer
        try {
          bytes = await this.storage.read({ location: from, relativePath })
        } catch (err) {
          missing += 1
          this.logger.warn(
            'enrolled gallery blob is GONE — the row keeps its embedding but has no pixels to re-embed from',
            {
              tags: { deviceId },
              meta: { mediaId: Number(row.id), ownerKind, from, relativePath, error: String(err) },
            },
          )
          continue
        }
        try {
          await this.storage.write({
            location: GALLERY_MEDIA_LOCATION,
            relativePath,
            data: bytes,
          })
          const verified = await this.storage.read({
            location: GALLERY_MEDIA_LOCATION,
            relativePath,
          })
          if (verified.length !== bytes.length) {
            throw new Error(`size mismatch after copy: ${verified.length} != ${bytes.length}`)
          }
          await this.store.set.mutate({
            collection: MEDIA_COLLECTION,
            key: row.id,
            value: { ...data, locationId: GALLERY_MEDIA_LOCATION },
          })
          relocated += 1
          try {
            await this.storage.delete({ location: from, relativePath })
          } catch (err) {
            // The copy landed and the row names it; the stale original is a
            // leak, never a loss.
            this.logger.debug('gallery relocate: old blob delete failed (best-effort)', {
              tags: { deviceId },
              meta: { mediaId: Number(row.id), from, relativePath, error: String(err) },
            })
          }
        } catch (err) {
          failed += 1
          this.logger.warn('gallery relocate failed — the blob stays on the footage volume', {
            tags: { deviceId },
            meta: { mediaId: Number(row.id), ownerKind, from, relativePath, error: String(err) },
          })
        }
      }
    }
    return { relocated, missing, failed }
  }

  /**
   * Row + filesystem state of ONE referenced blob, for the gallery reconcile.
   *
   * Three answers, and an ERROR is none of them: an unreachable volume THROWS
   * so the caller aborts, because "the probe failed" read as "missing" is the
   * exact mistake that empties a table (orphan-audit rule 3).
   */
  async referencedBlobState(mediaId: number): Promise<'exists' | 'missing-blob' | 'missing-row'> {
    const key = String(mediaId)
    const row = await this.store.get.query({ collection: MEDIA_COLLECTION, key })
    if (!row) return 'missing-row'
    const data = row as Record<string, unknown>
    const relativePath = String(data['path'] ?? '')
    if (relativePath.length === 0) return 'missing-blob'
    const location = mediaRowLocation(data)
    if (this.storage.exists) {
      return (await this.storage.exists({ location, relativePath })) ? 'exists' : 'missing-blob'
    }
    await this.storage.read({ location, relativePath })
    return 'exists'
  }

  /**
   * A stable page of ONE owner kind's media INDEX rows for the orphan audit —
   * no blobs, and the shard is the point (D480).
   *
   * It used to take no predicate and order by `id`, which put the whole
   * collection in one offset space: `track:` sorts last, the walk stopped at
   * its 20 000-row ceiling 300 000 rows short of it, and 96 % of the
   * collection was never examined. One shard per `ownerKind` over
   * `idx_media_owner` gives each owner kind its own cursor, so none can be
   * starved by another's volume.
   *
   * `ORDER BY ownerId` rather than `id` for a measured reason: with
   * `WHERE ownerKind = ?`, ordering by `ownerId` IS the index's own order
   * (`SEARCH … USING INDEX idx_media_owner`), while `ORDER BY id` adds
   * `USE TEMP B-TREE FOR ORDER BY` over the whole shard — 198 066 rows on the
   * live hub's `track` shard, rebuilt for every page, on hub-main's
   * synchronous thread.
   *
   * There is deliberately no cutoff parameter. This replaces `evictBefore`,
   * which selected media rows BY AGE and was blind to `ownerKind` — it deleted
   * enrolled `identity` crops the cascade was careful to exempt, and it deleted
   * live media belonging to a longer-retention camera unless a fleet-minimum
   * fudge factor held it back. Media has no clock of its own; it lives exactly
   * as long as its owner (D61).
   */
  async pageForAudit(
    ownerKind: string,
    offset: number,
    limit: number,
  ): Promise<readonly MediaAuditRow[]> {
    const rows = await this.store.query.query({
      collection: MEDIA_COLLECTION,
      filter: {
        where: { ownerKind },
        orderBy: { field: 'ownerId', direction: 'asc' },
        limit,
        offset,
      },
    })
    return rows.map((row) => ({
      mediaId: Number(row.id),
      data: row.data as Record<string, unknown>,
    }))
  }

  /**
   * How many rows ONE owner kind holds — the denominator the audit's coverage
   * claim needs (D480).
   *
   * `COUNT(*)` over `idx_media_owner` with `ownerKind = ?` is index-only
   * (`SEARCH … USING COVERING INDEX idx_media_owner`, measured on the live
   * hub's copy), so this is one index range and no row visits. Asked once per
   * shard per pass, on a 6-hour interval.
   */
  async countForAudit(ownerKind: string): Promise<number> {
    return this.store.count.query({
      collection: MEDIA_COLLECTION,
      filter: { where: { ownerKind } },
    })
  }

  /**
   * Rows whose `ownerKind` is NONE of `known` — the audit's unwalked residue.
   *
   * A sharded sweep walks the owner kinds this release declares. A row written
   * by a release that declared one this one does not would be walked by no
   * shard at all, which is the D480 failure with a different cause, so the
   * caller counts them and says so. A COUNT rather than a walk on purpose: the
   * predicate is a `NOT IN`, which no index serves as a range, and the count
   * is still index-only.
   */
  async countOwnerKindsOutside(known: readonly string[]): Promise<number> {
    return this.store.count.query({
      collection: MEDIA_COLLECTION,
      filter: { whereNotIn: { ownerKind: [...known] } },
    })
  }

  /**
   * A stable page of media INDEX rows for one camera — disk reconcile probes
   * these against `storage.exists` without reading a blob.
   */
  async pageForDevice(
    deviceId: number,
    offset: number,
    limit: number,
  ): Promise<readonly MediaAuditRow[]> {
    const rows = await this.store.query.query({
      collection: MEDIA_COLLECTION,
      filter: {
        where: { deviceId },
        orderBy: { field: 'id', direction: 'asc' },
        limit,
        offset,
      },
    })
    return rows.map((row) => ({
      mediaId: Number(row.id),
      data: row.data as Record<string, unknown>,
    }))
  }

  /** D683 §6.3 — which piece's single-instance row a fused track keeps. */
  private static keepAbsorbed(kind: MediaKind, bestShotFrom: 'survivor' | 'absorbed'): boolean {
    if (kind === 'firstFrame') return false
    if (kind === 'lastFrame' || kind === 'lastSceneFrame') return true
    return bestShotFrom === 'absorbed' // keyFrame, keyFrameSmall, thumbnail, thumbnailSmall
  }

  /**
   * Drop the LOSING row of a single-instance pair (review H1/L3). Deletes the
   * row record FIRST and lets a failure THROW — never swallowed — so a row
   * whose delete failed is never treated as gone while its blob is unlinked
   * out from under it (the old `deleteByIdUnchecked` order). Only once the
   * row is confirmed gone does the blob get unlinked, best-effort, and never
   * when it is the SAME `(location, path)` the row being KEPT still
   * references — a defensive check for a kept/losing pair that (through a
   * prior partial run, or stale pre-fix data) already share one path.
   */
  private async dropLosingSingleInstanceRow(
    losing: { readonly id: string; readonly data: Readonly<Record<string, unknown>> },
    kept: { readonly id: string; readonly data: Readonly<Record<string, unknown>> },
  ): Promise<void> {
    const losingPath = String(losing.data['path'] ?? '')
    const losingLocation = mediaRowLocation(losing.data)
    const keptPath = String(kept.data['path'] ?? '')
    const keptLocation = mediaRowLocation(kept.data)
    const sharesBlob =
      losingPath.length > 0 && losingPath === keptPath && losingLocation === keptLocation
    await this.store.delete.mutate({ collection: MEDIA_COLLECTION, key: losing.id })
    if (sharesBlob || losingPath.length === 0) return
    try {
      await this.storage.delete({ location: losingLocation, relativePath: losingPath })
    } catch (err) {
      this.logger.debug('fusion: losing media blob delete failed (best-effort)', {
        meta: { mediaId: losing.id, error: String(err) },
      })
    }
  }

  /**
   * Carry a single-instance row to the survivor's OWN deterministic path
   * (review H1): read the current blob (unless already read by the caller —
   * review N1, which must confirm the blob before the survivor's own row is
   * touched), write it to `track/<survivorId>/<kind>.jpg`, verify the copy,
   * then update the row — `path` and `ownerId` in the SAME statement, so the
   * row is never briefly ownerId-survivor while still pointing at the
   * absorbed path — and only THEN unlink the stale blob (best-effort; a leak,
   * never a loss). Without this, a later write under the ABSORBED id (a
   * queued capture Task 17/18 lets land after the fusion) recomputes the SAME
   * old deterministic path and silently overwrites the bytes this row still
   * named.
   *
   * A no-op relocation (accumulating kinds, or a single-instance row whose
   * path already matches) just reassigns `ownerId`, unchanged from before.
   */
  private async relocateAndReassign(
    row: { readonly id: string; readonly data: Readonly<Record<string, unknown>> },
    kind: MediaKind,
    survivorId: string,
    preReadBytes?: Buffer,
  ): Promise<void> {
    const oldPath = String(row.data['path'] ?? '')
    const location = mediaRowLocation(row.data)
    let newPath = oldPath
    if (isSingleInstanceKind(kind) && oldPath.length > 0) {
      newPath = buildPath({
        deviceId: Number(row.data['deviceId'] ?? 0),
        ownerKind: 'track',
        ownerId: survivorId,
        kind,
        timestamp: Number(row.data['timestamp'] ?? 0),
        data: Buffer.alloc(0),
      })
      if (newPath !== oldPath) {
        const bytes = preReadBytes ?? (await this.storage.read({ location, relativePath: oldPath }))
        await this.storage.write({ location, relativePath: newPath, data: bytes })
        const verified = await this.storage.read({ location, relativePath: newPath })
        if (verified.length !== bytes.length) {
          throw new Error(
            `fusion media relocate: size mismatch after copy for media ${row.id} (${oldPath} -> ${newPath})`,
          )
        }
      }
    }
    await this.store.set.mutate({
      collection: MEDIA_COLLECTION,
      key: row.id,
      value: { ...row.data, ownerId: survivorId, path: newPath },
    })
    if (newPath !== oldPath && oldPath.length > 0) {
      try {
        await this.storage.delete({ location, relativePath: oldPath })
      } catch (err) {
        this.logger.debug('fusion: stale media blob delete failed (best-effort)', {
          tags: { deviceId: Number(row.data['deviceId'] ?? 0) },
          meta: { mediaId: row.id, oldPath, error: String(err) },
        })
      }
    }
  }

  /** `TrackFusibleStore` contract for L2 fusion (D683 §6.1 invariant 4, §6.3):
   *  the absorbed piece's media moves to the survivor. Accumulating kinds move
   *  in place, keeping their ids; a single-instance kind keeps exactly one row
   *  — `keepMediaIds` (the survivor's CURRENT best shot, set at close) wins
   *  over `bestShotFrom` (decided at fusion time and possibly stale) — and its
   *  blob is RELOCATED to the survivor's own deterministic path (review H1),
   *  never left under the absorbed one where a later write can collide with
   *  it. */
  async reassignTrack(req: TrackFusionRequest): Promise<readonly TrackFusionLeafCount[]> {
    return this.gated(async () => {
      const absorbed = await this.store.query.query({
        collection: MEDIA_COLLECTION,
        filter: { where: { ownerKind: 'track', ownerId: req.absorbedId } },
      })
      let moved = 0
      let dropped = 0
      let kept = 0
      for (const row of absorbed) {
        if (!isRowData(row.data)) {
          this.logger.warn('fusion skipped a media row with non-object data', {
            tags: { deviceId: req.deviceId },
            meta: { mediaId: row.id, absorbedId: req.absorbedId, survivorId: req.survivorId },
          })
          continue
        }
        const parsed = MediaFileKindEnum.safeParse(row.data['kind'])
        if (!parsed.success) {
          this.logger.warn('fusion skipped a media row with an unknown kind', {
            tags: { deviceId: req.deviceId },
            meta: { mediaId: row.id, absorbedId: req.absorbedId, survivorId: req.survivorId },
          })
          continue
        }
        const kind = parsed.data
        const typedRow = { id: row.id, data: row.data }
        if (isSingleInstanceKind(kind)) {
          const mine = await this.store.query.query({
            collection: MEDIA_COLLECTION,
            filter: { where: { ownerKind: 'track', ownerId: req.survivorId, kind } },
          })
          const survivorRow = mine[0]
          if (survivorRow !== undefined) {
            const pinnedSurvivor = req.keepMediaIds?.has(Number(survivorRow.id)) === true
            const pinnedAbsorbed = req.keepMediaIds?.has(Number(row.id)) === true
            const keepAbsorbed =
              pinnedAbsorbed || (!pinnedSurvivor && MediaStore.keepAbsorbed(kind, req.bestShotFrom))
            if (!keepAbsorbed) {
              await this.dropLosingSingleInstanceRow(typedRow, survivorRow)
              dropped += 1
              continue
            }
            // Review P1: never drop a row on a PROBE. `storage.exists`
            // cannot tell "genuinely gone" from "location unreachable" — both
            // real providers answer `false` for an EIO/EACCES/unresolvable
            // root exactly as they do for ENOENT — so a failed read here is
            // never treated as an answer. The winning (absorbed) blob is read
            // BEFORE the survivor's row is touched; if that read fails for
            // ANY reason, NEITHER row is touched — the pair is deferred,
            // logged, and reported `kept`, for a retry (once the read would
            // succeed) or the orphan audit (D148) to resolve.
            const oldPath = String(row.data['path'] ?? '')
            let absorbedBytes: Buffer | undefined
            if (oldPath.length > 0) {
              try {
                absorbedBytes = await this.storage.read({
                  location: mediaRowLocation(row.data),
                  relativePath: oldPath,
                })
              } catch (err) {
                kept += 1
                this.logger.warn(
                  'fusion: the winning single-instance blob could not be read — deferring this pair, neither row touched',
                  {
                    tags: { deviceId: req.deviceId },
                    meta: {
                      mediaId: row.id,
                      survivorMediaId: Number(survivorRow.id),
                      kind,
                      absorbedId: req.absorbedId,
                      survivorId: req.survivorId,
                      path: oldPath,
                      reason: String(err),
                    },
                  },
                )
                continue
              }
            }
            await this.dropLosingSingleInstanceRow(survivorRow, typedRow)
            await this.relocateAndReassign(typedRow, kind, req.survivorId, absorbedBytes)
            moved += 1
            dropped += 1
            continue
          }
        }
        await this.relocateAndReassign(typedRow, kind, req.survivorId)
        moved += 1
      }
      return [{ family: 'media', moved, dropped, ...(kept > 0 ? { kept } : {}) }]
    })
  }

  /** Every row of one owner, whatever its kind — a face's crops and its D644
   *  source frames are both `ownerKind: 'face'`, keyed by the face id. */
  async moveOwner(
    ownerKind: TrackMediaOwnerKind,
    fromOwnerId: string,
    toOwnerId: string,
  ): Promise<number> {
    const { updated } = await this.store.updateWhere.mutate({
      collection: MEDIA_COLLECTION,
      filter: { where: { ownerKind, ownerId: fromOwnerId } },
      data: { ownerId: toOwnerId },
    })
    return updated
  }

  async deleteOwner(ownerKind: TrackMediaOwnerKind, ownerId: string): Promise<number> {
    return this.deleteForOwner(ownerKind, [ownerId])
  }

  /** `TrackFusionMediaPort` contract (review M2): is this media id still a
   *  live row? A carried face/plate row or CLIP vector that names a media id
   *  the media leg just DROPPED must not keep pointing at nothing — the
   *  caller repoints or clears the reference and logs why. */
  async stillPresent(mediaId: number): Promise<boolean> {
    return (await this.ownerOf(mediaId)) !== null
  }
}

/** What one gallery-relocate reconcile pass did. `missing` is the count that
 *  matters to an operator: enrolled rows whose pixels no longer exist. */
export interface GalleryRelocateResult {
  readonly relocated: number
  readonly missing: number
  readonly failed: number
}

/** An index row as the orphan audit sees it — never a blob. */
export interface MediaAuditRow {
  readonly mediaId: number
  readonly data: Record<string, unknown>
}
