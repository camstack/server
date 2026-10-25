/**
 * FaceStore — bounded recent-unassigned-faces buffer (one entry per track).
 *
 * Collection: pipeline-analytics:faces
 *
 * The `assigned` column is declared BOOLEAN — the settings-store backend
 * coerces it both ways (`true`/`false` ↔ stored `1`/`0`), so reads return a
 * real boolean. We ALSO keep a defensive `Boolean(raw.assigned)` on read so the
 * filter `.filter(f => !f.assigned)` is correct even if a backend ever surfaces
 * an integer (and harmless under the fake store's verbatim round-trip).
 *
 * Retention: a face row carries a `trackId`, so it is TRACK-OWNED and leaves
 * with its track through `deleteByTracks` in the cascade — never by age (D61,
 * `retention/retention-model.ts`). What remains here is `pruneCapOverflow`, a
 * pure CAPACITY bound over TWO disjoint per-camera tiers — rows the recognizer
 * said nothing about, and rows it put a `suggestedIdentityId` on, which get a
 * larger budget because an unanswered question must outlive a non-question.
 * Enrolled (`assigned`) rows are exempt from every one of these.
 */

import type { FaceSortDirection, FaceSortField, IScopedLogger } from '@camstack/types'
import type { TrackCascadeLeafCount } from '../pipeline/delete-track-cascade.js'
import type { TrackFusionLeafCount, TrackFusionRequest } from '../pipeline/track-fusion-leaf.js'
import type { EmbeddingConversionSpec } from './embedding-json-conversion.js'
import {
  type EmbeddingVectorIndex,
  type EmbeddingVectorScanPage,
  FACE_VECTOR_CLASS,
} from './embedding-vector-index.js'
import { rankAndCap, resolveFaceSort, sortIsServedByTimestampPaging } from './face-sort.js'
import type { EventLedgerCollection } from './event-ledger-collection.js'

/**
 * The model a row written before 2026-08-20 was produced by.
 *
 * Those rows predate `embeddingModelId`, and they were all this. The vector
 * index stamps a `modelId` on every row it holds, so a converted legacy row has
 * to be stamped with something true rather than left blank — a blank modelId in
 * the gallery is a vector the matcher cannot decide is comparable.
 */
const LEGACY_FACE_MODEL_ID = 'arcface-r100'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one UPSERT per track that produced a face detail — the id is
 *     'face-<trackId>', so a track has at most one row and the recognizer
 *     overwrites it as a better read lands (embedding, match cosine, crop keys).
 *     The row is rewritten again when the operator enrols it, which flips
 *     `assigned` and stamps the identity."
 *   retention="TRACK-OWNED and clockless (D61): unassigned rows leave with their
 *     track through FaceStore.deleteByTracks, and enrolled (`assigned`) rows are
 *     exempt from that and from every sweep — an assignment is a curation act.
 *     The only other bound is capacity: pruneCapOverflow holds each camera's
 *     UNASSIGNED buffer to bufferMaxPerDevice newest rows (default 50), plus a
 *     SEPARATE, larger budget of deriveSuggestedBufferCap(bufferMaxPerDevice)
 *     rows (default 200) for rows carrying a suggestedIdentityId — a question
 *     the operator has not answered outlives a row nobody asked about, and
 *     evicting one is logged with its deviceId. At 10.8 KB of JSON embedding
 *     per row, those caps are what keep the table small."
 */
export const FACES_COLLECTION = 'pipeline-analytics:faces'

/**
 * Rows per page for `pruneCapOverflow`, the ONE remaining walk of this
 * collection.
 *
 * It is a walk that DOES WORK: the capacity bound has to consider every row to
 * decide which ones leave, and it runs on the maintenance pass, not on a
 * request. That is the shape D320 permits. What it must not do is drag the
 * whole row across for four scalars — see the projection there.
 *
 * The two READS that used to page here do not any more. They asked a question
 * ("the newest N faces that are still unassigned"), the question is a
 * predicate, and a predicate answers it in one statement whose cost is the
 * ANSWER rather than the table.
 *
 * The engine refuses an unbounded read (`query-bounds.ts`) and truncates a
 * limitless one at `SETTINGS_QUERY_DEFAULT_ROW_CAP` with a WARN nobody can act
 * on, so every read below carries an explicit `limit`.
 */
export const FACE_SWEEP_PAGE = 1_000

/**
 * The widest window a single gallery read may materialise before it REFUSES.
 *
 * It bounds only the reads whose size the CALLER did not name: an unbounded
 * `listAllRecentFaces`, and the `suggestionConfidence` order, which cannot stop
 * early because the most certain suggestion may be the oldest row (`face-sort.ts`).
 * A caller's own `limit` is honoured verbatim at any table size — asking for
 * 500 and getting 500 is being served, not being truncated.
 *
 * 10 000 because that is above what `pruneCapOverflow` actually permits to
 * exist: 29 cameras × (50 ordinary + 200 suggested) = 7 250 unassigned rows,
 * plus whatever the operator has enrolled. It sits under the engine's
 * `SETTINGS_QUERY_HARD_ROW_CAP` (20 000) so the engine never truncates first —
 * this bound is the one that speaks, and it speaks by throwing.
 *
 * The alternative was to answer with the rows it managed to read. A short list
 * and a complete one are the same array, and a gallery that quietly stops
 * showing a face is exactly the failure this whole change exists to avoid.
 */
export const FACE_WINDOW_MAX_ROWS = 10_000

/**
 * A gallery read whose window is wider than {@link FACE_WINDOW_MAX_ROWS}.
 *
 * Distinct type so a router can map it to a 400 and an operator can be told
 * *"the buffer is too large to rank in one pass — narrow the window"* instead
 * of being shown a page that silently lost its tail.
 */
export class FaceWindowTooWideError extends Error {
  constructor(rows: number) {
    super(
      `face window exceeds ${String(FACE_WINDOW_MAX_ROWS)} rows (read ${String(rows)}) — refusing to answer with the part that fit; narrow with deviceIds / since / until, or pass an explicit limit`,
    )
    this.name = 'FaceWindowTooWideError'
  }
}

/** How many evicted face ids one per-camera eviction line names before it
 *  stops — enough to find the rows, not enough to turn a log line into a page. */
const SUGGESTED_EVICTION_IDS_LOGGED = 10

/**
 * The row shape `pruneCapOverflow` reads. An index signature over `unknown`
 * rather than a cast: the store returns untyped rows at a documented boundary,
 * and every field below is narrowed at the point of use.
 */
export interface FaceCapRowFields {
  readonly [column: string]: unknown
}

/** One buffered row reduced to what the capacity decision needs. */
interface FaceCapCandidate {
  readonly id: string
  readonly timestamp: number
  /** The recognizer offered an identity for this row and nobody has answered. */
  readonly suggested: boolean
}

/** The two disjoint per-camera budgets of the unassigned buffer. */
export interface FaceCapOverflowInput {
  /** Rows the recognizer said nothing about. */
  readonly maxPerDevice: number
  /** Rows carrying a `suggestedIdentityId`. See `deriveSuggestedBufferCap`. */
  readonly maxSuggestedPerDevice: number
}

/**
 * A stored suggestion is present. The relational backend surfaces an unset
 * column as SQL NULL and the fake store as `undefined`; an empty string is
 * neither an identity nor a question, so it is not a suggestion either.
 */
function hasSuggestion(raw: unknown): boolean {
  return typeof raw === 'string' && raw.length > 0
}

/**
 * Refuses to loop forever if a page ever fails to advance. 1 000 pages is a
 * million faces — far past anything real, and reached only by a bug.
 */
const FACE_SWEEP_MAX_PAGES = 1_000

export const FACE_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'trackId', type: 'TEXT' as const, notNull: true },
  { name: 'timestamp', type: 'INTEGER' as const, notNull: true },
  /**
   * LEGACY, drained on 2026-08-30 (D304). The ArcFace vector lives in the
   * `face-arcface` vector index now, keyed by this row's id.
   *
   * The column stays declared and stays `notNull` because rows written before
   * the conversion still carry their array and the conversion has to be able to
   * read them. A CONVERTED row holds `[]` — two bytes, and the marker that says
   * "the vector is in the index", which is what makes the conversion idempotent
   * and observable. Nothing reads this column except the conversion and the
   * fallback in {@link FaceStore.getWithEmbedding}.
   */
  { name: 'embedding', type: 'JSON' as const, notNull: true },
  // The model that produced `embedding`. Enrolment reads it to stamp the
  // identity sample truthfully — before this column existed, `assignFace`
  // stamped a hardcoded 'arcface-r100' on whatever the pipeline had actually
  // run, which would have filled the gallery with mislabelled vectors the
  // instant the face model changed. Additive nullable; legacy rows read back
  // undefined and fall back to that same constant.
  { name: 'embeddingModelId', type: 'TEXT' as const },
  { name: 'mediaId', type: 'INTEGER' as const },
  { name: 'recognizedIdentityId', type: 'TEXT' as const },
  { name: 'assigned', type: 'BOOLEAN' as const, notNull: true },
  { name: 'assignedSampleId', type: 'TEXT' as const },
  // Design B: the track's native key frame + the face bbox on it, so a detail
  // view can draw the box over the native frame (see FaceInfo).
  { name: 'keyFrameMediaId', type: 'INTEGER' as const },
  { name: 'faceBbox', type: 'JSON' as const },
  // Face-quality auditability (2026-07-23): the winning identity-match cosine
  // and the native-scale face short side (px) at recognition time, so a
  // per-face confidence + resolution is recoverable off the persisted row.
  { name: 'bestMatchScore', type: 'REAL' as const },
  { name: 'nativeFaceShortSidePx', type: 'REAL' as const },
  // Suggested-assignment tier (2026-07-24): a plausible-but-not-confident match
  // that MISSED auto-assignment. Never an assignment (recognizedIdentityId stays
  // unset); the UI offers a one-tap confirm. Additive nullable; legacy rows read
  // back undefined.
  { name: 'suggestedIdentityId', type: 'TEXT' as const },
  { name: 'suggestedMatchScore', type: 'REAL' as const },
  // The FULL source frame the face was detected on (D644): a `face`-owned
  // `fullFrame` blob, stored once per frame and shared by the faces of that
  // frame, plus the face's box and five landmarks in THAT blob's pixel space.
  // It is what lets a future alignment re-derive the template exactly. Moves
  // to the identity with the crop on enrolment. Additive nullable.
  { name: 'sourceFrameMediaId', type: 'INTEGER' as const },
  { name: 'sourceFrameBbox', type: 'JSON' as const },
  { name: 'sourceFrameLandmarks', type: 'JSON' as const },
] as const

/**
 * The columns a {@link Face} is built from — every declared column EXCEPT the
 * drained legacy `embedding`, derived mechanically so a column added tomorrow
 * arrives without anyone remembering this list.
 *
 * Mechanical on purpose. A hand-written projection is how a field silently
 * stops arriving: the row comes back missing the key, `rowToFace` reads
 * `undefined`, and "the database says nothing" is indistinguishable from "I did
 * not ask". The engine REFUSES a column it cannot serve
 * (`resolveProjection`) — the projection is the one part of a query that is not
 * allowed to be forgiving — so a stale name here is a throw, not a wrong value.
 *
 * `embedding` is the only exclusion, and it is the whole reason to project:
 * it is a `notNull` JSON column on the widest row shape in the database, it is
 * dropped by `rowToFace` on arrival, and {@link Face} has no field for it. A
 * caller that wants floats asks by name ({@link FaceStore.getWithEmbedding},
 * {@link FaceStore.loadEmbeddings}). Since D304 drained it to `[]` the saving
 * is small — 23 B/row, measured on the live hub — but the column is still
 * declared, still `notNull`, and an unconverted row still carries ~10.8 KB of
 * it. Projecting is what keeps that a fact about ONE row rather than about
 * every gallery poll.
 */
export const FACE_LIST_COLUMNS: readonly string[] = FACE_COLUMNS.map((c) => c.name).filter(
  (name) => name !== 'embedding' && name !== 'id',
)

/**
 * The four scalars `pruneCapOverflow` decides on.
 *
 * Its docblock has always said *"only four scalars per row survive the page"*.
 * They survived the PAGE; the query still dragged every column — the embedding
 * included — across the RPC boundary and through V8 first. A leftover that
 * describes the right design reads as verification, so the projection now makes
 * the sentence true.
 */
const FACE_CAP_COLUMNS: readonly string[] = [
  'deviceId',
  'timestamp',
  'assigned',
  'suggestedIdentityId',
]

/** One camera reference per identity — see {@link FaceStore.listCameraRefsForIdentity}. */
const FACE_REF_COLUMNS: readonly string[] = ['deviceId']

/**
 * A buffered face row WITHOUT its vector.
 *
 * The vector is deliberately not a field. It used to be, and the read that
 * dominated this store's cost was a gallery poll that materialised 10.8 KB of
 * JSON floats per row to render tiles whose output schema has no embedding
 * field at all — roughly 11 MB every 30 seconds, per open tab. Removing the
 * field rather than leaving it empty is the point: an empty array is a value a
 * clustering pass would silently treat as "no faces to cluster", and this repo
 * has already shipped that bug once. A caller that needs floats asks for them
 * by name — {@link FaceStore.getWithEmbedding} or {@link FaceStore.loadEmbeddings}.
 */
export interface Face {
  readonly id: string
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  /** Model that produced the row's vector. Absent on rows written before
   *  2026-08-20 — enrolment falls back to `arcface-r100`, what they all were. */
  readonly embeddingModelId?: string
  readonly mediaId?: number
  readonly recognizedIdentityId?: string
  readonly assigned: boolean
  readonly assignedSampleId?: string
  /** Design B: MediaStore row id of the track's native key frame. */
  readonly keyFrameMediaId?: number
  /** Design B: the face bbox (pixel space) on the key frame. */
  readonly faceBbox?: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
  /** Winning identity-match cosine (0..1) for the track's assigned identity, or
   *  undefined when no identity was ever auto-confirmed. Additive (2026-07-23);
   *  absent on legacy rows. */
  readonly bestMatchScore?: number
  /** Native-scale face short side (px) at recognition time, when the runner
   *  measured it. Additive (2026-07-23); absent on legacy rows / runners that
   *  reported no native measure. */
  readonly nativeFaceShortSidePx?: number
  /** SUGGESTED identity for the track — a plausible match that MISSED auto-
   *  assignment (suggestion cosine band, or above threshold but below the
   *  recognition size floor). Mutually exclusive with `recognizedIdentityId`:
   *  the row stays UNASSIGNED. Additive (2026-07-24); absent on legacy rows and
   *  on assigned / below-band faces. */
  readonly suggestedIdentityId?: string
  /** Peak identity-match cosine (0..1) for `suggestedIdentityId`. Present iff
   *  `suggestedIdentityId` is. Additive (2026-07-24). */
  readonly suggestedMatchScore?: number
  /** The full frame the face was detected on (D644). See FACE_COLUMNS. */
  readonly sourceFrameMediaId?: number
  /** The face's box in `sourceFrameMediaId`'s pixel space. */
  readonly sourceFrameBbox?: FaceFrameBox
  /** The five landmarks in `sourceFrameMediaId`'s pixel space, when the runner sent them. */
  readonly sourceFrameLandmarks?: readonly FacePoint[]
}

/** A pixel-space rectangle on a stored frame. */
export interface FaceFrameBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A pixel-space point on a stored frame. */
export interface FacePoint {
  readonly x: number
  readonly y: number
}

/**
 * A face row PLUS its ArcFace vector — the write shape, and the read shape of
 * the one caller that needs floats.
 *
 * `embedding` is required, not optional: a face with no vector is not a face
 * this store has any use for, and an optional field would let the write path
 * skip the index without anything noticing.
 */
export interface FaceRecord extends Face {
  readonly embedding: readonly number[]
}

/** The four gallery views over the buffer. See `listAllRecentFaces`. */
export type FaceListFilter = 'unassigned' | 'recognized' | 'identified' | 'all'

/** The predicate half of a gallery view, as the store's filter surface names it. */
export interface FaceFilterPredicate {
  readonly where?: Readonly<Record<string, unknown>>
  readonly whereNot?: Readonly<Record<string, unknown>>
}

/**
 * A gallery view as a STORE PREDICATE.
 *
 * Every one of the four is expressible, and that is the whole finding behind
 * this change. They were applied in JS, over pages the store had already
 * chosen, which is why `limit` counted rows that PASSED and the read had to
 * sweep until enough had: with `filter: 'unassigned'` the newest N rows may be
 * entirely assigned while matches wait just beyond them. Pushed down, `limit`
 * IS the store's limit, and the sweep has nothing left to do.
 *
 * **Two of them mean "has an identity", and the answer is a stored bit.** A records
 * `where` has no `IS NOT NULL`, so `whereNot { recognizedIdentityId: null }` could only
 * be a residual predicate over a wider page — rows read and then thrown away, and (before
 * D312) a predicate that silently matched nothing. The faces ledger therefore derives a
 * boolean `recognized` from every write that touches `recognizedIdentityId`
 * (`face-recognized.ts`), and the views are plain ranges over the `recognized_ts` /
 * `assigned_recognized_ts` indexes. Rows written before the field existed were
 * backfilled offline on the operator hubs on 2026-10-22 (the one-shot script is deleted).
 *
 * `assigned` is `BOOLEAN NOT NULL`; the backend serialises `false` to `0` at
 * the bind (`serializeColumnValue`) and decodes `0` back to `false` on read, so
 * plain equality is correct and no null semantics are involved.
 */
function faceFilterPredicate(filter: FaceListFilter): FaceFilterPredicate {
  switch (filter) {
    case 'unassigned':
      return { where: { assigned: false } }
    case 'recognized':
      return { where: { assigned: false, recognized: true } }
    case 'identified':
      return { where: { recognized: true } }
    case 'all':
      return {}
  }
}

export interface ListAllRecentFacesInput {
  /**
   * Cameras to read. `undefined` = the whole cluster; **`[]` = nothing at
   * all** — a request for no devices is a request, not an omission (the
   * `deviceManager.listFleet` contract).
   */
  readonly deviceIds?: readonly number[]
  /** Rows to RETURN, counted after {@link filter}. Never rows read. */
  readonly limit?: number
  readonly filter?: FaceListFilter
  /** Inclusive lower bound on `timestamp`. */
  readonly since?: number
  /** Inclusive upper bound on `timestamp`. */
  readonly until?: number
  readonly sortBy?: FaceSortField
  readonly sortDirection?: FaceSortDirection
}

/**
 * `since` / `until` as a store predicate.
 *
 * The filter surface has exactly one range form, `whereBetween`, and it is
 * inclusive on both ends — so a one-sided window is expressed by pinning the
 * other end to the edge of the safe integer range rather than by omitting it.
 * Returns `{}` when the caller named no window, so the read stays exactly the
 * unwindowed one.
 */
function buildTimestampWindow(input: { readonly since?: number; readonly until?: number }): {
  readonly whereBetween?: Record<string, [number, number]>
} {
  if (input.since === undefined && input.until === undefined) return {}
  return {
    whereBetween: {
      timestamp: [input.since ?? Number.MIN_SAFE_INTEGER, input.until ?? Number.MAX_SAFE_INTEGER],
    },
  }
}

/**
 * One stored row → one {@link Face}.
 *
 * The single documented type boundary of this store: `SettingsRecord.data` is
 * `Record<string, unknown>` on the wire and the column set is declared right
 * here in {@link FACE_COLUMNS}, so this is the one place allowed to name the
 * shape it wrote.
 *
 * It also owns the NULL normalisation, and that is not cosmetic: the relational
 * backend surfaces an unset optional column as SQL NULL, and `FaceInfo`'s
 * optional strings REJECT null — an un-normalised row fails
 * `faceGallery.listRecentFaces` output validation and the People page renders
 * empty. This used to be copied out three times, which is three chances to
 * forget the next additive column.
 */
function rowToFace(id: string, raw: unknown): Face {
  const data = raw as Omit<Face, 'id'> & {
    /** The drained legacy column. Read by the conversion and the fallback only. */
    embedding?: unknown
    /** The stored bit derived from `recognizedIdentityId`. */
    recognized?: boolean
    embeddingModelId?: string | null
    recognizedIdentityId?: string | null
    mediaId?: number | null
    assignedSampleId?: string | null
    keyFrameMediaId?: number | null
    faceBbox?: Face['faceBbox'] | null
    bestMatchScore?: number | null
    nativeFaceShortSidePx?: number | null
    suggestedIdentityId?: string | null
    suggestedMatchScore?: number | null
    sourceFrameMediaId?: number | null
    sourceFrameBbox?: FaceFrameBox | null
    sourceFrameLandmarks?: readonly FacePoint[] | null
  }
  // `embedding` is dropped here rather than passed through: the legacy column
  // is not part of {@link Face}, and spreading it back on would put an
  // untyped 10.8 KB string on a shape whose whole point is not carrying one.
  // `recognized` is the stored index bit derived from the identity (face-recognized.ts); the
  // identity itself is the fact a caller reads, so the bit is not part of {@link Face}.
  const { embedding: _legacyEmbedding, recognized: _recognized, ...rest } = data
  return {
    ...rest,
    id,
    // `embeddingModelId` was the one nullable column this normalisation
    // forgot, and it leaked SQL NULL into a field typed `string | undefined`
    // on every row written before 2026-08-20 — confirmed on a live row. The
    // test that pins "no own property holds null" could not see it: the fake
    // OMITTED the key for a column the seed never wrote, where the engine
    // SELECTs it and hands back NULL. Projecting the read made the fake model
    // the column, which is what exposed this.
    embeddingModelId: data.embeddingModelId ?? undefined,
    // Defensive: the backend declares `assigned` BOOLEAN and coerces both ways,
    // but an integer 0/1 leaking through would invert every filter.
    assigned: Boolean(data.assigned),
    mediaId: data.mediaId ?? undefined,
    recognizedIdentityId: data.recognizedIdentityId ?? undefined,
    assignedSampleId: data.assignedSampleId ?? undefined,
    keyFrameMediaId: data.keyFrameMediaId ?? undefined,
    faceBbox: data.faceBbox ?? undefined,
    bestMatchScore: data.bestMatchScore ?? undefined,
    nativeFaceShortSidePx: data.nativeFaceShortSidePx ?? undefined,
    suggestedIdentityId: data.suggestedIdentityId ?? undefined,
    suggestedMatchScore: data.suggestedMatchScore ?? undefined,
    sourceFrameMediaId: data.sourceFrameMediaId ?? undefined,
    sourceFrameBbox: data.sourceFrameBbox ?? undefined,
    sourceFrameLandmarks: data.sourceFrameLandmarks ?? undefined,
  }
}

/** What {@link FaceStore.repointSample} writes. */
export interface FaceSampleRepoint {
  readonly sampleId: string
  /** The new template, when the face's crop was the old one. */
  readonly mediaId?: number
}

/** A buffered face nobody has named — see {@link FaceStore.listPendingFaces}. */
export interface PendingFaceRow {
  readonly faceId: string
  readonly deviceId: number
}

/** A buffered face that names an enrolled sample, and the crop it holds. */
export interface FaceSampleRef {
  readonly faceId: string
  readonly mediaId?: number
  /** The source frame the face names — shared with the sample after enrolment (D644). */
  readonly sourceFrameMediaId?: number
}

/** What a face loses when the sample it was enrolled as goes away. */
export interface FaceDetachClears {
  /** The crop left with the sample (it WAS the sample's template). */
  readonly media: boolean
  /** The source frame left with the sample (it WAS the sample's source). */
  readonly sourceFrame: boolean
}

/**
 * A face patch: every column of {@link Face} bar its id, with the nullable
 * media references also accepting `null` to CLEAR them (D482).
 *
 * `assignPlate`'s twin on the plate side carries the same note: clearing a
 * reference whose blob was just deleted used to be written at the call site as
 * a `null` double-cast through `unknown` to `string`, a cast that stopped being
 * even nominally true when the column became a number. The type can simply say
 * it.
 */
export type FaceColumnPatch = Partial<
  Omit<Face, 'id' | 'mediaId' | 'keyFrameMediaId' | 'sourceFrameMediaId'>
> & {
  readonly mediaId?: number | null
  readonly keyFrameMediaId?: number | null
  readonly sourceFrameMediaId?: number | null
}

/** The columns a whole-archive rescore reads per face (no vector, no crop). */
const RESCORE_COLUMNS: readonly string[] = [
  'deviceId',
  'assigned',
  'recognizedIdentityId',
  'embeddingModelId',
  'suggestedIdentityId',
  'suggestedMatchScore',
]

/** One pending face with its vector, as the whole-archive rescore consumes it. */
export interface RescoreBatchRow {
  readonly id: string
  readonly deviceId: number
  readonly embedding: readonly number[]
  readonly modelId: string
  readonly suggestedIdentityId?: string
  readonly suggestedMatchScore?: number
}

export interface RescoreBatch {
  readonly rows: readonly RescoreBatchRow[]
  /** Pending rows whose vector is in neither home. */
  readonly noVector: number
  /** Ids of the snapshot that no longer have a row (deleted since). */
  readonly gone: number
}

/** A suggestion write; `null` clears both columns. */
export interface SuggestionUpdate {
  readonly faceId: string
  readonly suggestion: { readonly identityId: string; readonly score: number } | null
}

/** See {@link FaceStore.pendingMarker}. `maxTimestamp` is null for an empty set. */
export interface PendingFaceMarker {
  readonly count: number
  readonly maxTimestamp: number | null
}

export interface FaceStoreDeps {
  /**
   * The `face-arcface` index. REQUIRED, not optional — an optional vector home
   * is a store that silently keeps writing JSON when the capability is missing,
   * which is the state this migration exists to end.
   */
  readonly vectors: EmbeddingVectorIndex
  readonly logger: IScopedLogger
  readonly faceLedger: EventLedgerCollection
}

export class FaceStore {
  private readonly vectors: EmbeddingVectorIndex
  private readonly logger: IScopedLogger
  private readonly ledger: EventLedgerCollection

  constructor(deps: FaceStoreDeps) {
    this.vectors = deps.vectors
    this.logger = deps.logger
    this.ledger = deps.faceLedger
  }

  /**
   * Upsert one buffered face. Keyed by `face.id` (the worker uses one stable
   * id per track → one entry per track). `set` replaces an existing row.
   */
  async insert(face: FaceRecord): Promise<void> {
    const { id, embedding, ...rest } = face
    // The VECTOR first, the row second. If the index write fails the row is
    // still written — a face with no searchable vector is a degraded row, and
    // dropping it entirely would lose the crop, the suggestion and the operator's
    // ability to enrol it. But the failure is never silent: `put` logs it, and
    // the row lands with an empty legacy column so the conversion pass does not
    // mistake it for something it can still recover from JSON.
    const indexed = await this.vectors.put({
      id,
      embedding,
      className: FACE_VECTOR_CLASS,
      modelId: face.embeddingModelId ?? LEGACY_FACE_MODEL_ID,
      timestamp: face.timestamp,
      deviceId: face.deviceId,
      extra: { trackId: face.trackId },
    })
    if (!indexed) {
      this.logger.warn('face row written WITHOUT a searchable vector', {
        tags: { deviceId: face.deviceId },
        meta: { faceId: id, index: this.vectors.name, trackId: face.trackId },
      })
    }
    try {
      await this.ledger.upsertRow(id, {
        ...rest,
        // `embedding: []` is the drained legacy column — see FACE_COLUMNS.
        embedding: [],
      } as Record<string, unknown>)
    } catch (err) {
      this.logger.warn('FaceStore.insert failed', {
        tags: { deviceId: face.deviceId },
        meta: { faceId: id, error: String(err) },
      })
    }
  }

  /**
   * How an UNCONVERTED `faces` row becomes an index row.
   *
   * The only judgement here is the modelId: a row written before 2026-08-20
   * carries no `embeddingModelId`, and those rows were all `arcface-r100`, so
   * that is what they are stamped with — a KNOWN historical fact, not a
   * fallback guess. A row that names some other model keeps its own.
   *
   * The rows are paged through the faces LEDGER: the adoption copied each
   * row's body whole — an `embedding` the pass had not drained yet included —
   * so a records-era row can still need converting (the same shape as
   * `IdentityStore`).
   */
  conversionSpec(): EmbeddingConversionSpec {
    const ledger = this.ledger
    return {
      collection: FACES_COLLECTION,
      vectors: this.vectors,
      pageRows: (limit, offset) =>
        ledger.query({ orderBy: { field: 'id', direction: 'asc' }, limit, offset }, [
          'deviceId',
          'timestamp',
          'trackId',
          'embeddingModelId',
          'embedding',
        ]),
      drainEmbedding: (id) => ledger.update(id, { embedding: [] }),
      write: (id, embedding, data) => {
        const deviceId = data['deviceId']
        const timestamp = data['timestamp']
        const trackId = data['trackId']
        const modelId = data['embeddingModelId']
        return {
          id,
          embedding,
          className: FACE_VECTOR_CLASS,
          modelId:
            typeof modelId === 'string' && modelId.length > 0 ? modelId : LEGACY_FACE_MODEL_ID,
          timestamp: typeof timestamp === 'number' ? timestamp : 0,
          ...(typeof deviceId === 'number' ? { deviceId } : {}),
          ...(typeof trackId === 'string' ? { extra: { trackId } } : {}),
        }
      },
    }
  }

  /**
   * One face WITH its ArcFace vector — the enrolment and re-assignment read.
   *
   * Falls back to the row's legacy JSON column when the index has no vector for
   * this id, which is exactly the window in which a row written before the
   * conversion has not been converted yet. The fallback is LOGGED: it is
   * correct, it is temporary, and a fallback nobody can count is a fallback that
   * becomes permanent.
   */
  async getWithEmbedding(faceId: string): Promise<FaceRecord | null> {
    const row = await this.ledger.get(faceId)
    if (row === null) return null
    const face = rowToFace(faceId, row.data)
    const indexed = await this.vectors.load([faceId])
    const fromIndex = indexed.get(faceId)
    if (fromIndex !== undefined) return { ...face, embedding: fromIndex }

    const legacy = row.data['embedding']
    if (Array.isArray(legacy) && legacy.length > 0 && legacy.every((n) => typeof n === 'number')) {
      this.logger.info('face vector served from the legacy JSON column', {
        tags: { deviceId: face.deviceId },
        meta: { faceId, why: 'this row has not been converted into the vector index yet' },
      })
      return { ...face, embedding: legacy }
    }
    this.logger.warn('face row has no vector in either home', {
      tags: { deviceId: face.deviceId },
      meta: { faceId, index: this.vectors.name },
    })
    return null
  }

  /**
   * The ArcFace vectors of named rows, for the CLUSTERING pass.
   *
   * Ids with no vector are ABSENT from the map, never present with an empty
   * array — the clustering loop skips a zero-length vector, so an empty array
   * would turn "the index did not answer" into "these faces are not clusterable"
   * and produce a confident zero.
   */
  async loadEmbeddings(
    faceIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly number[]>> {
    const indexed = await this.vectors.load(faceIds)
    const missing = faceIds.filter((id) => !indexed.has(id))
    if (missing.length === 0) return indexed

    // The same fallback `getWithEmbedding` makes, for the same window: a row
    // written before the conversion still carries its array, and clustering
    // that quietly skipped those rows would offer the operator fewer groups
    // with no way to tell that from "there were no groups".
    const out = new Map(indexed)
    let fromLegacyColumn = 0
    for (const id of missing) {
      const row = await this.ledger.get(id)
      const legacy = row?.data['embedding']
      if (
        !Array.isArray(legacy) ||
        legacy.length === 0 ||
        !legacy.every((n) => typeof n === 'number')
      ) {
        continue
      }
      out.set(id, legacy)
      fromLegacyColumn += 1
    }
    this.logger.info('face vectors served partly from the legacy JSON column', {
      meta: {
        index: this.vectors.name,
        asked: faceIds.length,
        fromIndex: indexed.size,
        fromLegacyColumn,
        unavailable: missing.length - fromLegacyColumn,
      },
    })
    return out
  }

  /**
   * Recent UNASSIGNED faces (the enrollment buffer), newest first.
   *
   * NOTE: `assigned` is normalized via `Boolean()` on read so the production
   * SQLite backend (which returns INTEGER 0/1) is handled correctly.
   */
  async listRecentFaces(input: { deviceId?: number; limit?: number }): Promise<readonly Face[]> {
    const where: Record<string, unknown> = {}
    if (input.deviceId !== undefined) where['deviceId'] = input.deviceId
    const rows = await this.ledger.query({
      where,
      orderBy: { field: 'timestamp', direction: 'desc' },
      limit: input.limit ?? 100,
    })
    return rows.map((r) => rowToFace(r.id, r.data)).filter((f) => !f.assigned)
  }

  /**
   * The per-device `prune(deviceId, cutoffMs, maxPerDevice)` that used to sit
   * here is GONE (D61). It had no production caller — only tests — and it was
   * an age-keyed deletion of a track-OWNED entity, i.e. the exact thing the
   * retention model now forbids. A leftover that describes the wrong design
   * still reads as permission to use it.
   */

  /**
   * Hold the unassigned face buffer to `maxPerDevice` newest rows per camera.
   *
   * **This is a CAPACITY bound, not an age one.** It used to be both: a face
   * was deleted if it was older than `bufferRetentionDays` OR beyond the cap.
   * The age half was a fifth clock over a track-OWNED entity — a face row
   * carries a `trackId`, so it belongs to its track and cascades with it — and
   * it aged crops out from under tracks that were still well inside their own
   * retention window. It is gone (D61). What remains is the ring-buffer
   * property the recognizer actually depends on: the gallery of recent
   * unassigned faces stays small.
   *
   * **A row the system asked a question about outlives one it said nothing
   * about.** A single cap evicted both alike, so on 15 of 24 live cameras
   * (measured 2026-08-25) the buffer sat at exactly the cap and an unanswered
   * suggestion was deleted within about a day. Rows carrying a
   * `suggestedIdentityId` are ranked in their OWN, larger budget
   * (`maxSuggestedPerDevice`) — never immortality, because nothing clears a
   * suggestion the operator merely declines to answer. Size and trade-off:
   * `deriveSuggestedBufferCap` in `face-settings.ts:263`.
   *
   * ENROLLED (`assigned`) rows are skipped entirely and consume NO slot in
   * either tier. Returns all deleted ids (the caller removes their crops).
   */
  async pruneCapOverflow(input: FaceCapOverflowInput): Promise<readonly string[]> {
    /**
     * Paged, not one statement, and PROJECTED to the four scalars the decision
     * needs — this sentence used to be true only of what survived the page,
     * while the query still dragged every column, `embedding` included, across
     * the RPC boundary and through V8 first.
     *
     * This is the one walk of the collection that remains, and D320 permits it:
     * it must touch every row to ACT on it, and it runs on the maintenance
     * pass, not on a request. The prune still considers EVERY row, which is
     * what makes it a capacity bound rather than a bound on the newest page.
     */
    const byDevice = new Map<number, FaceCapCandidate[]>()
    for (let page = 0; page < FACE_SWEEP_MAX_PAGES; page++) {
      const rows = await this.ledger.query(
        {
          orderBy: { field: 'timestamp', direction: 'desc' },
          limit: FACE_SWEEP_PAGE,
          offset: page * FACE_SWEEP_PAGE,
        },
        FACE_CAP_COLUMNS,
      )
      if (rows.length === 0) break
      for (const r of rows) {
        const data: FaceCapRowFields = r.data
        // Skip assigned rows — they are exempt from retention eviction.
        if (data['assigned']) continue
        const deviceId = Number(data['deviceId'] ?? -1)
        const list = byDevice.get(deviceId) ?? []
        list.push({
          id: r.id,
          timestamp: Number(data['timestamp'] ?? 0),
          suggested: hasSuggestion(data['suggestedIdentityId']),
        })
        byDevice.set(deviceId, list)
      }
      if (rows.length < FACE_SWEEP_PAGE) break
    }
    const toDelete = new Set<string>()
    const suggestedVictims = new Map<number, string[]>()
    for (const [deviceId, list] of byDevice) {
      // Make the newest-first invariant explicit (the cap rule depends on it) —
      // don't rely on the global query ordering surviving the per-device grouping.
      list.sort((a, b) => b.timestamp - a.timestamp)
      // Two budgets, ranked independently: a suggested row neither consumes an
      // ordinary slot nor is ranked against rows that were never suggested.
      let ordinaryRank = 0
      let suggestedRank = 0
      for (const row of list) {
        if (row.suggested) {
          if (suggestedRank++ < input.maxSuggestedPerDevice) continue
          toDelete.add(row.id)
          const victims = suggestedVictims.get(deviceId) ?? []
          victims.push(row.id)
          suggestedVictims.set(deviceId, victims)
          continue
        }
        if (ordinaryRank++ < input.maxPerDevice) continue
        toDelete.add(row.id)
      }
    }
    const deleted = new Set<string>()
    for (const id of toDelete) {
      try {
        await this.ledger.deleteKey(id)
        deleted.add(id)
      } catch (err) {
        this.logger.warn('FaceStore.pruneCapOverflow delete failed', {
          meta: { faceId: id, error: String(err) },
        })
      }
    }
    // The vector leaves with its row. A capacity eviction that dropped only the
    // settings row would leave the ArcFace vector in the index owned by nothing
    // — the identical shape that left ~9,000 unreachable CLIP vectors behind.
    await this.vectors.drop([...deleted])
    this.announceSuggestedEvictions(suggestedVictims, deleted, input.maxSuggestedPerDevice)
    return [...deleted]
  }

  /**
   * Name every camera that lost an UNANSWERED suggestion, and how many.
   *
   * This exists because the loss it reports ran for weeks without a single log
   * line: the prune only ever logged an aggregate count with no `deviceId`, so
   * "why did camera 108 forget the person it asked me about" could not be asked
   * of the logs at all. One line per camera (not per row) keeps the volume sane
   * while still answering the per-camera question.
   *
   * Reports rows that were ACTUALLY deleted — a row whose delete threw is still
   * in the buffer, and is reported by the failure line above instead.
   */
  private announceSuggestedEvictions(
    victimsByDevice: ReadonlyMap<number, readonly string[]>,
    deleted: ReadonlySet<string>,
    cap: number,
  ): void {
    for (const [deviceId, victims] of victimsByDevice) {
      const gone = victims.filter((id) => deleted.has(id))
      if (gone.length === 0) continue
      this.logger.warn('face buffer evicted UNANSWERED suggestions — the operator never saw them', {
        tags: { deviceId },
        meta: {
          deleted: gone.length,
          cap,
          faceIds: gone.slice(0, SUGGESTED_EVICTION_IDS_LOGGED),
          why: 'the suggested tier is full on this camera: suggestions arrive faster than they are answered, and the OLDEST unanswered ones are dropped first.',
        },
      })
    }
  }

  /**
   * Replace a buffered face's vector AND its model stamp, then confirm BOTH.
   *
   * The vector and the stamp live in two homes — the index and the row — and
   * they must move together or not at all: a row stamped with the cluster model
   * beside a vector from the previous one is a face the matcher believes is
   * comparable and is not, which is worse than a face it refuses to compare.
   *
   * So: vector first (refuse if it does not land), row second, then a read-back
   * of the stamp. Returns whether the whole move landed — never whether the
   * calls returned (D58).
   */
  async restampEmbedding(input: {
    readonly faceId: string
    readonly deviceId: number
    readonly trackId: string
    readonly timestamp: number
    readonly embedding: readonly number[]
    readonly modelId: string
  }): Promise<boolean> {
    const indexed = await this.vectors.put({
      id: input.faceId,
      embedding: input.embedding,
      className: FACE_VECTOR_CLASS,
      modelId: input.modelId,
      timestamp: input.timestamp,
      deviceId: input.deviceId,
      extra: { trackId: input.trackId },
    })
    if (!indexed) {
      this.logger.warn('face re-embed refused: the vector did not reach the index', {
        tags: { deviceId: input.deviceId },
        meta: { faceId: input.faceId, index: this.vectors.name },
      })
      return false
    }
    // The legacy column is emptied in the same write: a stale array beside a
    // fresh vector is what `getWithEmbedding`'s fallback would then serve.
    await this.update(input.faceId, { embeddingModelId: input.modelId })
    await this.ledger.update(input.faceId, { embedding: [] })
    const stored = await this.get(input.faceId)
    return stored?.embeddingModelId === input.modelId
  }

  /** Flip `assigned` to true and record which identity was matched. Optionally persist the sample id. */
  async markAssigned(faceId: string, identityId: string, sampleId?: string): Promise<void> {
    const data: Record<string, unknown> = { assigned: true, recognizedIdentityId: identityId }
    if (sampleId !== undefined) data['assignedSampleId'] = sampleId
    try {
      await this.ledger.update(faceId, data)
    } catch (err) {
      this.logger.warn('FaceStore.markAssigned failed', {
        meta: { faceId, error: String(err) },
      })
    }
  }

  /** Clear the assignment: set assigned=false, clear recognizedIdentityId and assignedSampleId. */
  async clearAssignment(faceId: string): Promise<void> {
    try {
      await this.ledger.update(faceId, {
        assigned: false,
        recognizedIdentityId: null,
        assignedSampleId: null,
      })
    } catch (err) {
      this.logger.warn('FaceStore.clearAssignment failed', {
        meta: { faceId, error: String(err) },
      })
    }
  }

  /**
   * Persist a `face.rescoreTrack` result onto the SUGGESTED tier — the ONE
   * write that explicitly-requested action makes. `suggestion: null` means
   * the recompute found no candidate worth offering and CLEARS both columns
   * (a genuine "the gallery has nothing for this face right now" result, not
   * a no-op left at whatever they held before). Never touches `assigned` /
   * `recognizedIdentityId` — a suggestion is never an assignment. The caller
   * is responsible for never calling this with a non-comparable (`model-
   * mismatch`) report; this method persists whatever it is given.
   */
  async setSuggestion(
    faceId: string,
    suggestion: { identityId: string; score: number } | null,
  ): Promise<void> {
    const data: Record<string, unknown> =
      suggestion === null
        ? { suggestedIdentityId: null, suggestedMatchScore: null }
        : { suggestedIdentityId: suggestion.identityId, suggestedMatchScore: suggestion.score }
    try {
      await this.ledger.update(faceId, data)
    } catch (err) {
      this.logger.warn('FaceStore.setSuggestion failed', {
        meta: { faceId, error: String(err) },
      })
    }
  }

  /**
   * `TrackScopedStore` contract for the retention cascade: delete the buffered
   * face rows of the given tracks that are NOT assigned. Reuses the EXACT
   * `assigned` exemption that `prune`/`pruneAll` apply (see the
   * `!(r.data.assigned)` predicate above) so ENROLLED faces SURVIVE retention.
   * Per-track ISOLATED + best-effort per row — one bad track or row never
   * aborts the batch. (Crop media of these rows is removed by `MediaStore`.)
   */
  async deleteByTracks(trackIds: readonly string[]): Promise<readonly TrackCascadeLeafCount[]> {
    let removed = 0
    for (const trackId of trackIds) {
      try {
        const rows = await this.ledger.query({ where: { trackId } })
        // Skip assigned rows entirely — exempt from retention eviction (enrolled
        // faces survive). Same predicate as `prune`/`pruneAll`.
        const eligible = rows.filter((r) => !(r.data as { assigned?: unknown }).assigned)
        const dropped: string[] = []
        for (const row of eligible) {
          try {
            await this.ledger.deleteKey(row.id)
            dropped.push(row.id)
            removed++
          } catch (err) {
            this.logger.warn('FaceStore.deleteByTracks delete failed', {
              meta: { faceId: row.id, error: String(err) },
            })
          }
        }
        // Vectors of the rows that ACTUALLY went. A row whose delete threw is
        // still in the buffer and still needs its vector.
        await this.vectors.drop(dropped)
      } catch (err) {
        this.logger.warn('FaceStore.deleteByTracks query failed', {
          meta: { trackId, error: String(err) },
        })
      }
    }
    return [{ family: 'faces', rows: removed, bytes: 0 }]
  }

  /**
   * D683 §6.3: one face row per track survives, under the survivor's id —
   * except that an enrolled row is never deleted.
   *
   * Presence and rank are decided from `get()` (review M1): `getWithEmbedding`
   * is fetched ONLY for the absorbed row once it is known to be the one
   * carried — never for the survivor, whose rank needs no vector at all. A
   * survivor row that exists but carries no vector in either home used to
   * read as ABSENT here (`getWithEmbedding` → `null`) and be silently
   * overwritten by the absorbed row, un-enrolling it.
   *
   * Every write that must land is VERIFIED by reading it back before the next
   * step runs (review H2): a swallowed `insert`/`delete` failure must never
   * still let the following step destroy the only copy of an enrolled row or
   * its media. Media moves BEFORE the source row is dropped, so a crash
   * between the two leaves the row for a retry to clean up — never the media,
   * which is already safely under the survivor by then.
   */
  async reassignTrack(req: TrackFusionRequest): Promise<readonly TrackFusionLeafCount[]> {
    const fromId = `face-${req.absorbedId}`
    const toId = `face-${req.survivorId}`
    const absorbed = await this.get(fromId)
    if (absorbed === null) return [{ family: 'faces', moved: 0, dropped: 0 }]
    const survivor = await this.get(toId)
    const rank = (f: Face): number =>
      (f.assigned ? 4 : 0) + (f.recognizedIdentityId !== undefined ? 2 : 0)
    const survivorWins =
      survivor !== null &&
      (rank(survivor) > rank(absorbed) ||
        (rank(survivor) === rank(absorbed) && survivor.timestamp >= absorbed.timestamp))
    if (survivorWins || survivor?.assigned === true) {
      // N2: the SURVIVOR's OWN row may itself name a keyFrameMediaId the
      // media leg just dropped — independent of which row the ranking above
      // keeps, and never checked by the `stillPresent` guard below, which
      // only ever looks at the CARRIED (absorbed) row.
      if (
        survivor !== null &&
        survivor.keyFrameMediaId !== undefined &&
        !(await req.media.stillPresent(survivor.keyFrameMediaId))
      ) {
        this.logger.warn(
          "face fusion: dropped the survivor's own keyFrameMediaId the media leg no longer has",
          {
            tags: { deviceId: req.deviceId },
            meta: { faceId: toId, droppedMediaId: survivor.keyFrameMediaId },
          },
        )
        await this.update(toId, { keyFrameMediaId: null })
        // Review P3: verify the clear landed, like every other write in this leaf.
        if ((await this.get(toId))?.keyFrameMediaId !== undefined) {
          throw new Error(
            `face fusion: could not clear the survivor's own stale keyFrameMediaId on ${toId}`,
          )
        }
      }
      if (absorbed.assigned) return [{ family: 'faces', moved: 0, dropped: 0, kept: 1 }]
      // N3: media before row — a crash between the two must never leave
      // `face-<absorbed>`-owned media with no row a retry can find again (the
      // early `absorbed === null` guard above would skip it on any re-run).
      await req.media.deleteOwner('face', fromId)
      await this.delete(fromId)
      if ((await this.get(fromId)) !== null) {
        throw new Error(`face fusion: could not delete losing absorbed row ${fromId}`)
      }
      return [{ family: 'faces', moved: 0, dropped: 1 }]
    }
    // The absorbed row is carried — its vector is needed only now.
    const carried = await this.getWithEmbedding(fromId)
    if (carried === null) {
      throw new Error(`face fusion: absorbed row ${fromId} has no vector in either home`)
    }
    if (survivor !== null) {
      await this.delete(toId)
      if ((await this.get(toId)) !== null) {
        throw new Error(`face fusion: could not delete losing survivor row ${toId}`)
      }
      await req.media.deleteOwner('face', toId)
    }
    // M2: a dangling `keyFrameMediaId` (Design B's face box) is dropped and
    // logged rather than carried over unverified.
    const keyFrameMediaId =
      carried.keyFrameMediaId !== undefined &&
      (await req.media.stillPresent(carried.keyFrameMediaId))
        ? carried.keyFrameMediaId
        : undefined
    if (carried.keyFrameMediaId !== undefined && keyFrameMediaId === undefined) {
      this.logger.warn('face fusion: dropped a keyFrameMediaId the media leg no longer has', {
        tags: { deviceId: req.deviceId },
        meta: { faceId: toId, droppedMediaId: carried.keyFrameMediaId },
      })
    }
    await this.insert({ ...carried, id: toId, trackId: req.survivorId, keyFrameMediaId })
    if ((await this.get(toId)) === null) {
      throw new Error(`face fusion: insert of ${toId} did not land`)
    }
    await req.media.moveOwner('face', fromId, toId)
    await this.delete(fromId)
    if ((await this.get(fromId)) !== null) {
      throw new Error(`face fusion: could not delete carried-over absorbed row ${fromId}`)
    }
    return [{ family: 'faces', moved: 1, dropped: survivor !== null ? 1 : 0 }]
  }

  /** Delete a single buffered face row by id (its crop media is removed by the
   *  caller — the FaceStore owns rows, not blobs). Best-effort, but it SAYS
   *  whether the row went: `false` = the delete failed (logged). */
  async delete(faceId: string): Promise<boolean> {
    try {
      await this.ledger.deleteKey(faceId)
    } catch (err) {
      this.logger.warn('FaceStore.delete failed', { meta: { faceId, error: String(err) } })
      return false
    }
    await this.vectors.drop([faceId])
    return true
  }

  /**
   * Is this face STILL pending — unassigned and naming no identity? `null` =
   * the row is gone. The gallery reset asks it again right before deleting a
   * face its listing called pending (D644): the operator may have assigned it
   * in between, and a listing is not a licence to delete what changed since.
   */
  async isPending(faceId: string): Promise<boolean | null> {
    const face = await this.get(faceId)
    if (face === null) return null
    return !face.assigned && face.recognizedIdentityId === undefined
  }

  /**
   * The SUBSET of `faceIds` that still have a row.
   *
   * THROWS on a read failure, and that is the contract: the one caller is the
   * orphan audit, and an under-report here deletes vectors that are owned. The
   * same shape as `TrackStore.existingTrackIds`, for the same reason.
   */
  async existingFaceIds(faceIds: readonly string[]): Promise<ReadonlySet<string>> {
    const PAGE = 500
    const found = new Set<string>()
    for (let i = 0; i < faceIds.length; i += PAGE) {
      const chunk = faceIds.slice(i, i + PAGE)
      if (chunk.length === 0) continue
      const rows = await this.ledger.query({ whereIn: { id: [...chunk] }, limit: chunk.length })
      for (const row of rows) found.add(row.id)
    }
    return found
  }

  /** One page of the ArcFace index, metadata only — for the orphan audit. */
  async scanVectorRefs(cursor: number, limit: number): Promise<EmbeddingVectorScanPage> {
    return await this.vectors.scan(cursor, limit)
  }

  /** Drop vectors and confirm they left. Used only by the orphan audit. */
  async dropVectorsVerified(
    ids: readonly string[],
  ): Promise<{ deleted: readonly string[]; stillPresent: readonly string[] }> {
    return await this.vectors.dropVerified(ids)
  }

  /**
   * Retrieve a single face by id. Returns null if not found.
   */
  async get(faceId: string): Promise<Face | null> {
    const row = await this.ledger.get(faceId)
    if (row === null) return null
    return rowToFace(faceId, row.data)
  }

  /**
   * Update internal fields of a face (used for partial mutation, e.g. setting recognizedIdentityId).
   * Not exposed publicly — intended for internal use and tests only.
   */
  async update(faceId: string, data: FaceColumnPatch): Promise<void> {
    try {
      await this.ledger.update(faceId, data as Record<string, unknown>)
    } catch (err) {
      this.logger.warn('FaceStore.update failed', {
        meta: { faceId, error: String(err) },
      })
    }
  }

  /**
   * List recent faces across the cluster, or across a named set of cameras.
   *
   * filter:
   *  - 'all' (default)        → every row
   *  - 'unassigned'           → !assigned
   *  - 'recognized'           → !assigned && recognizedIdentityId != null
   *  - 'identified'           → recognizedIdentityId != null, including manual assignments
   *
   * **Every part of the question is now a store predicate** — `deviceIds`,
   * `since` / `until` AND `filter` ({@link faceFilterPredicate}) — so `limit`
   * is the STORE's limit and one statement is the whole answer.
   *
   * That is the change. This used to page: `filter` was a JS predicate applied
   * to rows the store had already chosen, so `limit` counted rows that PASSED
   * and the read had to sweep until enough had, up to `FACE_SWEEP_MAX_PAGES`
   * (1 000) × `FACE_SWEEP_PAGE` (1 000) — a million rows, `offset`-paged,
   * behind a UI polling every 30 seconds. On the live hub that meant reading
   * all 1 612 rows over 2 round trips to produce a 60-row `recognized` page,
   * every 30 s, per open tab, and growing with a table only `pruneCapOverflow`
   * bounds. It is the same family as `MediaRelocateEngine.pageRows`, which put
   * a ~16 s standing queue in front of every settings-store call in the cluster
   * (D320) — smaller, on a longer timer, and the same shape.
   *
   * `offset` is gone with it, not merely unnecessary: the recognizer UPSERTs
   * into this collection continuously, so page two at `offset: N` starts N rows
   * past a set that may have gained or lost its first N (D295 rule 1, D320 R3).
   *
   * ## What still cannot be pushed, and what that costs
   *
   * The `suggestionConfidence` ORDER stays here. `ORDER BY suggestedMatchScore`
   * would let the backend decide where a scoreless row goes — SQLite collates
   * NULL first on ASC and last on DESC — and the contract is that it sorts LAST
   * in BOTH directions (`face-sort.ts`). So that order reads the whole FILTERED
   * window and ranks it. Filtered, which is the improvement: the window is the
   * unassigned buffer, not the table.
   *
   * A window it cannot read whole REFUSES ({@link FaceWindowTooWideError}).
   * Ranking the part that fit is exactly "most certain among the newest N",
   * which is the defect that order was added to remove, and it is invisible in
   * the rows returned.
   *
   * An **empty `deviceIds` reads nothing at all**: `[]` is a request for no
   * cameras, not an omission (the `deviceManager.listFleet` contract).
   */
  async listAllRecentFaces(input: ListAllRecentFacesInput): Promise<readonly Face[]> {
    if (input.deviceIds !== undefined && input.deviceIds.length === 0) return []

    const order = resolveFaceSort(input)
    const pagingServesTheOrder = sortIsServedByTimestampPaging(order)

    /**
     * The caller's `limit` bounds the READ only when the store's ordering is
     * already the answer's. Under `suggestionConfidence` the most certain
     * suggestion may be the oldest row, so the read is the window and `limit`
     * bounds only what is RETAINED (`rankAndCap`).
     */
    const callerBounded = pagingServesTheOrder && input.limit !== undefined
    // One row past the imposed ceiling, so "the window was exactly the ceiling"
    // and "the window was cut at the ceiling" are different observations. The
    // engine's own sentinel cannot be seen from here — it warns and truncates.
    const readLimit = callerBounded ? (input.limit ?? 0) : FACE_WINDOW_MAX_ROWS + 1

    const rows = await this.ledger.query(
      {
        ...(input.deviceIds !== undefined
          ? { whereIn: { deviceId: [...new Set(input.deviceIds)] } }
          : {}),
        ...buildTimestampWindow(input),
        ...faceFilterPredicate(input.filter ?? 'all'),
        orderBy: {
          field: 'timestamp',
          direction: pagingServesTheOrder ? order.direction : ('desc' as const),
        },
        limit: readLimit,
      },
      FACE_LIST_COLUMNS,
    )

    if (!callerBounded && rows.length > FACE_WINDOW_MAX_ROWS) {
      throw new FaceWindowTooWideError(rows.length)
    }

    const faces = rows.map((r) => rowToFace(r.id, r.data))
    return pagingServesTheOrder ? faces : rankAndCap(faces, order, input.limit)
  }

  /**
   * One real face row per camera currently attributed to an identity.
   *
   * `recognizedIdentityId` is indexed (`idx_faces_identity_ts`), so this is a
   * bounded index walk over the identity's own rows rather than the
   * `offset`-paged sweep of the whole collection it used to be. It projects
   * `deviceId` alone — the answer is a device id and a row id, and the row id
   * is the record key.
   */
  async listCameraRefsForIdentity(
    identityId: string,
  ): Promise<readonly { faceId: string; deviceId: number }[]> {
    const rows = await this.identityRows(identityId, FACE_REF_COLUMNS)
    const byDevice = new Map<number, string>()
    for (const row of rows) {
      const deviceId = Number(row.data['deviceId'])
      if (Number.isInteger(deviceId) && !byDevice.has(deviceId)) byDevice.set(deviceId, row.id)
    }
    return [...byDevice].map(([deviceId, faceId]) => ({ deviceId, faceId }))
  }

  /**
   * Every face row currently attributed to an identity, id only.
   *
   * `deleteIdentity` detaches these before the identity goes. It used to get
   * them by listing the WHOLE collection with `filter: 'all'` and no limit and
   * comparing in JS — which past `SETTINGS_QUERY_DEFAULT_ROW_CAP` would have
   * detached the rows that fit and left the rest pointing at a deleted
   * identity, silently, with a WARN in the engine that no caller can see.
   */
  async listFaceIdsForIdentity(identityId: string): Promise<readonly string[]> {
    return (await this.identityRows(identityId, FACE_REF_COLUMNS)).map((r) => r.id)
  }

  /**
   * The buffered faces whose enrolment IS `sampleId`, with the crop id each
   * holds. Read through the identity index — `assignedSampleId` has none, and
   * a face enrolled on a sample is always attributed to its identity
   * (`markAssigned`).
   */
  async listFacesForSample(
    identityId: string,
    sampleId: string,
  ): Promise<readonly FaceSampleRef[]> {
    const rows = await this.identityRows(identityId, [
      'assignedSampleId',
      'mediaId',
      'sourceFrameMediaId',
    ])
    const out: FaceSampleRef[] = []
    for (const r of rows) {
      if (r.data['assignedSampleId'] !== sampleId) continue
      const mediaId = r.data['mediaId']
      const sourceFrameMediaId = r.data['sourceFrameMediaId']
      out.push({
        faceId: r.id,
        ...(typeof mediaId === 'number' ? { mediaId } : {}),
        ...(typeof sourceFrameMediaId === 'number' ? { sourceFrameMediaId } : {}),
      })
    }
    return out
  }

  /**
   * Every buffered face NOBODY has named — unassigned and carrying no identity
   * (a suggestion is not a name). The gallery reset deletes exactly these
   * (D644); a face with an identity, assigned or auto-recognised onto its
   * track, is history and never appears here.
   *
   * Served by `idx_faces_assigned_ts` (`assigned = ?`), projected to the one
   * column the caller needs, and REFUSING past {@link FACE_WINDOW_MAX_ROWS} —
   * a short list here would read as "all pending faces" and leave the rest.
   */
  async listPendingFaces(): Promise<readonly PendingFaceRow[]> {
    const rows = await this.ledger.query(
      {
        where: { assigned: false, recognized: false },
        orderBy: { field: 'timestamp', direction: 'desc' },
        limit: FACE_WINDOW_MAX_ROWS + 1,
      },
      ['deviceId'],
    )
    if (rows.length > FACE_WINDOW_MAX_ROWS) throw new FaceWindowTooWideError(rows.length)
    const out: PendingFaceRow[] = []
    for (const r of rows) {
      const deviceId = r.data['deviceId']
      if (typeof deviceId === 'number') out.push({ faceId: r.id, deviceId })
    }
    return out
  }

  /**
   * The ids a whole-archive rescore will visit, SNAPSHOT at the start of the
   * run — the same population as {@link listPendingFaces} (unassigned AND
   * carrying no identity), so the two never disagree about "pending". Ids only:
   * the job pages the rows themselves ({@link loadRescoreBatch}) so the
   * settings thread never serves one big read of vectors.
   */
  async listPendingFaceIds(): Promise<readonly string[]> {
    return (await this.listPendingFaces()).map((r) => r.faceId)
  }

  /**
   * One page of a whole-archive rescore: the rows of `ids` that are STILL
   * pending (the operator may have assigned one since the snapshot), each with
   * its vector. Ids whose vector is in neither home are counted, not dropped
   * silently — "no vector" must not read as "scored, no match".
   */
  async loadRescoreBatch(ids: readonly string[]): Promise<RescoreBatch> {
    if (ids.length === 0) return { rows: [], noVector: 0, gone: 0 }
    const records = await this.ledger.query(
      { whereIn: { id: [...ids] }, limit: ids.length },
      RESCORE_COLUMNS,
    )
    const stillPending = records.filter(
      (r) => !r.data['assigned'] && (r.data['recognizedIdentityId'] ?? null) === null,
    )
    const vectors = await this.loadEmbeddings(stillPending.map((r) => r.id))
    const rows: RescoreBatchRow[] = []
    let noVector = 0
    for (const r of stillPending) {
      const embedding = vectors.get(r.id)
      if (embedding === undefined || embedding.length === 0) {
        noVector += 1
        continue
      }
      const suggestedIdentityId = r.data['suggestedIdentityId']
      const suggestedMatchScore = r.data['suggestedMatchScore']
      const embeddingModelId = r.data['embeddingModelId']
      rows.push({
        id: r.id,
        deviceId: Number(r.data['deviceId'] ?? -1),
        embedding,
        modelId: typeof embeddingModelId === 'string' ? embeddingModelId : LEGACY_FACE_MODEL_ID,
        ...(typeof suggestedIdentityId === 'string' ? { suggestedIdentityId } : {}),
        ...(typeof suggestedMatchScore === 'number' ? { suggestedMatchScore } : {}),
      })
    }
    return { rows, noVector, gone: ids.length - records.length }
  }

  /**
   * Write a batch of suggestion changes, one patch per face. THROWS on the
   * first patch that does not land: a batch that did not land must not be
   * counted as applied. Touches only the two suggestion columns — never an
   * assignment.
   */
  async applySuggestionBatch(updates: readonly SuggestionUpdate[]): Promise<void> {
    for (const u of updates) {
      await this.ledger.update(
        u.faceId,
        u.suggestion === null
          ? { suggestedIdentityId: null, suggestedMatchScore: null }
          : {
              suggestedIdentityId: u.suggestion.identityId,
              suggestedMatchScore: u.suggestion.score,
            },
      )
    }
  }

  /**
   * The unassigned-face set marker for change detection: how many unassigned
   * rows exist and the newest one's timestamp: a count and a one-row page over
   * `assigned = false`, both served by the faces kind's `assigned_ts` index
   * (D447). A face
   * arriving moves the max, a face leaving or being assigned moves the count.
   */
  async pendingMarker(): Promise<PendingFaceMarker> {
    return this.ledger.pendingUnassignedMarker()
  }

  /**
   * A face's enrolled sample is going away (D643 prune, or the operator's
   * Remove): forget the sample, and the crop too when it is the blob leaving
   * with it. The face itself — and who it was assigned to — stays. THROWS on
   * failure, unlike `update`: the caller must not delete the sample while a
   * face still names it.
   */
  async detachSample(faceId: string, clears: FaceDetachClears): Promise<void> {
    await this.ledger.update(faceId, {
      assignedSampleId: null,
      ...(clears.media ? { mediaId: null } : {}),
      ...(clears.sourceFrame ? { sourceFrameMediaId: null } : {}),
    })
  }

  /**
   * The sample a face was enrolled as was REPLACED by a re-derived one (the
   * source re-enrol pass, D644): the face names the replacement, and its crop
   * follows the template when it was the old one. THROWS — the caller must not
   * remove the old sample while a face still names it.
   */
  async repointSample(faceId: string, repoint: FaceSampleRepoint): Promise<void> {
    await this.ledger.update(faceId, {
      assignedSampleId: repoint.sampleId,
      ...(repoint.mediaId !== undefined ? { mediaId: repoint.mediaId } : {}),
    })
  }

  /**
   * The rows of one identity, newest first, bounded and REFUSING rather than
   * narrowing. Shared by the two callers above so they cannot disagree about
   * what "this identity's faces" means.
   */
  private async identityRows(
    identityId: string,
    columns: readonly string[],
  ): Promise<readonly { id: string; data: Record<string, unknown> }[]> {
    const rows = await this.ledger.query(
      {
        where: { recognizedIdentityId: identityId },
        orderBy: { field: 'timestamp', direction: 'desc' },
        limit: FACE_WINDOW_MAX_ROWS + 1,
      },
      columns,
    )
    if (rows.length > FACE_WINDOW_MAX_ROWS) throw new FaceWindowTooWideError(rows.length)
    return rows
  }
}
